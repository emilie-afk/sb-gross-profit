# ShipStation weekly export (Windows host)

Downloads last week's ShipStation shipments with the saved custom export template and drops the CSV in the Google Drive folder that Make scenario S2 watches (`docs/make-scenarios.md`). It runs on the office Windows PC because ShipStation's custom exports are only available in the web app.

**Nothing secret lives in this folder or in the repository.** The login is in Windows Credential Manager; the browser session is in a profile under `%LOCALAPPDATA%\sb-shipstation-export\profile`; run logs are under `%LOCALAPPDATA%\sb-shipstation-export\runs`. No password, 2FA code, cookie or token is ever written to the config, a log or the manifest.

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
   ```
3. `copy config.example.json config.local.json` (gitignored). Set `outputDir` to the synced Drive folder.
4. In ShipStation, save a custom shipment export template named **SB GP weekly** with the Revision 5 fields only: Shipment ID, Order Number, Tracking Number, Ship Date, Modify Date, Void Flag, Void Date, Carrier, Service, Carrier Fee, Rate, Insurance Cost, Shipping Paid, Provider, Carrier Transaction ID, Internal Transaction ID, External ID, No Postage, Store Name, Package Count, Weight, Item SKU, Item Quantity (these are the columns `shared/adapters/shipstation.js` reads; anything else is ignored and reported). Shipping Paid is kept for disclosure only and is never used as expense. Leave out **Created By**: it can hold a staff email and is not needed; if it is present, the Worker keeps only a blank/integration/person class. No recipient, address, phone, email or company column; the job refuses any file that has one.
5. Record the export clicks: `npm run codegen`, sign in, open the template, set a date range and download. Copy the selectors into `exportSteps` in `config.local.json`, replacing every `REPLACE:` value. Use `{{weekStartUS}}` and `{{weekEndUS}}` (MM/DD/YYYY) or `{{weekStart}}` / `{{weekEnd}}` (YYYY-MM-DD) for the dates.
6. Sign in once with a visible browser and complete 2FA yourself: `npm run login`.
7. Test one week: `npm run export -- --week 2026-09-14 --headed`. Compare the file with a manual export of the same week.

## Schedule

The weekly cycle runs on **Monday 15:30 Ho Chi Minh time (08:30 UTC)**; see `docs/make-scenarios.md`. This job must run before that and after the store's week has closed. The week closes at Monday 00:00 in Los Angeles, which is 07:00 UTC in summer and 08:00 UTC in winter. The job therefore runs at **Monday 08:05 UTC** in every season.

| This PC's Windows time zone | Task Scheduler trigger |
| --- | --- |
| Vietnam (UTC+07:00) | Weekly, Monday, **15:05**, "Synchronize across time zones" checked |
| Pacific (UTC−08:00, with DST) | Weekly, Monday, **15:05 in a UTC+7 zone**: create it while the PC is set to UTC+07:00, or enter **08:05 UTC** with "Synchronize across time zones" checked. The trigger then fires at 00:05 PST or 01:05 PDT. |

```
schtasks /Create /TN "SB ShipStation export" /SC WEEKLY /D MON /ST 15:05 /TR "cmd /c cd /d C:\path\to\automation\shipstation-export && npm run export"
```

The job exports the last completed Monday–Sunday week in America/Los_Angeles (`config.timeZone`). Run too early in winter (before 08:00 UTC), it would export the week before; that is a harmless duplicate, and S4 would keep reporting ShipStation as missing for the new week. Do not schedule it earlier than 08:05 UTC.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | File delivered | nothing |
| 10 | Config error | fix `config.local.json` |
| 20 | 2FA required | run `npm run login` once |
| 21 | Captcha shown | run `npm run login` once |
| 22 | Unrecognised page | open ShipStation; update `auth.selectors` if the layout changed |
| 23 | Login rejected | update the stored credential |
| 30 | Export failed, or the file had customer columns | see the run manifest; fix the steps or the template |

The job never guesses: on anything other than a recognised signed-in page it stops before clicking. Page detection is in `src/authState.mjs`; selectors in `auth.selectors` override the defaults.

## Tests

`npm test` checks page classification against synthetic pages (no network). The pure helpers are tested in the repository's main suite.
