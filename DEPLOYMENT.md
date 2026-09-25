# Deployment notes

## Netlify environment variables

### Added by this change

| Variable | Purpose | Value |
| --- | --- | --- |
| `LIVELY_GOOD_SHEET_URL` | Lively Good cost tab | `https://docs.google.com/spreadsheets/d/1jpwqcSxBVrv2gZQBelMy6E7SxXkQtp1ekWSuaiRtECY/export?format=csv&gid=1033375869` |
| `CALATHEA_COLLECTIVE_SHEET_URL` | Calathea Collective cost tab | `https://docs.google.com/spreadsheets/d/1jpwqcSxBVrv2gZQBelMy6E7SxXkQtp1ekWSuaiRtECY/export?format=csv&gid=1052830815` |
| `SURFSIDE_ARRANGEMENT_SHEET_URL` | Surfside Arrangement cost tab | `https://docs.google.com/spreadsheets/d/1jpwqcSxBVrv2gZQBelMy6E7SxXkQtp1ekWSuaiRtECY/export?format=csv&gid=1014182066` |
| `LINDAMAKES_SHEET_URL` | LindaMakes cost tab (added 2026-09-23) | `https://docs.google.com/spreadsheets/d/1jpwqcSxBVrv2gZQBelMy6E7SxXkQtp1ekWSuaiRtECY/export?format=csv&gid=671512915` |
| `VENDOR_IMPORT_STRICT` | *Optional.* Set to `1` to fail the build when a configured vendor tab imports zero costs. Default behaviour is a prominent build warning. | `1` or unset |

### Reused unchanged

`L2G_SHEET_URL` keeps its existing value:

```
https://docs.google.com/spreadsheets/d/1jpwqcSxBVrv2gZQBelMy6E7SxXkQtp1ekWSuaiRtECY/export?format=csv&gid=1872945984
```

The Live to Give tab still uses the headers the old parser expected
(`SKUs`, `Dropship Price (60% of retail price)`), so it was folded into the shared
vendor importer rather than duplicated. There is still exactly one Live to Give
cost source.

All other variables (`SITE_PASSWORD`, `MCG_SHEET_URL`, `MCG_POTS_SHEET_URL`,
`AS_SHEET_URL`, `HP_SHEET_URL`, `HP_COSTS_FOLDER_ID`, `GDRIVE_API_KEY`,
`SB_SKU_ALIAS_URL*`, `MCG_EXTRA_SHEET_URL`, the `*_JSON*` fallbacks) are unchanged.
No credentials are hard-coded anywhere in the repository.

## Vendor tab structure (verified 2026-09-22)

| Vendor | SKU column | Cost column | Product name | Active flag | Notes |
| --- | --- | --- | --- | --- | --- |
| Live to Give | `SKUs` | `Dropship Price (60% of retail price)` | `Shopify Name` (merged, carried down) | — | 30 rows |
| Lively Good | `SKU` (col E, left block) | `Cost per item` (col G) | `Title` | `Listing Shopify` = TRUE (col Q, label sits in the group-header row above the column headers) | The tab has a second, right-hand Succulents Box block with repeated headers; the importer takes the first (vendor) occurrence of each column. Unchecked rows are fulfilled through other vendors and are skipped. |
| Calathea Collective | `SKU` | `Cost (what Calathea Collective receives)` | `Product` (merged, carried down; two-line cells — the Shopify name is the last line) | — | Row 2 is a units/notes row and is skipped because its SKU is blank. |
| Surfside Arrangement | `SB SKU` | `Cost (what Surfside Succulents receives)` | `Product` | — | The trailing shipping-note column is **not** imported — these are product costs only. |
| LindaMakes | `SKU` | `Cost (what LindaMakes receives)` | `Product` (merged, carried down across colourway rows) | — | Column A carries a product category and column B a row number; neither is imported. Row 2 is a "*45% off the website price" note with a blank SKU and is skipped. The header spells the vendor "LindaMakess", so the cost column is matched on prefix. Weight is not a cost component. |

Duplicate handling is deterministic: identical costs on a repeated SKU are
accepted and counted; **conflicting** costs on the same SKU are a validation
error and that SKU is withheld rather than guessed at. Neither tab signals that
later rows are newer, so "last row wins" is deliberately not used.

## Import counts from the first live run (2026-09-22)

| Vendor | Rows fetched | Accepted | Unique SKUs | Duplicates | Blank SKUs | Invalid costs | Zero/negative | Skipped (not listed) | **Imported** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Live to Give | 30 | 30 | 30 | 0 | 0 | 0 | 0 | — | **30** |
| Lively Good | 312 | 171 | 171 | 0 | 0 | 0 | 0 | 125 | **171** |
| Calathea Collective | 476 | 475 | 462 | 13 | 1 | 0 | 0 | — | **462** |
| Surfside Arrangement | 11 | 11 | 11 | 0 | 0 | 0 | 0 | — | **11** |
| LindaMakes | 397 | 396 | 396 | 0 | 1 | 0 | 0 | — | **396** |

