<#
  weekly-task.ps1 — what the "SB GP weekly collector" scheduled task runs (Windows, native PowerShell)
  ======================================================================================================
  * Works out the last completed reporting week (Monday–Sunday, America/Los_Angeles).
  * Exits at once if that week already finished successfully on this PC (done-<week>.txt), so the
    at-logon trigger and restarts never re-run a completed week.
  * Otherwise runs the collector (src/run.mjs; Chrome for ShipStation, Edge for Shopify, headless:
    measured 2026-10-02, the emailed Shopify file downloads reliably only from a headless context,
    and both exports work headless once the browser profiles are signed in) and, while the result is partial (e.g. a Shipping Cost Report held for review, a
    verification still running), retries every 15 minutes up to 6 times. Every retry is idempotent:
    sources the Worker already holds are not exported again, unchanged weeks write nothing.
  * Logs (codes and counts only) go to %LOCALAPPDATA%\sb-collector\logs; logs older than 90 days are removed.
  Parameters: -RepoDir (default C:\Users\<you>\sb-gp), -Retries, -RetryMinutes.
#>
param(
  [string]$RepoDir = (Join-Path $env:USERPROFILE 'sb-gp'),
  [int]$Retries = 6,
  [int]$RetryMinutes = 15
)
$ErrorActionPreference = 'Continue'
$base = Join-Path $env:LOCALAPPDATA 'sb-collector'
$logs = Join-Path $base 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
Get-ChildItem $logs -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-90) } | Remove-Item -Force -ErrorAction SilentlyContinue

# Last completed reporting week in the store time zone (Monday start).
$la = [TimeZoneInfo]::FindSystemTimeZoneById('Pacific Standard Time')
$now = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $la)
$thisMonday = $now.Date.AddDays(-(([int]$now.DayOfWeek + 6) % 7))
$week = $thisMonday.AddDays(-7).ToString('yyyy-MM-dd')
$done = Join-Path $base "done-$week.txt"
if (Test-Path $done) { exit 0 }

$collector = Join-Path $RepoDir 'automation\collector'
$code = 1
for ($attempt = 0; $attempt -le $Retries; $attempt++) {
  if ($attempt -gt 0) { Start-Sleep -Seconds ($RetryMinutes * 60) }
  $log = Join-Path $logs ("run-{0}-{1}.log" -f $week, (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Push-Location $collector
  & node src\run.mjs --config config.local.json *> $log
  $code = $LASTEXITCODE
  Pop-Location
  if ($code -eq 0) { Set-Content -Path $done -Value ([DateTime]::UtcNow.ToString('o')); break }
  if ($code -eq 5) { break }          # another instance is running (lock): it owns this week's run
}
exit $code
