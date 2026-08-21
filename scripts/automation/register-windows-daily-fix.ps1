#Requires -Version 5.1
<#
.SYNOPSIS
  注册「每天修一个内部缺陷并开 PR」的 Windows 任务计划。

.DESCRIPTION
  到点拉起 WSL，执行仓库内 scripts/automation/daily-fix-cron.sh。
  电脑在计划时刻关机时，开机后会补跑一次（StartWhenAvailable）。
  不会在用户未登录时跑：WSL 依赖当前用户会话。

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/automation/register-windows-daily-fix.ps1
#>
param(
  [string]$TaskName = "BagujingDailyFix",
  [string]$Distro = "Ubuntu-24.04",
  [string]$LinuxScript = "/home/alice/workspace/bagujing/scripts/automation/daily-fix-cron.sh",
  [string]$Time = "10:00"
)

$ErrorActionPreference = "Stop"

$arg = "-d $Distro -e bash $LinuxScript"
$action = New-ScheduledTaskAction -Execute "wsl.exe" -Argument $arg
$trigger = New-ScheduledTaskTrigger -Daily -At $Time

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "DevAsk: WSL daily-fix.sh --yes --push, one auto defect per day, open GitHub PR." `
  -Force | Out-Null

Write-Host "已注册任务 $TaskName"
Write-Host "  每天 $Time 执行: wsl.exe $arg"
Write-Host "  查看: schtasks /Query /TN $TaskName /V /FO LIST"
Write-Host "  立刻试跑: schtasks /Run /TN $TaskName"
Write-Host "  删除: Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