Total: **1,070 vendor-scoped SKUs**. Every build writes the same table to the
Netlify build log and to `data/vendor_import_report.json`.

## Build outputs

`python build.py` writes into `data/`:

- `mcg_total.json`, `product_costs.json`, `sku_weights.json`, `sku_alias.json`,
  `sb_costs.json`, `hp_supplement.json`, `hp_by_name.json` — unchanged
- `vendor_costs.json` — **new**, vendor → SKU → `{unitCost, sku, productName, source, matchType}`
- `vendor_index.json` — **new**, per-vendor secondary lookup indexes
- `vendor_import_report.json` — **new**, validation counts and warnings

## Tests

```
npm test                      # engine, adapters, contract, Worker (D1 shim)
npm run test:automation       # ShipStation page detection (needs Playwright + Chromium)
node worker/test/workerd-integration.mjs   # opt-in: real workerd via Miniflare
node worker/test/workerd-adversarial.mjs   # opt-in: ownership races on real D1 (test-only hooks)
python build.py               # with the four vendor URLs set
node tools/historical_totals.mjs july_orders.csv july_shipstation.csv
```

`tests/smoke.html` is a standalone page that mounts the Scenario Calculator
against synthetic orders; serve the repo and open `/tests/smoke.html` to inspect
the view without uploading real data.

## ShipStation: which column is the expense

The export carries **both** `Rate` and `Shipping Paid`, and they mean different
things:

| Column | Meaning | Jul 1–31 total (463 unique shipments) |
| --- | --- | ---: |
| `Rate` | what the label cost us — **the expense** | $1,690.38 |
| `Shipping Paid` | what the customer paid us — revenue | $2,980.60 |

`Shipping Paid` equals Shopify's order-level `Shipping` on **460 of 461** joined
orders; `Rate` matches on 5. Booking `Shipping Paid` as the shipping expense
would turn shipping revenue into a cost and roughly double the shipping expense
line. The parser therefore uses `Rate` whenever the column exists and falls back
to `Shipping Paid` only for exports that omit `Rate`.

**Open data-quality item:** 178 of 463 July shipments have `Rate` = $0.00. Those
are gaps in the export, not free labels. `parseShipStation` returns
`zeroCostShipments` so the count is visible, and the regression tool prints it.
Until those rates are populated, July shipping expense is understated.

## Regression results — Jul 1–31 2026

Run with `tools/historical_totals.mjs` on `afb9486` (before) and on this commit
(after), using identical `data/` files.

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Orders | 1,959 | 1,956 | −3 |
| Line items | 3,788 | 3,785 | −3 |
| Revenue excl. taxes | $67,204.24 | $66,796.39 | −$407.85 |
| Product COGS | $27,596.70 | $27,750.10 | +$153.40 |
| Shipping collected | $15,463.12 | $15,434.14 | −$28.98 |
| Shipping expense | $8,085.28 | $8,963.89 | +$878.61 |
| **Gross profit** | **$31,522.26** | **$30,082.40** | **−$1,439.86** |
| Lines with no cost | 1,254 | 1,248 | −6 |

Every difference is accounted for:

| Cause | GP effect |
| --- | ---: |
| House Plant Dropship shipping moved off the weight-tier estimate onto pass-through (pure HPD $5,039.90 → $5,333.54; mixed 17381+HPD $1,311.40 → $1,917.43; mixed HPD+free ship $49.67 → $43.60) | −$893.60 |
| Newly matched vendor costs — Surfside `SUR-HEART-LARGE` (3 units, $180.00) and `SUR-WHITEPOT-ROSETTE+DONKEY` (2 units, $38.00) | −$218.00 |
| 3 cancelled orders excluded (#472437, #472436, #471182) and 10 order-level refunds totalling $222.91 prorated across lines | −$328.26 |

ShipStation deduplication produced **no** change: shipping expense for every
non-HPD order category is identical before and after, so no shipment cost was
being double-counted in the old code. 461 orders carried 463 shipments (2 orders
with a second shipment).

Vendor coverage in July: Live to Give 9 lines / $464.02 (9/9 matched), Lively
Good 2 lines / $196.56 (2/2), Surfside Arrangement 5 lines / $501.00 (5/5),
Calathea Collective 0 lines — no July sales, so the 462 imported Calathea SKUs
do not affect these totals.

> **Caveat on absolute figures.** This run had only the four vendor sheet URLs
> configured. `MCG_SHEET_URL`, `MCG_POTS_SHEET_URL`, `AS_SHEET_URL`,
> `HP_SHEET_URL`, `HP_COSTS_FOLDER_ID`, `SB_SKU_ALIAS_URL*` and
> `MCG_EXTRA_SHEET_URL` were unset, so 1,248 lines (mostly House Plant Dropship
> and Succulents Box 17381) have no cost and COGS is understated on **both**
> sides. The *changes* above are exact because both runs used identical data
> files; the absolute totals are not production numbers. Re-run on Netlify with
> the full environment to get those.

## Two data bugs found in the Jul–Sep 2026 exports

### 1. A species SKU read as a 1,125-plant pack

`S2Kx1125` is one $7.20 Crassula. The multi-pack suffix rule matched `x1125`,
split the SKU into base `S2K` × 1125, priced it at the 2" tier ($4 × 1125 =
$4,500), then applied the top volume discount ($0.65 × 1125) for a unit cost of
**$3,768.75** — and its 1,125 phantom plant units pushed every other MCG line in
the same order into the top discount tier.

