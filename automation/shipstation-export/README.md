# ShipStation weekly export (Windows host)

Two export roles (`--kind`):

| Kind | What | Role |
| --- | --- | --- |
| `shipstation_shipping_cost_report` (default) | Analytics → Reports → Shipping Cost Report, rolling 8 weeks of ship dates ending last Sunday | Proposed carrier-expense source (Revision 9). Sanitized **on this PC** to the 15 approved columns: `Recipient`, `Shipping Paid` and `+/-` never leave the machine. Uploaded to `/v1/ingest/shipping-cost-report`. Source verification is still pending, so the dashboard labels it unverified. |
| `shipstation_mapping_export` | The saved "SB GP weekly" custom export described below | Dormant: mapping only, never an expense source, and it never satisfies the Worker's shipping readiness. The job refuses this kind unless `kinds.shipstation_mapping_export.enabled` is `true` (rollback diagnostics only). |


By default it exports the Shipping Cost Report for the rolling eight weeks ending last Sunday, sanitizes it and uploads it to `POST /v1/ingest/shipping-cost-report`. The Worker's weekly readiness needs this report; the mapping export never satisfies it. The sections below on the saved custom template apply only to the dormant mapping export. It runs on the office Windows PC because these exports are only available in the web app, and there is no ShipStation API access.

**Nothing secret lives in this folder or in the repository.** The ShipStation login and the Worker ingest secret are in Windows Credential Manager; the browser session is in a profile under `%LOCALAPPDATA%\sb-shipstation-export\profile`; run logs are under `%LOCALAPPDATA%\sb-shipstation-export\runs`. No password, 2FA code, cookie or token is ever written to the config, a log or the manifest.

## One-time setup

1. Install Node.js 20+ and, in this folder:
   ```
   npm install
   npx playwright install chromium
   ```
2. Store the ShipStation login (PowerShell, as the Windows user that runs the job):
   ```
   Install-Module CredentialManager -Scope CurrentUser
   New-StoredCredential -Target sb-shipstation-export -UserName <user> -Password <password> -Persist LocalMachine
   New-StoredCredential -Target sb-gp-ingest -UserName worker -Password <Worker INGEST_SECRET> -Persist LocalMachine
   ```
3. `copy config.example.json config.local.json` (gitignored). Set `workerUrl` to the Worker (staging first). Delivery to the Worker is the default. `"delivery": "drive"` plus an explicit `outputDir` is the old copy-to-folder behaviour, kept for rollback only and off unless both are set.
4. In ShipStation, save a custom shipment export template named **SB GP weekly** with the Revision 5 fields only: Shipment ID, Order Number, Tracking Number, Ship Date, Modify Date, Void Flag, Void Date, Carrier, Service, Carrier Fee, Rate, Insurance Cost, Shipping Paid, Provider, Carrier Transaction ID, Internal Transaction ID, External ID, No Postage, Store Name, Package Count, Weight, Item SKU, Item Quantity (these are the columns `shared/adapters/shipstation.js` reads; anything else is ignored and reported). Shipping Paid is kept for disclosure only and is never used as expense. Leave out **Created By**: it can hold a staff email and is not needed; if it is present, the Worker keeps only a blank/integration/person class. No recipient, address, phone, email or company column; the job refuses any file whose columns are not exactly the template's (an allowlist, not a list of banned names).
5. Record the export clicks: `npm run codegen`, sign in, open the template, set a date range and download. Copy the selectors into `exportSteps` in `config.local.json`, replacing every `REPLACE:` value. Use `{{weekStartUS}}` and `{{weekEndUS}}` (MM/DD/YYYY) or `{{weekStart}}` / `{{weekEnd}}` (YYYY-MM-DD) for the dates.
6. Sign in once with a visible browser and complete 2FA yourself: `npm run login`.
7. Test one week: `npm run export -- --week 2026-09-14 --headed`. Compare the file with a manual export of the same week.

## Schedule

> **C7:** schedule the combined job in `automation/collector` (ShipStation, then Shopify, one browser at a time, with catch-up after missed starts) instead of scheduling this job on its own. The commands below still work for manual and test runs.

The Worker's weekly cycle runs on **Monday 15:30 Ho Chi Minh time (08:30 UTC)** and waits for this upload before computing. This job must run before that and after the store's week has closed. The week closes at Monday 00:00 in Los Angeles, which is 07:00 UTC in summer and 08:00 UTC in winter. The job therefore runs at **Monday 08:05 UTC** in every season.

| This PC's Windows time zone | Task Scheduler trigger |
| --- | --- |
| Vietnam (UTC+07:00) | Weekly, Monday, **15:05**, "Synchronize across time zones" checked |
| Pacific (UTC−08:00, with DST) | Weekly, Monday, **15:05 in a UTC+7 zone**: create it while the PC is set to UTC+07:00, or enter **08:05 UTC** with "Synchronize across time zones" checked. The trigger then fires at 00:05 PST or 01:05 PDT. |

```
schtasks /Create /TN "SB ShipStation export" /SC WEEKLY /D MON /ST 15:05 /TR "cmd /c cd /d C:\path\to\automation\shipstation-export && npm run export"
```

The job exports the last completed Monday–Sunday week in America/Los_Angeles (`config.timeZone`). Run too early in winter (before 08:00 UTC), it would export the week before; that is a harmless duplicate (the Worker answers `source_no_change` or records only duplicates), and the Worker would keep reporting ShipStation as missing for the new week. Do not schedule it earlier than 08:05 UTC.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | File uploaded (manifest `ingest.sourceStatus` is `source_received` or `source_no_change`) | nothing |
| 10 | Config error | fix `config.local.json` |
| 20 | 2FA required | run `npm run login` once |
| 21 | Captcha shown | run `npm run login` once |
| 22 | Unrecognised page | open ShipStation; update `auth.selectors` if the layout changed |
| 23 | Login rejected | update the stored credential |
| 30 | Export failed, the file had customer columns, or the export was invalid (no rows, missing columns) | see the run manifest; fix the steps or the template |
| 31 | Export fine, upload to the Worker failed after retries (or was refused) | see `ingest` in the manifest; the file is in `quarantine` for 72 hours, then deleted |

## Daily quarantine cleanup

A file that failed delivery is kept in `quarantine` for at most 72 hours. Cleanup runs every day, independent of the weekly export:

```
schtasks /Create /TN "SB collector quarantine cleanup" /SC DAILY /ST 09:00 /TR "cmd /c cd /d C:\path\to\automation\shipstation-export && npm run purge"
```

The local working folder (`localDir`, default `%LOCALAPPDATA%\sb-shipstation-export`) must be outside the repository and outside any cloud-synced folder (OneDrive, Google Drive, Dropbox, iCloud); the job refuses to start otherwise.

## Delivery and retries

The upload is safe to repeat. The Worker stores shipments by content hash and answers `source_no_change` for identical content, so a retry never duplicates a shipment. Network errors, 429 and 5xx are retried up to 4 times with backoff; any other refusal (wrong secret, customer columns, bad payload) stops at once. The manifest records the week, export time, file hash, row count and the Worker's answer (run id, source status, rows written). It never holds the CSV, the secret or a response body.

The job never guesses: on anything other than a recognised signed-in page it stops before clicking. Page detection is in `src/authState.mjs`; selectors in `auth.selectors` override the defaults.

## Tests

`npm test` checks page classification against synthetic pages (no network). The pure helpers are tested in the repository's main suite.
