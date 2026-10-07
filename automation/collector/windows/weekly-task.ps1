<#
  weekly-task.ps1 — what the "SB GP weekly collector" scheduled task runs (Windows, native PowerShell)
  ======================================================================================================
  * Works out the last completed reporting week (Monday–Sunday, America/Los_Angeles).
  * When that week already finished on this PC (done-<week>.txt), a start is a recovery start: one
    attempt with --recovery, which asks the Worker one cheap question (GET /v1/collect/work) and exits
    at once when nothing is unfinished (verification, publication, comparisons, corrections). Otherwise
    it resumes only that work; sources already collected are never exported again.
  * Otherwise runs the collector (src/run.mjs; Chrome for ShipStation, Edge for Shopify, headed:
    on 2026-10-05 Shopify Admin answered the headless profile with a "Just a moment..." check while
    the same profile was signed in when headed, so the task runs headed in the user's session).
  * One start never outlives the task's own limit. Task Scheduler stops the task after its
    ExecutionTimeLimit (3 hours, see install-task.ps1); this script finishes -SafetyMinutes before it:
    it starts no attempt it cannot finish, gives each attempt at most -AttemptMinutes, and stops an
    attempt that overruns (its whole process tree) and releases the collector lock that attempt held,
    so no orphaned run holds the lock for the next start.
  * Exit codes of src/run.mjs and what happens next:
      0   done: done-<week>.txt is written. Only exit 0 writes it.
      5   another run holds the lock: it owns the week; stop.
      40  partial (a source failed, verification or publication work left): retry every -RetryMinutes,
          at most -Retries times in this start; the next trigger continues.
      41  Shopify sign-in needs a person (two-step code or a human check; unavoidable). Each attempt keeps
          the Shopify window open for signInWaitMinutes (default 30) and continues by itself once someone
          signs in there; the ShipStation report is uploaded first. Attempts repeat every
          -SignInRetryMinutes until this start's time is up (they do not use up -Retries). The next
          trigger (Monday every 3 hours for 12 hours, daily 07:20 ICT, at logon) opens it again. The
          dashboard says "Shopify needs a person to sign in" meanwhile.
      42  deferred: the day's D1 budget is used up (background work stops at 60% of the Free plan's daily
          allowance). Stop now, no retries (they would only add load), no done marker: the daily
          07:20 ICT trigger after the 00:00 UTC reset resumes it.
  * Logs (codes and counts only) go to <BaseDir>\logs; logs older than 90 days are removed.
  Parameters: -RepoDir, -Retries, -RetryMinutes, -SignInRetryMinutes, -TaskLimitMinutes, -SafetyMinutes,
  -AttemptMinutes, -MinAttemptMinutes. -BaseDir, -NodePath and -Week exist for tests.
#>
param(
  [string]$RepoDir = (Join-Path $env:USERPROFILE 'sb-gp'),
  [int]$Retries = 6,
  [double]$RetryMinutes = 15,
  [double]$SignInRetryMinutes = 2,
  [double]$TaskLimitMinutes = 180,
  [double]$SafetyMinutes = 15,
  [double]$AttemptMinutes = 100,
  [double]$MinAttemptMinutes = 5,
  [string]$BaseDir = (Join-Path ([string]$env:LOCALAPPDATA) 'sb-collector'),
  [string]$NodePath = 'node',
  [string]$Week = ''
)
$ErrorActionPreference = 'Continue'
$started = Get-Date
$deadline = $started.AddMinutes($TaskLimitMinutes - $SafetyMinutes)
$logs = Join-Path $BaseDir 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
Get-ChildItem $logs -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-90) } | Remove-Item -Force -ErrorAction SilentlyContinue