That single SKU is why the Seedville USA row showed −$3,731.71 of gross profit on
$51.29 of revenue.

`parsePackSuffix()` now requires the count to be 2–24 **and** the base to be a
real MCG SKU (8+ characters ending in a digit). Every genuine pack SKU in these
exports is `<8-char base>x2`, `x4` or `x8`; `S2Kx1125` was the only false match.

Aug 1 – Sep 21 impact: 5 lines, **$18,843.75 → $17.70** of COGS.
Seedville USA goes from −$3,734.96 to +$29.79 of gross profit.

### 2. `parseCSV` corrupted every record containing a newline

It split on newlines before handling quotes, so any record with an embedded
newline in a quoted field was broken into fragments. Shopify's `Notes` and
`Note Attributes` columns routinely contain them — 995 of 3,788 July line
records (26%). Those two columns sit at positions 45–46, so on every affected
record **Cancelled at, Refunded Amount, Vendor, Tags, Source and Lineitem
discount were lost or shifted**, and each stray fragment became a phantom row
(5,340 rows parsed from 3,794 real records; 7,349 from 5,226 in Aug–Sep).

`parseCSV` now uses the RFC 4180 parser that was already in the file for the HPD
log.

### Combined effect, Aug 1 – Sep 21

| Metric | Before | After |
| --- | ---: | ---: |
| Rows parsed | 7,349 | 5,226 |
| Line items | 5,210 | 5,186 |
| Revenue excl. taxes | $96,097.04 | $95,089.24 |
| Product COGS | $37,028.26 | $18,750.15 |
| **Gross profit** | **$43,393.11 (45.2%)** | **$56,455.41 (59.4%)** |

## Prepaid subscription deliveries are separated, not amortised

A subscription is charged in full on the order that starts it, so each later
delivery arrives as its own order with `Lineitem price` 0.00 and only a
fulfilment cost. Mixed into a sales channel those lines made the channel look
catastrophic — Aug–Sep channel `294517` read $44 revenue against −$3,445.

Revenue recognition is unchanged: it stays on the order that collected it.
Instead the delivery legs are flagged (`isSubRenewal`) and bucketed into their
own row in the Channel & Vendor breakdown, **Subscription renewals (prepaid)**,
with an inline caption and a footnote pointing at the Subscriptions and
Sub P&L tabs, which pair each delivery's cost with the monthly price actually
charged.

Aug–Sep effect: channel `294517` returns to its real trade ($44.00 revenue,
+$20.00 GP) and 529 delivery legs sit in the labelled row at $0.00 revenue and
−$3,480.00 — cost-only by design. No total changes: revenue $95,089.24,
COGS $18,750.15, gross profit $56,455.41 (59.4%) before and after.

## Regression procedure for the July files

1. `git stash` (or check out the previous commit) and run
   `node tools/historical_totals.mjs july_orders.csv july_shipstation.csv --json > before.json`
2. Return to this branch and run the same command into `after.json`
3. `diff before.json after.json`

Only these differences are expected:

- a previously missing vendor cost becoming matched (Lively Good / Calathea /
  Surfside / Live to Give SKUs move from `COST MISSING` to a vendor sheet source)
- cancelled orders dropping out, and order-level refunds reducing revenue
- ShipStation shipment costs that were previously double-counted being corrected
- House Plant Dropship shipping moving off the weight-tier estimate onto the
  pass-through rule (or the HPD log actual, where a log is uploaded)

Anything else must be investigated before the change is accepted.

## UX redesign (design_handoff_gp_dashboard)

