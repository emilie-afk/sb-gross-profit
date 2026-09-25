# C8 live acceptance: Windows host, Shopify, ShipStation, staging D1

These checks need the real office PC, the real Shopify Admin and ShipStation
accounts, the export mailbox and the real staging Worker. None of them can run
in the repository's test suites. **Status of every line: NOT RUN.** Mark a
line PASS only after it has run for real, and record **aggregate evidence
only**. Never paste a row, an order number, a customer field, an email header
or body, a download link, a path, a cookie, a token or a secret.

Evidence tools:

- `cd automation\collector && npm run summary -- --since <ISO time>` prints
  allowlisted manifest fields: status, exit code, times, counts, hashes, host
  names, upload status.
- `node tools/staging-acceptance.mjs` prints checks S1–S9 against the staging
  Worker.
- `GET /v1/admin/cycles/<week>` (staging admin) returns cycle status and events,
  as codes only.

Point every collector config at the **staging** Worker (`workerUrl`). All five
controls stay false throughout.

## W. Windows host (collector orchestration)

| # | Check | How | Pass when | Result |
| --- | --- | --- | --- | --- |
| W1 | One combined task | `Get-ScheduledTask -TaskName "SB weekly collector"` | exactly one task; action `npm run collect` in `automation\collector` | NOT RUN |
| W2 | Weekly Monday 15:05 ICT trigger | `(Get-ScheduledTask "SB weekly collector").Triggers` | weekly, Monday, 15:05 local on a UTC+07:00 PC (08:05 UTC otherwise) | NOT RUN |
| W3 | At-logon recovery with StartWhenAvailable | same, plus `.Settings.StartWhenAvailable` | an AtLogOn trigger exists; `StartWhenAvailable = True`; `MultipleInstances = IgnoreNew` | NOT RUN |
| W4 | Old per-collector tasks removed or disabled | `Get-ScheduledTask "SB ShipStation export","SB Shopify export"` | not found, or `State = Disabled`; the daily quarantine purges remain | NOT RUN |
| W5 | Lock and stale-lock recovery | start `npm run collect` twice at once; then leave a `collector.lock` older than 3 h and start again | second start exits 5 without running a browser; the stale lock is replaced and the run proceeds | NOT RUN |
| W6 | Separate profiles | inspect `%LOCALAPPDATA%\sb-shipstation-export\profile` and `…\sb-shopify-export\profile` | two different folders, outside the repository and any synced folder; never two browsers open at once (Task Manager) | NOT RUN |
| W7 | Credential Manager access | `Get-StoredCredential -Target sb-gp-ingest` (and the other four targets) as the task user | all present; the task, run as that user, reads them (no prompt) | NOT RUN |
| W8 | Restart during collection | reboot while the ShipStation browser is open | at logon the task starts again; the week plan shows what is still missing; nothing is uploaded twice (`source_no_change` at most) | NOT RUN |
| W9 | Missed schedule while powered off | PC off across Monday 15:05; power on Monday evening | the task runs at logon/startup; the Worker cycle, waiting since 15:30, computes on the next tick after the uploads | NOT RUN |
| W10 | Rerun after partial success collects only the missing source | make Shopify fail (for example, sign out), then fix it and rerun | the rerun skips ShipStation (`collected.shipping_cost_report = ok`) and runs Shopify only | NOT RUN |

## SH. Shopify (no API; Admin export and read-only Gmail)