# Last completed reporting week in the store time zone (Monday start).
if (-not $Week) {
  $la = [TimeZoneInfo]::FindSystemTimeZoneById('Pacific Standard Time')
  $now = [TimeZoneInfo]::ConvertTimeFromUtc([DateTime]::UtcNow, $la)
  $thisMonday = $now.Date.AddDays(-(([int]$now.DayOfWeek + 6) % 7))
  $Week = $thisMonday.AddDays(-7).ToString('yyyy-MM-dd')
}
$done = Join-Path $BaseDir "done-$Week.txt"
# The week is done on this PC: a recovery start. One cheap check with the Worker (src/run.mjs --recovery)
# exits at once when nothing is unfinished, and resumes only what is (never a full collection again).
$recovery = Test-Path $done
$lockFile = Join-Path $BaseDir 'collector.lock'
$summary = Join-Path $logs ("task-{0}.log" -f $Week)
function Note([string]$text) { Add-Content -Path $summary -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $text) }

# Stop a process and every process it started (taskkill /T on Windows).
function Stop-Tree([int]$id) {
  if ($IsWindows -or $env:OS -eq 'Windows_NT') { & taskkill.exe /PID $id /T /F *> $null }
  else { Get-Process | Where-Object { $_.Parent -and $_.Parent.Id -eq $id } | ForEach-Object { Stop-Tree $_.Id }; Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}
# Release the collector lock only when the stopped attempt holds it (its pid is recorded in the lock).
function Release-LockOf([int]$id) {
  if (-not (Test-Path $lockFile)) { return }
  try { $l = Get-Content $lockFile -Raw | ConvertFrom-Json } catch { return }
  if ($l.pid -eq $id) { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue; Note "released the lock of stopped attempt $id" }
}

$collector = Join-Path $RepoDir 'automation\collector'
if (-not (Test-Path $collector)) { $collector = Join-Path $RepoDir 'automation/collector' }
$code = 1
$attempt = 0
while ($true) {
  $remaining = ($deadline - (Get-Date)).TotalMinutes
  if ($remaining -lt $MinAttemptMinutes) { Note "time is up for this start (exit $code); the next trigger continues"; break }
  $limit = [Math]::Min($AttemptMinutes, $remaining)
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $log = Join-Path $logs ("run-{0}-{1}.log" -f $Week, $stamp)
  $runArgs = @('src/run.mjs', '--config', 'config.local.json', '--headed')
  if ($recovery) { $runArgs += '--recovery' }
  $p = Start-Process -FilePath $NodePath -ArgumentList $runArgs -WorkingDirectory $collector -NoNewWindow -PassThru `
         -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')
  $null = $p.Handle                                   # keeps the exit code readable after exit
  if (-not $p.WaitForExit([int]($limit * 60000))) {
    Stop-Tree $p.Id
    $p.WaitForExit(10000) | Out-Null
    Release-LockOf $p.Id
    $code = 124
    Note "attempt stopped after $([int]$limit) min (overran); it is retried"
  } else {
    $p.WaitForExit()
    $code = $p.ExitCode
    Note "attempt exit $code"
  }
  if ($recovery) { Note "recovery start: exit $code"; break }   # one attempt; the next trigger checks again
  if ($code -eq 0) { Set-Content -Path $done -Value ([DateTime]::UtcNow.ToString('o')); break }
  if ($code -eq 5) { break }          # another instance is running (lock): it owns this week's run
  if ($code -eq 42) { Note 'deferred: daily D1 budget used; resumes after the reset (daily 07:20 ICT trigger)'; break }
  if ($code -eq 41) {                 # Shopify waits for a person to sign in: open the window again soon
    if (($deadline - (Get-Date)).TotalMinutes -lt ($SignInRetryMinutes + $MinAttemptMinutes)) { Note 'no time left for another sign-in attempt in this start'; break }
    Start-Sleep -Milliseconds ([int]($SignInRetryMinutes * 60000))
    continue
  }
  $attempt++
  if ($attempt -gt $Retries) { break }
  if (($deadline - (Get-Date)).TotalMinutes -lt ($RetryMinutes + $MinAttemptMinutes)) { Note "no time left for another retry in this start"; break }
  Start-Sleep -Milliseconds ([int]($RetryMinutes * 60000))
}
exit $code
