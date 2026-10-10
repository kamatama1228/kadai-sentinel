# kadai-sentinel の監視を Windows のログオン時に自動で起動するように登録する
# 使い方(PowerShell で):  powershell -ExecutionPolicy Bypass -File scripts\install-watch.ps1
# 解除するとき:            Unregister-ScheduledTask -TaskName moodle-watch -Confirm:$false

$root = Split-Path -Parent $PSScriptRoot
$pythonw = Join-Path $root ".venv\Scripts\pythonw.exe"
if (-not (Test-Path $pythonw)) {
    Write-Host "先に uv sync を実行してください($pythonw が見つかりません)"; exit 1
}

$action   = New-ScheduledTaskAction -Execute $pythonw -Argument "-m cli.main watch" -WorkingDirectory $root
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
            -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable

Register-ScheduledTask -TaskName "moodle-watch" -Action $action -Trigger $trigger `
    -Settings $settings -Description "kadai-sentinel: 課題・小テストを確認して Discord に通知" -Force | Out-Null
# 動いている古い監視を止めてから起動し直す(二重起動はプログラム側でも防いでいる)
Stop-ScheduledTask -TaskName "moodle-watch" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'pythonw.exe'" |
    Where-Object { $_.CommandLine -like "*cli.main watch*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName "moodle-watch"
Write-Host "登録して起動しました。ログ: $root\state\watch.log"