The single-scroll page plus standalone Projection page became a 240px sidebar
and six deep-linkable screens: Overview, Channels & vendors, Shipping, Order
detail, Reports, Scenarios. **No calculation, data source, parser, export or
auth changed** — `js/calculator.js`, `js/scenario.js`, `js/vendorCosts.js`,
`js/scenarioUI.js`, `build.py` and `vendor_sheets.py` are byte-identical, and the
42 tests pass unchanged.

New files: `css/app.css` (design tokens and components, both themes) and
`js/shell.js` (routing, theme, and the Overview / Shipping / Reports renderers).
Everything else is `index.html`.

What moved, and why:

- **Needs attention** leads Overview. Three alerts are *computed* — missing-cost
  line count, any channel with negative GP, any shipping profile with negative
  net — and the panel hides entirely when none fire.
- **KPIs 6 → 4**, gross profit first. Shipping collected/paid/net collapse into
  one card with the net as the headline; missing cost stopped being a KPI and
  became the first alert (and the sidebar badge).
- **GP by store** is horizontal bars — no more 45°-rotated labels. Top 6 of N.
- **Revenue by channel** is a conic-gradient donut with a capped legend: top 6
  plus a "N smaller channels" bucket, series colours fixed so a channel keeps
  its colour everywhere. Chart.js is no longer used for either.
- **Channel table 11 → 6 columns.** Vendor pairs and revenue/share stack into
  two-line cells; GP% gains a bar capped at 100% so a -7,829% channel stays
  legible instead of destroying the scale.
- **Shipping: 7 cards → 1 table** with a totals row, plus 4 KPIs and the carrier
  split.
- **The 11 view buttons split by what they do**: SKU/Order change the table's
  *shape* (segmented control); nine narrow the same data (chips); Sub P&L and the
  Scenario Calculator left the table to become their own destinations. A chip
  with a purpose-built table still shows that table, so no column was lost.
- **Scenarios**: list picker plus one pane. The Scenario Calculator joins the six
  Projection models as a seventh, "Discount & operating margin".
- **Reports** tiles deep-link: Sub P&L opens in place, the other three jump to
  Order detail with that quick filter applied.

Theme is `data-gp-theme` on the root, persisted to localStorage and seeded from
`prefers-color-scheme`. Screens are URL-backed (`#/shipping`), so they are
linkable and the back button works — the old Projection page could not be.

A legacy bridge at the end of `css/app.css` re-points the original fixed-dark
palette at the new tokens, so the specialised tables that kept their own markup
follow both themes rather than staying dark-on-light.


## LindaMakes (added 2026-09-23)

A fifth vendor tab, `gid=671512915`. 396 unique SKUs, every one prefixed `LM-`;
no duplicates, no invalid or non-positive costs, and one blank-SKU note row that
is skipped. Set `LINDAMAKES_SHEET_URL` in Netlify and redeploy — env var changes
alone do not rebuild.

Because vendor costs are resolved by **(vendor, SKU)**, LindaMakes needed adding
in three places, all now done:

- `vendor_sheets.py` — the tab spec and `LINDAMAKES_SHEET_URL`, so `build.py`
  writes it into `vendor_costs.json` and `vendor_index.json`.
- `js/vendorCosts.js` — the canonical name in `VENDOR_KEYS`, the Shopify Vendor
  aliases (`LindaMakes`, `Linda Makes`, and `LindaMakess` as the sheet spells
  it), and the `LM-` SKU prefix so a blank or renamed Vendor column still
  resolves.
- `tests/` — three cases: resolution by vendor column and by prefix, a
  cross-vendor guard proving an `LM-` SKU never takes another vendor's cost, and
  a scenario check that LindaMakes gets its own vendor-discount override, its own
  row in the vendor analysis and reverse max-cost table, and still reconciles.

Everything downstream follows from `VENDOR_KEYS`: the Scenario Calculator's
vendor-override picker, the per-vendor analysis, the reverse maximum-allowable-cost
table and the missing-cost coverage report all pick the vendor up with no further
change.

No LindaMakes SKU appears in the Aug 1 – Sep 21 export, so this adds costs ahead
of the first sale rather than changing any historical figure.

## Weekly automation Worker (Phase 1 — not published)

Make.com → Cloudflare Worker (`worker/`) → D1. The Worker ingests normalized
sources, computes weekly snapshots with the same `shared/` engine the dashboard
uses, and serves them to signed-in readers.

**Automated profitability stays unpublished.** Publishing needs three things,
each changed by a person with a stated reason:

- the Carrier Fee priority lock, `carrier_fee_priority_locked`;
- `publication_enabled` in D1;
- `PUBLICATION_ALLOWED = "true"` in `wrangler.toml`.

All three are off. The manual upload workflow remains the default and is
unchanged. Nothing here has been deployed.

### Deploy (when instructed)

