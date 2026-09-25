# Make scenarios — weekly SB GP automation (Revision 8)

> **Superseded in part (C5, 2026-09-25).** There is no Shopify API and no Drive
> watch: S1 (GraphQL) and S2 (Drive → `/v1/ingest/shipstation`) are retired.
> The Windows collectors upload directly: `automation/shopify-export` (rolling
> orders export, `mode: "rolling"`) and `automation/shipstation-export`
> (Shipping Cost Report). Readiness keys are now `shopify`, `shopify_updates`,
> `shipping_cost_report`, `catalog_refresh` and `reporting_period`; the mapping
> export (`shipstation_mapping`) never satisfies shipping readiness. Weekly
> orchestration moves to the Worker (C7).

Nothing here publishes. Publication is a separate, deliberate admin action and
stays locked (`publication_enabled = false`, `PUBLICATION_ALLOWED = "false"`,
and the Carrier Fee priority lock) until the go-live gate passes.

`actorLabel` values below (`make:S0`, `make:S4`) are optional, caller-supplied
tags for context. The audit trail's verified field is `actor_class`, which the
Worker assigns from the credential used (`admin_secret` / `ingest_secret`); a
shared secret cannot distinguish Make from a person.

## Two time zones, kept apart

| Concept | Zone | Where it is set |
| --- | --- | --- |
| **Reporting week**: Monday 00:00 through the next Monday 00:00 (exclusive), shown as Monday–Sunday | Store zone `America/Los_Angeles`, **confirmed** from Shopify store settings ("Pacific Time (US)"). DST comes from the IANA zone; never a fixed UTC−7/−8 offset. | D1 settings `store_timezone`, `store_timezone_confirmed` (set by migration 0006, audited) |
| **Automation run**: Monday 15:30, covering the previous Monday–Sunday | `Asia/Ho_Chi_Minh` (UTC+7, no daylight saving) | D1 settings `schedule_timezone`, `schedule_weekday`, `schedule_time` |

Monday 15:30 in Ho Chi Minh is **08:30 UTC**. In the store zone that is Monday 01:30 PDT in summer and 00:30 PST in winter, so the reporting week has already closed. The week's exact UTC window changes with daylight saving: 167 hours in the week clocks spring forward and 169 hours in the week they fall back. Make does no time-zone arithmetic. It asks the Worker (`GET /v1/ingest/week-plan` or `/v1/admin/week-plan`) for the week, its UTC window and the Shopify search strings.

**Make's own clock.** The Succulents Box Make organization and user are set to `Asia/Bangkok`, which is UTC+7 with no daylight saving, the same as Ho Chi Minh. Every "Monday 15:30" below is therefore entered in Make as is. If the Make zone is ever changed, convert these times to the new zone.

**Limits (Make Core plan).** One execution can run for at most 40 minutes. The Worker computes one week per call on D1's free plan. No scenario below waits longer than that inside one execution; long waits are repeated scheduled checks.

## Connections and secrets

| Item | Where it lives | Used by |
| --- | --- | --- |
| Shopify | Make Shopify connection (`read_orders`, `read_all_orders`) | S1 |
| Google Drive | Google connection, read-only to the two export folders | S2, S3 |
| Worker ingest secret | Data store `sb-gp-secrets`, key `ingest_secret` | S1, S2, S3 |
| Worker admin secret | Data store `sb-gp-secrets`, key `admin_secret` | S0, S4 |
| Netlify build hook URL | Data store `sb-gp-secrets`, key `netlify_build_hook` | S0 |
| Worker URL | Data store `sb-gp-secrets`, key `worker_url` | all |

## Schedule and dependency order

```
Mon 15:05 ICT   Windows PC   ShipStation export job → Google Drive (08:05 UTC, after the week closes in both seasons)
Mon 15:05+      S2           Drive watch → /v1/ingest/shipstation              (file-triggered)
Mon 15:30 ICT   S0           1. week plan  2. catalog refresh + verify  3. Shopify week  4. Shopify updated orders
                             5. HPD log (if present)                               (one execution, < 40 min)
Mon 15:30–18:30 S4 (every 15 min)  readiness → compute draft → gates → revise touched weeks → notify
                                   (does nothing until every required source is ready; runs once per week)
```

This maps the ten required steps to scenarios:

| # | Step | Where |
| --- | --- | --- |
| 1 | Refresh and verify the cost catalog | S0 steps 2–4 (Netlify build → `build.py` pushes with the refresh id → S0 polls until `fulfilled` or `rejected`) |
| 2 | Ingest Shopify orders and recently updated historical orders | S0 → S1 (`mode: "week"`, then `mode: "updated_since"`) |
| 3 | Obtain and ingest the ShipStation export | Windows job → S2 |
| 4 | Ingest HPD actuals if available | S0 → S3 |
| 5 | Confirm every ingest run succeeded | S4 → `GET /v1/admin/readiness` (the Worker repeats this check itself) |
| 6 | Compute the weekly draft | S4 → `POST /v1/admin/runs` with `trigger: "schedule"` |
| 7 | Reconciliation and publication gates | Inside the Worker's compute; the result comes back as `gate` |
| 8 | Update the draft and history data | The Worker stores the draft snapshot and an admin-only draft comparison. `/v1/history` stays published-only. The dashboard reads through `/api/v1` once integrated. |
| 9 | Notify the administrator | S4 |
| 10 | Publish | Never automatic. Only a separate `POST /v1/admin/publish`, refused while any lock is off. |

