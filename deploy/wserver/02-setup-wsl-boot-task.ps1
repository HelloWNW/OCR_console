# Run once, as Administrator, on wserver itself (not over SSH — Register-ScheduledTask
# needs an elevated interactive PowerShell; SSH-ing this is fine too if the session is
# already elevated Administrator, which the SSH login here is).
#
# Confirmed via live check (2026-09-01): the existing "\Docker\StartDocker" task only
# launches Docker Desktop, is tied to user "azumi"'s logon session, and Docker Desktop's
# credential helper breaks once that session isn't interactively alive (that's the exact
# SSH/docker-pull failure that was diagnosed). This task instead boots the separate,
# already-working native Docker Engine inside the Ubuntu-24.04 WSL distro (systemd,
# docker.service already enabled there) — no interactive login required at all.

$action = New-ScheduledTaskAction -Execute "wsl.exe" -Argument "-d Ubuntu-24.04 -u root -- true"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName "WSL-Ubuntu-Boot" `
  -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force

Write-Host "Task registered. Test it now without rebooting:"
Write-Host "  Start-ScheduledTask -TaskName 'WSL-Ubuntu-Boot'"
Write-Host "  wsl -l -v   # Ubuntu-24.04 should show Running"