```
cd worker && npm install
npx wrangler d1 create sb-gp                       # put the id in wrangler.toml
npx wrangler d1 migrations apply sb-gp --remote    # 0001–0006
npx wrangler secret put INGEST_SECRET              # Make ingest routes
npx wrangler secret put ADMIN_SECRET               # admin/compute routes (different value)
npx wrangler secret put SESSION_SIGNING_KEY        # session HMAC key (different value)
cd .. && node tools/hash-password.mjs | npx wrangler secret put DASHBOARD_PASSWORD_HASH --config worker/wrangler.toml
cd worker && npx wrangler deploy
```

Each secret is at least 32 random characters (`openssl rand -base64 48`). Store
copies in the password manager and in the Make data store `sb-gp-secrets`
(ingest and admin only). The dashboard password hash is not the password.

### Schedule and time zones

The two zones are D1 settings, and every change to them is audited with a reason:

| Setting | Value | Meaning |
| --- | --- | --- |
| `store_timezone` | `America/Los_Angeles` | reporting weeks run Monday 00:00 to the next Monday 00:00 (exclusive), shown as Monday–Sunday |
| `store_timezone_confirmed` | `true` | confirmed from Shopify store settings, "Pacific Time (US)"; set by migration 0006 with an audit row (`actor_class = migration`) |
| `schedule_timezone`, `schedule_weekday`, `schedule_time` | `Asia/Ho_Chi_Minh`, `1`, `15:30` | the Monday 3:30 PM run (08:30 UTC), stored explicitly rather than taken from Make's organization time zone |

Daylight saving always comes from the IANA zone, never a fixed UTC−7/−8 offset.

The confirmation is a **publication safeguard**:

- `store_timezone_unconfirmed` is a blocking gate failure.
- `canPublish` re-checks the current setting, and neither publication switch nor the Carrier Fee lock overrides it.
- Changing `store_timezone` clears the confirmation automatically, with an audited `automatic: …` reason, unless the same request also sets `store_timezone_confirmed: true`.
- A snapshot computed in one zone cannot be published after the zone changes (`store_timezone_changed`).
- Every stored order records the zone it was normalized under. A week that still holds orders normalized in another zone fails the gate (`orders_in_other_timezone`) until it is re-ingested, so recomputing alone cannot publish old buckets.
- Pre-normalized pushes (`format: "normalized"`, used by `tools/backfill.mjs`) must state `storeTimezone`, and it must equal the current store zone.

### Scheduled cycle ownership

`trigger: "schedule"` computes go through `schedule_cycle(week_start PRIMARY KEY)`:

- **Claim.** The first request inserts the cycle row and creates its reporting run in one D1 batch (`ON CONFLICT DO NOTHING`, then `INSERT … WHERE EXISTS claim`). A simultaneous request gets the same run back with `existing: true`.
- **Every run write is claim-guarded.** While a scheduled compute runs, each change it makes checks `claim_token` inside the same D1 transaction: recording the catalog, moving the run to `computing`, and marking it `failed`.
- **One final transaction.** The snapshot and all its child rows are written in one transaction with:
  - the run's `snapshot_id`, `catalog_rev` and `gate`;
  - its final state (`validated` or `blocked`);
  - both transition records (`computing → draft` and `draft → final`).

  That transaction runs only while this request holds the claim and the run is exactly as it left it (`computing`, same `updated_at`). There is no committed moment with a snapshot but no run state, or with `draft` but no final state. A request that has lost the claim writes nothing (`ownership_lost`).
- **Takeover.** A failed run, or one stuck in `created`, `computing` or `draft` for more than 15 minutes, is resumed in place. The takeover is a compare-and-swap on `claim_token` and on the run being exactly as observed (same state and `updated_at`). If the owner commits first, the takeover changes nothing. If the takeover claims first, the owner's final transaction aborts. A `created` run whose first attempt already recorded an error is resumed at once. `attempts` goes up by one; no second scheduled run is created.
- **Admin recompute of a scheduled run** (`POST /v1/admin/runs/<id>/compute`, for example to accept catalog reuse) takes the claim by the same compare-and-swap and then computes as the owner. While another request is still computing the run, and it is not yet stale, the recompute is refused with `scheduled_run_in_progress`.
- **Other computes.** Manual computes, revisions, restatements and backfill keep the two-step guarded transitions.
- **Tests.** `worker/test/revision8.test.mjs` and `worker/test/workerd-adversarial.mjs` (real D1) use test-only hook points. They are active only when both the `TEST_HOOK` binding and `TEST_HOOKS_ENABLED = "true"` are present, and `worker/wrangler.toml` has neither.

The full cycle is in `docs/make-scenarios.md`.

### Dashboard → Worker: same-origin proxy (required before integration)

The browser only ever calls its own origin:

```
https://sb-profit.netlify.app/api/v1/*  →  netlify/edge-functions/api-proxy.js  →  <SB_WORKER_ORIGIN>/v1/*
```

- `netlify.toml` declares the proxy after the site-password gate.
- Set the Netlify variable `SB_WORKER_ORIGIN` (`https://sb-gp-worker.<account>.workers.dev`). While it is unset, `/api/v1/*` answers 503.
- The proxy forwards dashboard routes only: login, logout, session, and the published reads.
- It drops `X-*-Secret` headers, the site-password cookie and client IP headers.
- It refuses cross-origin POSTs.
- `js/workerClient.js` is the browser client. It calls `/api/v1/...` with `credentials: 'same-origin'`.
- `SameSite=Strict` stays. A direct cross-origin cookie setup is not supported without a deliberate change to the cookie and CORS model and new tests.

Before the dashboard reads from the Worker, run the real-proxy check against a
deploy preview:

```
SITE_PASSWORD=… DASHBOARD_PASSWORD=… node tools/proxy-smoke.mjs https://deploy-preview-N--sb-profit.netlify.app
```

It checks, in order:

1. The site gate lets the script in.
2. Login works through `/api/v1`.
3. The cookie is HttpOnly, Secure, SameSite=Strict and Path=/.
4. The session check and a published read succeed.
5. Admin and ingest routes cannot be reached.
6. A cross-origin POST is refused.
7. Logout works.
8. A copied cookie is refused after logout, and a forged cookie is refused.

### Credentials

| Class | Header / cookie | Used by | Can |
| --- | --- | --- | --- |
| Ingest | `X-Ingest-Secret` | Make S1–S3, `build.py`, `tools/backfill.mjs push` | write source rows and catalog; read the week plan |
| Admin | `X-Admin-Secret` | Make S0/S4, a person | compute, revise, restate costs, settings (audited), backfill, publish (when unlocked) |
| Reader session | `sb_session` (HttpOnly, Secure, SameSite=Strict, 12 h) | dashboard via `/api/v1` | read published snapshots, history, compare |

**Audit actors.** Every audit record stores two fields:

- `actor_class`, which the Worker assigns from the credential used:
  - `admin_secret`
  - `ingest_secret`
  - `reader_session`
  - `worker`, for changes the Worker makes itself
  - `migration`
- `actor_label`, an optional short tag the caller sends as `actorLabel`, such as `make:S4` or `duc`. It is context only, **not verified identity**, and email addresses are refused.

A request that sends the old `actor` field is refused. A shared secret cannot tell Make from a person, so "who" is only as precise as the credential. This applies to `settings_audit`, `cost_restatement`, `catalog_reuse_acceptance`, `run_transition` and `catalog_refresh` (`requested_by_class` / `requested_by_label`), and to the matching API responses.

The browser never receives a D1 credential and never calls D1. CORS allows
only `ALLOWED_ORIGINS`. Ten failed logins per 15 minutes from one address are
refused. Behind the Netlify proxy the Worker sees Netlify's address, so the
limit then applies to all dashboard users together: ten wrong passwords lock
everyone out for 15 minutes. That is the intended trade-off for Phase 1 (the
Worker does not trust forwarded-for headers, which a caller could forge).

### Shipping expense: Shipping Cost Report (C3, provisional)

The Worker's compute takes ShipStation expense from the ShipStation Analytics
Shipping Cost Report (C2 versions and active segments), Shipping Cost summed
per Shopify order. The mapping export is loaded for diagnostics only.

- Lively Root (Shopify Collective) orders: shipping is a pass-through
  (expense = customer shipping collected, net zero); a ShipStation cost is not used.
- Cancelled after shipping: kept as a shipping-only result only when Shopify
  shows `Fulfilled at` before `Cancelled at`, a Shipping Cost exists, and only
  the shipping was retained. Otherwise the order stays excluded.
- Order-level coverage (matched ÷ expected ShipStation orders), zero-shipping
  classes, Heat Pack delays and the lifecycle
  (`shipping_order_coverage_open | _updated | _complete`, 14-day aging) are
  stored on each snapshot under `totals.labels.c3`. Partial-shipment
  verification is unavailable (`partial_fulfillment_check_available=false`,
  `partial_fulfillment_verification_complete=false`); `shipping_complete` is
  never produced.
- Audited settings (migration 0009, reason required): `vendor_first_paid_shipping_dates`,
  `mcg_free_shipping_threshold`, `shipping_coverage_aging_days`,
  `provisional_publication_enabled` (locked false).
- Gate: `shipping_source_unverified` and `shipping_order_coverage_open` block
  publication until the source is verified (or, later, provisional
  publication is enabled). Product-cost completeness is reported separately.