| # | Check | Pass when | Result |
| --- | --- | --- | --- |
| SH1 | Real Admin selectors recorded (`npm run codegen`) | every `REPLACE:` selector in `config.local.json` is replaced; `export --headed` reaches `requestExport` | NOT RUN |
| SH2 | Staff-account permissions | the dedicated staff account can view and export orders and nothing more needed; 2FA done once with `npm run login` | NOT RUN |
| SH3 | Export request | manifest `status` goes past `export_steps_failed`; `requestedAt` is recorded | NOT RUN |
| SH4 | Actual email sender and subject | the email is found by the fixed search `from:shopify.com subject:export`, and its subject contains "export" and "order". **If the real sender or subject does not match, stop and report it as a contract change for approval. Do not widen the search.** | NOT RUN |
| SH5 | Actual download-link host | manifest `downloadHost` (and `downloadFinalHost`) is on the Shopify-owned list. Any other host is refused (`unknown_export_link`); report it for approval. Do not add hosts to make the test pass. | NOT RUN |
| SH6 | Gmail read-only authorization | `npm run gmail-authorize` stores a token whose only scope is `gmail.readonly`; the manifest has `mailboxVerified = true`. **Do not broaden the OAuth scope.** | NOT RUN |
| SH7 | Exactly-one-email behavior | one matching email → `found`; two exports requested close together → `export_email_ambiguous` (exit 30), no guess | NOT RUN |
| SH8 | Direct-download behavior | a small export that downloads directly gives `downloadVia = direct_download`, and the raw file is not left in `downloads\` | NOT RUN |
| SH9 | Rolling 56-day window | `windowFrom` = reporting Sunday − 55 days, `windowTo` = reporting Sunday; no `export_window_mismatch` | NOT RUN |
| SH10 | Sanitized upload; duplicate returns `source_no_change` | first upload `source_received`; `npm run export` again for the same week → `source_no_change` | NOT RUN |
| SH11 | No customer fields reach the Worker | staging `GET /v1/admin/readiness` is fine, and a staging D1 query shows the `shopify_order` columns carry no name, email, address, phone or note (schema has none; the Worker refuses such columns) | NOT RUN |

## SS. ShipStation Shipping Cost Report

| # | Check | Pass when | Result |
| --- | --- | --- | --- |
| SS1 | Analytics → Shipping Cost Report navigation recorded | the export steps reach the download without an unknown page | NOT RUN |
| SS2 | Date range | `requestedFrom`/`requestedTo` in the manifest equal the planned window | NOT RUN |
| SS3 | Approved 15-column schema | upload accepted, with no `customer_data_rejected` or `report_invalid` | NOT RUN |
| SS4 | Shipping Cost kept; Recipient, Shipping Paid and +/- removed locally | `droppedColumns = 3` in the summary; the Worker never sees them | NOT RUN |
| SS5 | Multi-row orders retained | staging `GET /v1/admin/shipping-cost/effective` shows `ordersWithMultipleRows > 0` when the week has any | NOT RUN |
| SS6 | Duplicate upload is idempotent | the second upload of the same file gives `source_no_change` with the same `versionId` | NOT RUN |
| SS7 | Pending-review handling | the first version waits (`pending_review`); the cycle shows `shipping_cost_report:pending_review` and no snapshot exists until an administrator accepts it (C8 basis) | NOT RUN |
| SS8 | Mapping export stays dormant and financially inert | no mapping-export kind runs by default (`assertKindEnabled`); if enabled for a test, the week's totals are unchanged | NOT RUN |

The shipping source stays **unverified** (`shipping_cost_report_source_verified = false`).

## C. D1 capacity on the real staging Worker (~3,000-order rolling upload)

Run the real weekly cycle (or `npm run export`) against staging. Read timings
from the Cloudflare dashboard (Workers → sb-gp-worker-staging → Logs/Metrics)
and D1 metrics (rows read/written).

| # | Check | Pass when | Result |
| --- | --- | --- | --- |
| C1 | Upload duration | the rolling upload returns 200 well within the request limit; record ms | NOT RUN |
| C2 | Compute duration | each weekly compute finishes; record CPU ms (paid plan limit 30 s CPU) | NOT RUN |
| C3 | D1 rows written / read per upload and per compute | recorded from D1 metrics; within the plan's daily limits | NOT RUN |
| C4 | Retry behavior | an upload interrupted mid-way (network off) is retried by the collector; the Worker records one ingest (duplicate → `source_no_change`) | NOT RUN |
| C5 | Memory / timeout | no `Exceeded Memory Limit` / CPU-limit errors in Worker logs | NOT RUN |
| C6 | Duplicate-upload timing | recorded ms for `source_no_change` | NOT RUN |
| C7 | Touched-week revisions | a changed rolling export drafts revisions for the touched earlier weeks, one per tick, none published | NOT RUN |
| C9 | Automatic weekly catalog refresh | with a test cron on staging: the first attempt creates one `worker`/`cron` refresh, fetches the five public tabs once, fulfils it and the draft pins it; no admin call | NOT RUN |
| C8 | Clean-up | real staging data removed afterwards (`wrangler d1 execute sb-gp-staging --remote --env staging` deleting source and snapshot rows, or drop and recreate the staging D1 and re-apply 0001–0011) | NOT RUN |

Local rehearsal, as a reference only (not a substitute): run
`cd worker && npm run staging-local`. It uses local workerd and a local D1,
with synthetic data.
