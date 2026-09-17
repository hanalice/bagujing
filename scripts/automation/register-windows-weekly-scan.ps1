#Requires -Version 5.1
<#
.SYNOPSIS
  注册「每周扫描 backlog 并开 PR」的 Windows 任务计划。

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/automation/register-windows-weekly-scan.ps1
#>
param(
  [string]$TaskName = "BagujingWeeklyScan",
  [string]$Distro = "Ubuntu-24.04",
  [string]$LinuxScript = "/home/alice/workspace/bagujing/scripts/automation/weekly-scan-cron.sh",
  [string]$Time = "21:00",
  [ValidateSet("Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday")]
  [string]$Day = "Sunday"
)

$ErrorActionPreference = "Stop"

$arg = "-d $Distro -e bash $LinuxScript"
$action = New-ScheduledTaskAction -Execute "wsl.exe" -Argument $arg
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Day -At $Time

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
  -Description "DevAsk: WSL weekly-scan.sh --yes --push, update docs/backlog.md, open GitHub PR." `
  -Force | Out-Null

Write-Host "已注册任务 $TaskName"
Write-Host "  每周 $Day $Time 执行: wsl.exe $arg"
Write-Host "  查看: schtasks /Query /TN $TaskName /V /FO LIST"
Write-Host "  立刻试跑: schtasks /Run /TN $TaskName"
Write-Host "  删除: Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