- A report activation or rollback records the weeks whose order costs changed
  (ingest run `shipping_cost_report`), so `/v1/admin/revise-touched` drafts
  revisions for them.
- `AUTOMATION_ENABLED` (worker/wrangler.toml, "false") must be "true" for the
  scheduled path to run.

Dashboard: the ShipStation upload accepts the Shipping Cost Report. The file is
reduced to its 15 approved columns in the browser (Recipient, Shipping Paid and
+/- are dropped at once), only that form is stored locally, and nothing is
uploaded. A "Provisional result" panel shows the catalog version, missing-cost
lines and revenue, product-cost completeness, shipping-source verification,
order-level coverage and the zero-shipping classes.

Unmatched Shipping Orders (Shipping Analysis): every report order that joins no
uploaded Shopify order is listed (order #, ship date, Shipping Cost, report
rows, Provider, Service, reason) and is **excluded pending order match** — never
assigned to the period's GP. Reasons use ship dates against the Shopify export
period (the requested one when entered, otherwise the export's first and last
order dates), never order-number ranges: Before / After Shopify export period,
Not found in Shopify export, Invalid order number, Requires review. A bridge
shows raw report cost − unmatched − documented exclusions = ShipStation cost in
GP, with no residual. In the Worker, a later Shopify ingest that delivers the
order touches that order's week, so `/v1/admin/revise-touched` drafts a
revision; published snapshots are never changed.

### Route refund allocation (C4a)

Route Shipping Protection stays a customer-funded pass-through (collected =
remitted, zero contribution) and stays out of operating revenue, product
revenue and COGS, advertising and labor allocation, vendor/SKU profitability
and reverse-cost results.

- A general Shopify refund (the export's order-level `Refunded Amount`) is
  prorated over the order's product lines only. It is never spread onto the
  Route line; anything beyond product revenue stays at order level
  (`refundBeyondProduct`) and is shown in the revenue bridge.
- A Route refund is recognised only when Shopify's refund lines explicitly name
  the Route line (`explicitRouteRefunds()` → the engine's `routeRefunds`
  option). It lowers Route collected and remitted together. The CSV export has
  no refund lines, so CSV and manual uploads never produce a Route refund.
- Headline revenue, COGS, shipping and GP are unchanged by the correction; only
  the split between Route and product lines (browser dashboard, scenario tool,
  per-store product revenue) changes. The Worker contract already excluded
  Route from prorated refunds.
- Route statement reconciliation (Payments and Reimbursements CSVs) remains
  deferred; those formats are not available.

### Cost catalog: refresh, freshness, versioning

**Worker direct fetch (C6, replaces the Netlify build hook).** The Worker reads
the cost sheets itself. Set one Worker secret (never in `wrangler.toml`):

```
wrangler secret put CATALOG_SOURCES_JSON
{"MCG_SHEET_URL":"https://docs.google.com/…","MCG_POTS_SHEET_URL":"…", … ,"HP_COSTS_FOLDER_ID":"…","GDRIVE_API_KEY":"…"}
```

Keys are the build.py environment names: `MCG_SHEET_URL`, `MCG_POTS_SHEET_URL`,
`SB_SKU_ALIAS_URL`, `SB_SKU_ALIAS_URL_2`, `HP_SKU_ALIAS_URL`, `AS_SHEET_URL`,
`L2G_SHEET_URL`, `LIVELY_GOOD_SHEET_URL`, `CALATHEA_COLLECTIVE_SHEET_URL`,
`SURFSIDE_ARRANGEMENT_SHEET_URL`, `LINDAMAKES_SHEET_URL`, `HP_SHEET_URL`,
`MCG_EXTRA_SHEET_URL`, `HP_COSTS_FOLDER_ID` + `GDRIVE_API_KEY`, and the HP
fallbacks `PRODUCT_COSTS_JSON1/2`, `SKU_WEIGHTS_JSON`. Copy the values from the
Netlify environment; leave out any that are unset there.

Lively Root: the `LIVELY_GOOD_SHEET_URL` tab is the Products Master "Lively
Root" tab (the engine aliases vendor "Lively Root" to catalog key "Lively
Good"): SKU in column E, Cost per item in G, the Listing Shopify checkbox in
Q. build.py also writes a hand-copied `MANUAL_LR_COSTS` list into mcg_total,
which the engine consults first. Every fetch compares the tab's listed rows
with that list (counts only). The list stays in mcg_total until an
administrator sets `lively_root_cost_source` to `sheet` (audited, reason
required), which is refused unless the latest Worker fetch showed the tab and
the list identical. After the switch, tab edits reach mcg_total on the next fetch.

`POST /v1/admin/catalog/fetch { weekStart }` registers a refresh and answers it;
`{ refreshId }` answers one existing pending refresh. The tables are built by
`shared/catalogBuild.js`, a port of build.py checked against the real build.py
by `tools/catalog-parity/parity.mjs`. URLs, the folder id and the key are never
logged, stored or returned: provenance keeps a short SHA-256 of each URL and of
each source's content. Any configured source that fails (HTTP error, sign-in
page, empty, not UTF-8, too large, unparsable) rejects the whole refresh. An
empty or shrunken catalog is saved as `rejected` and never replaces the
accepted one.

