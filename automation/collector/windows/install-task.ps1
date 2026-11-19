<#
  install-task.ps1 — show, and on -Apply set, the triggers and limits of the weekly collector task
  ================================================================================================
    powershell -NoProfile -File install-task.ps1 [-TaskName "SB GP weekly collector"]           # show only
    powershell -NoProfile -File install-task.ps1 -Apply [-TaskName ...]                         # set

  Read first: without -Apply it only prints the task's actual settings (execution limit, multiple
  instances, start when available, triggers, action), so a deployment confirms what Task Scheduler
  really does instead of assuming. Nothing about the action, the user it runs as or its credentials is
  changed by -Apply; only these settings and triggers are set (times are the PC's local time, ICT):
    * Monday 15:05, repeating every 3 hours for 12 hours (sign-in waits, partial runs, late reports);
    * daily 07:20 (just after D1's 00:00 UTC reset: deferred work resumes; a done week exits at once);
    * at logon (a PC that was off catches up);
    * ExecutionTimeLimit 3 hours (weekly-task.ps1 stops itself 15 minutes earlier), MultipleInstances
      IgnoreNew (a start while one runs is skipped; the collector lock is the second guard),
      StartWhenAvailable (a missed start runs as soon as possible).
#>
param(
  [string]$TaskName = 'SB GP weekly collector',
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$t = Get-ScheduledTask -TaskName $TaskName
function Show($task) {
  $s = $task.Settings
  [pscustomobject]@{
    Task = $task.TaskName; State = $task.State
    ExecutionTimeLimit = $s.ExecutionTimeLimit; MultipleInstances = $s.MultipleInstances; StartWhenAvailable = $s.StartWhenAvailable
    DisallowStartIfOnBatteries = $s.DisallowStartIfOnBatteries; StopIfGoingOnBatteries = $s.StopIfGoingOnBatteries
    Triggers = ($task.Triggers | ForEach-Object { "{0} {1} {2}" -f $_.CimClass.CimClassName.Replace('MSFT_Task', '').Replace('Trigger', ''), $_.StartBoundary, $(if ($_.Repetition.Interval) { "every $($_.Repetition.Interval) for $($_.Repetition.Duration)" } else { '' }) }) -join '; '
    Action = ($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join '; '
  } | Format-List
}
Show $t
if (-not $Apply) { return }

$weekly = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 15:05
$weekly.Repetition = (New-ScheduledTaskTrigger -Once -At 15:05 -RepetitionInterval (New-TimeSpan -Hours 3) -RepetitionDuration (New-TimeSpan -Hours 12)).Repetition
$daily = New-ScheduledTaskTrigger -Daily -At 07:20
$logon = New-ScheduledTaskTrigger -AtLogOn -User $t.Principal.UserId
$s = $t.Settings
$s.ExecutionTimeLimit = 'PT3H'
$s.MultipleInstances = 'IgnoreNew'
$s.StartWhenAvailable = $true
Set-ScheduledTask -TaskName $TaskName -Trigger @($weekly, $daily, $logon) -Settings $s | Out-Null
Show (Get-ScheduledTask -TaskName $TaskName)
