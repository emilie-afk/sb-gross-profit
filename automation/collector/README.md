# Weekly collector orchestrator (Windows host, C7)

One scheduled job drives both collectors on the office PC. **It never runs the two Playwright browsers at the same time.**

1. **ShipStation Shipping Cost Report.** `automation/shipstation-export` runs with its own browser profile, then closes the browser. The sanitized report is held for upload.
2. **Shopify rolling orders export.** `automation/shopify-export` runs with its own browser profile and requests the export.
3. **While Shopify prepares the emailed export,** the ShipStation report is uploaded over HTTP only. If Shopify downloaded directly, or was skipped, the upload happens right after instead.
4. **Gmail and the Shopify upload.** Gmail is polled with read-only access and the fixed search, and the sanitized Shopify export is uploaded.
5. **Independent sources.** Each source is reported to the Worker on its own; one failing never stops the other.

Each collector keeps its own profile folder (`%LOCALAPPDATA%\sb-shipstation-export`, `%LOCALAPPDATA%\sb-shopify-export`) and its own Credential Manager entries (`sb-shipstation-export`, `sb-shopify-export`, `sb-gmail-oauth-client`, `sb-gmail-readonly`). `sb-gp-ingest` is shared. The orchestrator itself holds no credentials; it only points at the two collectors' `config.local.json` files. Set up both collectors first (their READMEs).

## Missed runs and restarts

The job starts at **Monday 15:05 Ho Chi Minh time**. It also starts at logon/startup, and Task Scheduler runs a missed start as soon as possible. On every start it:

1. Works out the last closed reporting week (Monday–Sunday, America/Los_Angeles). A week that has not closed is never collected.
2. Asks the Worker's week plan (`GET /v1/ingest/week-plan`, ingest secret) which sources that week still lacks (`collected`).
3. Collects only those. A restart after a successful week does nothing, and a restart after a partial week collects only the missing source. If the Worker is unreachable, the local `state.json` (sources and statuses only) decides. Uploads are idempotent either way.
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
$t1 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 15:05      # PC in UTC+07:00; otherwise 08:05 UTC
$t2 = New-ScheduledTaskTrigger -AtLogOn
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3)
Register-ScheduledTask -TaskName "SB weekly collector" -Action $a -Trigger $t1,$t2 -Settings $s
```

Remove the older per-collector weekly tasks, if they exist ("SB ShipStation export", "SB Shopify export"). Keep both daily quarantine purges.

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

`tests/collector-orchestrator.test.mjs` in the main suite covers the order of steps, one browser at a time, independent sources, catch-up, the lock and the not-closed rule. It uses fakes only.
