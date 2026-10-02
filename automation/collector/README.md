# Weekly collector orchestrator (Windows host, C7)

One scheduled job drives both collectors on the office PC. **It never runs the two Playwright browsers at the same time.**

1. **ShipStation Shipping Cost Report.** `automation/shipstation-export` runs with its own browser profile, then closes the browser. The sanitized report is held for upload.
2. **Shopify rolling orders export.** `automation/shopify-export` runs with its own browser profile and requests the export.
3. **While Shopify prepares the emailed export,** the ShipStation report is uploaded over HTTP only. If Shopify downloaded directly, or was skipped, the upload happens right after instead.
4. **Gmail and the Shopify upload.** Gmail is polled with read-only access and the fixed search, and the sanitized Shopify export is uploaded.
5. **Independent sources.** Each source is reported to the Worker on its own; one failing never stops the other.
6. **Free-tier path (`"pipeline": "free_tier"`).** The PC computes every week of the rolling window whose inputs changed, with the same shared engine, uploads the results, and asks the independent verifier (`gp-verify-background` on Netlify) to recompute them. See *Free-tier path* below.

Each collector keeps its own profile folder (`%LOCALAPPDATA%\sb-shipstation-export`, `%LOCALAPPDATA%\sb-shopify-export`) and its own Credential Manager entries (`sb-shipstation-export`, `sb-shopify-export`, `sb-gmail-oauth-client`, `sb-gmail-readonly`). `sb-gp-ingest` is shared. The orchestrator itself holds no credentials; it only points at the two collectors' `config.local.json` files. Set up both collectors first (their READMEs).

## Missed runs and restarts

The job starts at **Monday 14:05 Ho Chi Minh time** on the Free-tier path (15:05 on the csv_text path). It also starts at logon/startup, and Task Scheduler runs a missed start as soon as possible. On every start it:

1. Works out the last closed reporting week (Monday–Sunday, America/Los_Angeles). A week that has not closed is never collected.
2. Asks the Worker's week plan (`GET /v1/ingest/week-plan`, ingest secret) which sources that week still lacks (`collected`).
3. Collects only those. A restart after a successful week opens no browser (on the Free-tier path it still runs the compute step, which skips unchanged weeks and writes nothing), and a restart after a partial week collects only the missing source. If the Worker is unreachable, the local `state.json` (sources and statuses only) decides. Uploads are idempotent either way.
4. Holds `collector.lock` so two starts never overlap. A lock older than 3 hours, left by a crashed run, is replaced.

## Setup

```
cd automation\collector
npm install
copy config.example.json config.local.json
```

Set `workerUrl` in `config.local.json`, staging first. Create one task with two triggers (PowerShell, as the user that runs the collectors):

```
$a = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c cd /d C:\path\to\automation\collector && npm run collect"
$t1 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 14:05      # Free-tier path; PC in UTC+07:00 (07:05 UTC). csv_text path: 15:05
$t2 = New-ScheduledTaskTrigger -AtLogOn
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3)
Register-ScheduledTask -TaskName "SB weekly collector" -Action $a -Trigger $t1,$t2 -Settings $s
```

Remove the older per-collector weekly tasks, if they exist ("SB ShipStation export", "SB Shopify export"). Keep both daily quarantine purges.

## Free-tier path

Set `"pipeline": "free_tier"` (the default in `config.example.json`). The Worker then only validates and stores; it never computes a week (Workers Free: 10 ms CPU per request, 100,000 D1 rows written per day for the whole account).

1. **Sources in segments.** Each sanitized file (the Shopify rolling export and the Shipping Cost Report) is uploaded in ≤ 100-row gzip segments. The Worker checks each segment's hash, decompresses it with a size cap, runs the same privacy guards as before and only then keeps it. Any failure rejects the whole file; only an error code comes back. Raw exports still never leave the PC.
2. **Shipping Cost Report version.** The PC builds the per-date, per-order groups with the unchanged parser. The Worker checks them against its own segment sums and applies the approved rules: review for the first version, a coverage gap, a possibly incomplete last date, any row with Shipping Cost $0.00 or above the review threshold (setting `shipping_cost_review_cap_cents`, $100), and non-zero Insurance / Duties / Taxes / Import Fee. Otherwise new dates activate, identical dates are no-ops, late costs for orders that had none are filled in, and any change or removal of an accepted cost is held for review.
3. **Orders.** Only new or changed orders are sent (content-addressed, 10 per request).
4. **Compute.** For every week of the rolling window the PC fetches the Worker's signed manifest (exactly the inputs the Worker's own loaders would use). A week whose newest draft already has those inputs is skipped. Otherwise it computes with the unchanged engine and uploads the result parts. The Worker re-checks that nothing changed, evaluates the gate and stores the draft (`storage = 'chunked'`).
5. **Verification.** One call to `gp-verify-background` recomputes every new draft on Netlify from the Worker's pinned inputs, compares every order and aggregate, and re-derives the orders and shipping dates from the retained sanitized sources. The PC then polls the drafts' verification state with one batched request (`/v1/collect/verification`; per-week status against an older Worker) for up to `verifyWaitMinutes` (8). A draft stays **provisional** until it is `verified`; a late verification shows as `verification_pending`, never as met.

Every step is idempotent: a restart or a repeat run writes nothing when nothing changed.

**Timing.** The target is a *verified* draft by Monday 15:30 ICT. The week closes Monday 00:00 in Los Angeles, which is 14:00 ICT in summer (PDT) and 15:00 ICT in winter (PST). Start the task at **Monday 14:05 ICT**: in summer it runs at once, in winter it waits for the close (`waitForCloseMinutes`, 75). The week status names exactly what is still pending (export, review, compute or verification) and never reports the target as met without a verified draft.

Credentials (Windows Credential Manager): `sb-gp-ingest` as before, and `sb-gp-verify-trigger` for `verifyUrl`.

## Worker side

The Worker's first compute attempt is Monday 15:30 ICT.

- **Missing source:** the week's single run waits (`waiting_for_sources`) and retries every 15 minutes to 18:30, then hourly to Tuesday 15:30. After that it becomes `source_timeout`; a later valid upload still resumes the same run on the next tick.
- **Status:** the dashboard's Reports screen shows the status.
- **Publication:** nothing publishes automatically.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every missing source was delivered, the week was already collected, or the week has not closed yet |
| 5 | Another instance is running |
| 40 | Partial: at least one source failed. The run output and each collector's manifest name the source and its own exit code (see the collector READMEs) |

## Tests

`tests/collector-orchestrator.test.mjs` in the main suite covers the order of steps, one browser at a time, independent sources, catch-up, the lock and the not-closed rule. It uses fakes only. `tests/collector-free-tier.test.mjs` runs the Free-tier path end to end against the real Worker code and the real verifier (browsers and Gmail faked).