The Worker enforces the order independently of Make:

- A `trigger: "schedule"` compute is refused with `too_early` before Monday 15:30 ICT.
- It is refused with `sources_not_ready` until these have all succeeded after the week closed:
  - the Shopify week pull;
  - the Shopify updated-orders pull;
  - the ShipStation pull;
  - the catalog refresh, which must have finished, either accepted or rejected.
- It is owned per week in the database. The first request atomically claims `schedule_cycle(week_start)` and creates the run in the same D1 batch; a simultaneous or later request gets that run back with `existing: true` (plus `inProgress: true` while it is still computing).
- A cycle whose run failed, or was interrupted (stuck in `created`/`computing`/`draft` for more than 15 minutes), is resumed **in place** by the next S4 tick (`resumed: true`, `cycle.attempts` + 1). A second scheduled run is never created.
- The scheduled snapshot and the run's final state commit together in one claim-guarded transaction; a request that lost the claim writes nothing (`409 ownership_lost`, safe to ignore — the new owner finishes the week).

## S0 — Weekly orchestrator (Mondays 15:30)

| # | Module | Configuration |
| --- | --- | --- |
| 1 | Schedule | Days of the week: Monday, 15:30 |
| 2 | HTTP › Make a request | `GET <worker>/v1/admin/week-plan`, header `X-Admin-Secret`. Keep `weekStart`, `shopify.weekQuery`, `shopify.updatedQuery`. |
| 3 | HTTP › Make a request | `POST <worker>/v1/admin/catalog-refresh` `{ "weekStart": "<weekStart>", "actorLabel": "make:S0" }` → `refreshId`, `hookBody` |
| 4 | HTTP › Make a request | `POST <netlify_build_hook>` with JSON body `hookBody` (`{ "refreshId": …, "weekStart": … }`). Netlify passes it to `build.py` as `INCOMING_HOOK_BODY`. |
| 5 | Repeater (max 20) + Sleep 60 s + HTTP | `GET <worker>/v1/admin/catalog-refresh/<refreshId>`; stop when `status` is `fulfilled`, `rejected` or `expired` |
| 6 | Router | `fulfilled` → continue. `rejected`/`expired`/still `pending` → notify "catalog not verified: <status>" and **continue**. The week will compute but block as `catalog_stale` unless an admin accepts reuse. |
| 7 | Scenarios › Run a scenario (wait) | S1 with `{ weekStart, query: weekQuery, mode: "week" }` |
| 8 | Scenarios › Run a scenario (wait) | S1 with `{ weekStart, query: updatedQuery, mode: "updated_since" }` |
| 9 | Scenarios › Run a scenario (wait) | S3 with `{ weekStart }` (HPD; optional) |

## S1 — Shopify orders (sub-scenario)

| # | Module | Configuration |
| --- | --- | --- |
| 1 | Scenario inputs | `weekStart`, `query`, `mode` |
| 2 | Repeater / pagination loop | until `pageInfo.hasNextPage` is false |
| 3 | Shopify › Execute a GraphQL query | query = `SHOPIFY_ORDERS_QUERY` from `shared/adapters/shopifyGraphql.js`, verbatim; variables `{ "q": "<query>", "cursor": <endCursor> }` |
| 4 | Array aggregator | collect `data.orders.nodes` per page |
| 5 | HTTP › Make a request | `POST <worker>/v1/ingest/shopify`, header `X-Ingest-Secret`, body `{ "format": "graphql", "mode": "<mode>", "weekStart": "<weekStart>", "nodes": [...] }` |
| 6 | Router on status | 2xx → return `runId`, `weeksTouched`. 400 `customer_data_rejected` → stop and notify (the query drifted). Other → retry. |

The search strings carry explicit UTC instants, for example `created_at:>='2026-10-26T07:00:00Z' AND created_at:<'2026-11-02T08:00:00Z'`, so Shopify never has to interpret a bare date. The updated-orders query, `updated_at:>=<week start> AND created_at:<<week start>`, is open-ended at the top. Consecutive weeks therefore overlap and never leave a gap. Unchanged orders count as duplicates.

Do not add fields to the query in Make. It selects no customer, address, email, phone or order-note field, and the Worker rejects any payload that carries one.

## S2 — ShipStation shipments (Drive watch)

