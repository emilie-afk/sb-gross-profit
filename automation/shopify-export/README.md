# Shopify orders export (Windows host, C5)

Each Monday this job asks Shopify Admin for the **rolling eight-week orders export**, which covers orders created in the 56 days ending on the reporting Sunday. It reads Shopify's "export ready" email from the export mailbox with **Gmail read-only** access and a **fixed search**. It then downloads the file into memory, removes every customer field on this PC, and uploads only the sanitized CSV to the Worker (`POST /v1/ingest/shopify`, `mode: "rolling"`).

The Worker records that one upload as two inputs for the week: the week's orders, and the updated-order scan (earlier orders that were refunded or changed are in the same window).

No Shopify API, Admin API token, custom app or Shopify connector is used. **Nothing secret lives in this folder or in the repository.**

## What never leaves this PC, and what is never kept

| Item | Handling |
| --- | --- |
| Raw export (names, emails, addresses, phones, notes, raw tags and discount codes) | Held in memory only. It is reduced at once to the approved columns and minimum free-text form (`shared/adapters/shopifyCsv.js`, `shopifyPrivacy.js`) and re-checked with the Worker's own validators. The buffer is then zeroed. A small export that downloads directly is written to `downloads\` just long enough to be read, then deleted. |
| Email body, subject, sender, download link | Read in memory to find the one Shopify download link. They are never logged, stored or written to the manifest; the manifest keeps only the link's host and a hash of the message id. |
| Shopify login, Gmail tokens, Worker secret | Windows Credential Manager only. |
| Browser session | Persistent profile under `%LOCALAPPDATA%\sb-shopify-export\profile`, outside the repository and any cloud-synced folder (the job refuses otherwise). |
| Failed uploads | The **sanitized** CSV only, in `quarantine\`, deleted after 72 hours. |

## Gmail access

- **Scope:** `https://www.googleapis.com/auth/gmail.readonly` only. A token carrying any other scope is refused before any mailbox call.
- **Calls:** three read calls, all under `users/me`: `profile`, which checks that the authorized mailbox is `gmail.mailbox`; one fixed search; and one message read. Nothing is labelled, moved, sent or deleted.
- **Search:** fixed in code (`lib.mjs`): `from:shopify.com subject:export after:<request time − 5 min>`. The config cannot set or extend it, and a config that contains a `query`/`search`/`filter` key is refused.
- **Matching:** the job accepts exactly one email received after the export request. It must come from a `shopify.com` sender, have "export" and "order" in the subject, and contain exactly one https download link on a Shopify-owned host (`shopify.com`, `myshopify.com`, `shopifycloud.com`, `shopifycdn.com`, `shopifysvc.com`). No email means a timeout (exit 32). Two matching emails is ambiguous (exit 30), and the job does not guess.

## One-time setup

1. Install Node.js 20+ and, in this folder, run `npm install`, then `npx playwright install chromium`.
2. **Dedicated Shopify staff account** with the minimum permission to view and export orders. Store its login:
   ```
   Install-Module CredentialManager -Scope CurrentUser
   New-StoredCredential -Target sb-shopify-export -UserName <staff email> -Password <password> -Persist LocalMachine
   New-StoredCredential -Target sb-gp-ingest -UserName worker -Password <Worker INGEST_SECRET> -Persist LocalMachine
   ```
   (`sb-gp-ingest` is shared with the ShipStation job; skip it if it already exists.)
3. **Export mailbox.** Shopify emails the export to the staff account's address. Make it reach the export mailbox, either by using that address for the staff account or with an automatic forward.
4. **Gmail OAuth client.** In a Google Cloud project, create an OAuth client of type *Desktop app*. On the consent screen, add only the `gmail.readonly` scope. Store the client:
   ```
   New-StoredCredential -Target sb-gmail-oauth-client -UserName <client id> -Password <client secret> -Persist LocalMachine
   ```
5. `copy config.example.json config.local.json` (gitignored). Set `adminUrl`, `workerUrl` (staging first) and `gmail.mailbox`.
6. Authorize Gmail once: `npm run gmail-authorize`. Open the printed address and sign in to the export mailbox. The script checks the granted scope and the mailbox, then stores the refresh token under `sb-gmail-readonly`.
7. Sign in to Shopify once with a visible browser and complete 2FA yourself: `npm run login`.
8. Record the export clicks with `npm run codegen`:
   - Open Orders.
   - Filter *Date created* from `{{windowFrom}}` to `{{windowTo}}` (or the `…US` MM/DD/YYYY forms).
   - Choose Export → *Current search* → CSV.
   - Replace every `REPLACE:` selector in `exportSteps`. The last step must be `requestExport`, the "Export orders" button.

   Navigation is limited to the Admin origin.
9. Test one week: `npm run export -- --week 2026-09-14 --headed`. Check the manifest in `%LOCALAPPDATA%\sb-shopify-export\runs`.

## Checks before upload (the job stops rather than guesses)

- **Sign-in state:** the job stops on a 2FA prompt, a captcha, an expired session that login does not fix, or any page it does not recognise, including an Admin-looking page outside the Admin origin.
- **File format:** the download must be a Shopify orders CSV. An HTML page (usually a sign-in), a ZIP file or anything else is refused.
- **Required columns:** the Worker minimum plus `Cancelled at`, `Fulfilled at`, `Financial Status` and `Refunded Amount`.
- **Order dates:** every order's `Created at` must fall inside the rolling window. If any does not, the export filter is wrong (`export_window_mismatch`).
- **Free text:** any free text outside the approved form, such as an unapproved Source or Channel value, stops the job (`sanitization_failed`). The refusal names columns and rules, never values.

## Schedule

Run it after the store's week closes. That is Monday 07:00 UTC in summer and 08:00 UTC in winter, so schedule it for **Monday 15:05 Ho Chi Minh time (08:05 UTC)**, alongside the ShipStation job:

```
schtasks /Create /TN "SB Shopify export" /SC WEEKLY /D MON /ST 15:05 /TR "cmd /c cd /d C:\path\to\automation\shopify-export && npm run export"
schtasks /Create /TN "SB Shopify quarantine cleanup" /SC DAILY /ST 09:05 /TR "cmd /c cd /d C:\path\to\automation\shopify-export && npm run purge"
```

The email can take a while, so the job polls for up to `gmail.timeoutMinutes` (default 45). The Worker's readiness check keeps waiting for the input, and nothing is estimated.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Uploaded (`source_received` or `source_no_change`) | nothing |
| 10 | Config error (including a Gmail search in the config) | fix `config.local.json` |
| 20 | Shopify 2FA required | `npm run login` |
| 21 | Captcha shown | `npm run login` |
| 22 | Unrecognised page | open Shopify Admin; update `auth.selectors` if the layout changed |
| 23 | Login rejected | update the `sb-shopify-export` credential |
| 24 | Gmail authorization missing, not read-only, or the wrong mailbox | `npm run gmail-authorize` |
| 30 | Export steps failed, ambiguous email, unknown link or file, missing columns, window mismatch, or sanitization refused | see the manifest; fix the steps or extend the approved lists deliberately |
| 31 | Upload to the Worker failed after retries | the sanitized file is in `quarantine` for 72 h; rerun the job |
| 32 | No export email arrived in time | check the forward to the export mailbox; rerun |

## Tests

`npm test` runs the sign-in detection and the Playwright adapter against synthetic offline pages. It skips when Chromium is not installed. The pure helpers, the Gmail client and the whole run (with fakes and the in-process Worker) are tested in the repository's main suite: `tests/shopify-collector.test.mjs`.