The build-push path below still works and is retired after acceptance.

| Netlify variable | Value |
| --- | --- |
| `CATALOG_PUSH_URL` | the Worker base URL, `https://sb-gp-worker.<account>.workers.dev` (`build.py` appends `/v1/ingest/catalog`) |
| `SB_INGEST_SECRET` | the ingest secret |

Make S0 first registers a catalog refresh, then triggers the Netlify build hook
with `{ refreshId }`. `build.py` reads the id from `INCOMING_HOOK_BODY` and
sends it back with the catalog push, and the Worker marks the refresh
`fulfilled` or `rejected`. Each run records on its gate:

- the expected refresh;
- the selected catalog revision;
- when that catalog was captured;
- its freshness: `current`, `intentionally_reused`, `restated`, `reused_accepted` or `stale`.

A `stale` catalog blocks the gate. An administrator can accept reuse for one
run with a reason; that acceptance is stored in `catalog_reuse_acceptance`.

Version rules:

1. A week's first run records one catalog.
2. A retry or recompute reuses that catalog.
3. A revision of a week that already has a snapshot keeps the published
   snapshot's catalog, or else the latest snapshot's.
4. A newer catalog reaches history only through
   `POST /v1/admin/restate-costs { weekStart, reason }`. That creates a
   `cost_restatement` audit row and a draft revision, never a published one.

A revision that reuses an unpublished stale catalog stays `stale`. Only the
week's newest revision can be published, so publishing an older draft cannot
undo a later revision or restatement.

### Earlier weeks changed by this cycle

The Shopify updated-orders pull, late ShipStation shipments and HPD actuals
record `weeks_touched` on their ingest runs.
`POST /v1/admin/revise-touched { weekStart }` creates draft revisions for those
earlier weeks. It uses the reason and source runs, never publishes, and skips
weeks it has already revised.

### Make, ShipStation job, backfill

- Make scenarios S0–S4: `docs/make-scenarios.md`.
- ShipStation export on the Windows host (Monday 08:05 UTC):
  `automation/shipstation-export/README.md`.
- Backfill from 2026-01-01 runs in three steps:
  1. `tools/backfill.mjs validate`, which must report MATCH for every week.
  2. `push`.
  3. `POST /v1/admin/backfill { dryRun: false, acceptCatalogReuse: { reason } }`,
     repeated until `remaining` is empty.

  Historical weeks have no recorded catalog refresh, so the acceptance reason is
  required for them, and it is audited per run. One week is computed per call
  by default, which fits the free plan's 50 D1 queries per invocation; pass
  `maxWeeks` up to 8 on the paid plan. Source CSVs contain customer data; they
  stay on the workstation and are gitignored.

### Go-live checklist (all required before any lock is changed)

1. ShipStation zero-Rate investigation resolved. Then
   `POST /v1/admin/settings { carrier_fee_priority_locked: true, reason }`.
   Until this is done, every gate fails `carrier_fee_priority`, and neither
   publication switch can override that.
2. Insurance Cost non-duplication test complete and the treatment decided. The
   API refuses to change it until a deliberate code change.
3. HPD pass-through decision made. Until then those orders stay
   `provisional_hpd_pass_through`.
4. ShipStation cost coverage is at least 95% of the orders that require a
   ShipStation rate (`ss_coverage_threshold`) on the weeks to be published.
5. On those weeks, all reconciliation checks pass, Route net is 0, and the
   revenue-bridge residual is explained.
6. `tools/backfill.mjs validate` reports MATCH for every backfilled week.
7. Store time zone confirmed. Done in migration 0006: Pacific Time (US) →
   `America/Los_Angeles`. It stays a gate check.
8. Every check in `docs/deploy-preview-acceptance.md` has actually run and
   passed on a branch deploy with a staging Worker. That covers the build-hook
   catalog refresh (`tools/catalog-refresh-acceptance.mjs`) and the real
   `/api/v1` proxy (`tools/proxy-smoke.mjs`).
9. An administrator reviews at least one draft snapshot
   (`GET /v1/snapshot/<week>?includeDrafts=1`).
10. Then set `POST /v1/admin/settings { publication_enabled: true, reason }`
    **and** `PUBLICATION_ALLOWED = "true"`, and deploy.