| # | Module | Configuration |
| --- | --- | --- |
| 1 | Google Drive › Watch files in a folder | folder `SB/ShipStation exports`, file name `shipstation_*.csv` |
| 2 | Google Drive › Download a file | `weekStart` = the date in the file name (`shipstation_<weekStart>_<runId>.csv`) |
| 3 | CSV › Parse CSV | headers in first row; RFC 4180 quoting |
| 4 | Array aggregator | group rows so **one shipment is never split across requests** (aggregate all rows, then chunk by `Shipment ID` in batches of about 3,000 rows) |
| 5 | HTTP › Make a request | `POST <worker>/v1/ingest/shipstation`, header `X-Ingest-Secret`, body `{ "format": "rows", "sourceFormat": "custom", "weekStart": "<weekStart>", "rows": [...] }` |
| 6 | Notify | post `diagnostics.shipmentsWithoutPositiveCost`, `rowDisagreements`, `ignoredColumns` |

The Windows job runs at 15:05 ICT. If it stops, for example with exit 20 because 2FA is needed, no file arrives. S4 keeps reporting `shipstation:missing` and nothing is computed. Nothing is estimated.

The export template must not contain recipient, address, phone, email or `Created By` columns. If a customer column appears anyway, the Windows job refuses the file. If `Created By` appears, the Worker keeps only a class (`blank`, `integration` or `person`) and never the value.

## S3 — HPD shipping log (sub-scenario)

| # | Module | Configuration |
| --- | --- | --- |
| 1 | Google Drive › Search files | the folder `build.py` already reads via `HP_COSTS_FOLDER_ID`, newest file |
| 2 | Google Drive › Download a file | |
| 3 | HTTP › Make a request | `POST <worker>/v1/ingest/hpd`, header `X-Ingest-Secret`, body `{ "format": "csv_text", "weekStart": "<weekStart>", "text": "<file contents>" }` |

The Worker reads the Shopify order number from "Notes - From Buyer". It discards the notes text and the ship-to state; neither is stored. Without the log, HPD orders use an **assumed** pass-through: Shopify shipping collected is taken as the HPD shipping cost. These orders are labelled `hpd_pass_through_assumed`, the week's status is `provisional_hpd_pass_through` or lower, and the narrative says the figures are provisional. It is never shown as "complete". Whether pass-through may ever count as complete is an open business decision.

## S4 — Readiness, compute, touched weeks, notify (Mondays 15:30–18:30, every 15 min)

| # | Module | Configuration |
| --- | --- | --- |
| 1 | Schedule | At regular intervals, 15 min; advanced scheduling: Monday, 15:30–18:30 only |
| 2 | HTTP › Make a request | `GET <worker>/v1/admin/week-plan` → `weekStart` |
| 3 | HTTP › Make a request | `GET <worker>/v1/admin/readiness?weekStart=<weekStart>` |
| 4 | Router | `ready = false` and before 18:15 → stop quietly (next tick retries). `ready = false` at the last tick → notify "not computed: <missing>". `ready = true` → continue. |
| 5 | HTTP › Make a request | `POST <worker>/v1/admin/runs` `{ "weekStart": "<weekStart>", "trigger": "schedule", "actorLabel": "make:S4" }`. If `existing: true`, this week is owned by an earlier request: with `inProgress: true` stop quietly (next tick checks again); otherwise it is done, so stop without notifying again. `resumed: true` means this tick recovered a failed or interrupted cycle; notify as normal. |
| 6 | Repeater (until `remaining` is empty, max 8) + HTTP | `POST <worker>/v1/admin/revise-touched` `{ "weekStart": "<weekStart>", "actorLabel": "make:S4" }` → draft revisions of **earlier** weeks whose orders, shipments or HPD actuals changed this cycle (never published) |
| 7 | Notify | Send the following:<ul><li>`headline` and `profitabilityStatus`;</li><li>`gate.failures` and `gate.warnings`;</li><li>`gate.catalog`: selected revision, capture time, basis, and freshness (`current`, `intentionally_reused`, `restated`, `reused_accepted` or `stale`);</li><li>for every revised earlier week, its week, revision, status and reason.</li></ul> |

S4 has no publish step. Before go-live, a person reviews the draft with `GET /v1/snapshot/<week>?includeDrafts=1` (admin secret). That view includes the admin-only `draftComparisonPreview`.

### When the catalog is stale

`catalog_stale` blocks the gate. An administrator can take one of two paths:

- **Fix and restate.** Fix the build, then create an audited cost restatement: `POST /v1/admin/restate-costs { weekStart, reason }`.
- **Accept the old catalog.** Accept reuse for this run with a reason: `POST /v1/admin/runs/<runId>/compute { "acceptCatalogReuse": { "reason": "…" } }`. The run keeps its recorded catalog, and the acceptance is stored and shown on the gate.

## S5 — (merged into S0)

The catalog refresh is S0 steps 2–6: trigger the build, then wait for and verify the import. It is no longer a separate fire-and-forget scenario.

## Backfill (one-off, not a scenario)

Run `tools/backfill.mjs` on a workstation in three steps:

1. Run `validate` against the manual calculator.
2. Run `push`.
3. Call `POST /v1/admin/backfill` with `dryRun: false` until `remaining` is empty.

No catalog refresh is recorded for historical weeks. Backfilled weeks therefore compute as `catalog_stale` unless the call carries `acceptCatalogReuse: { reason }`. That acceptance is recorded per run. Exports must cover whole Monday–Sunday weeks; overlapping exports are safe.
