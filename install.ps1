# Weft on Windows: Debian in WSL runs Weft's server (install.sh), Windows opens it in the browser.
# In the folder of the downloaded repository, in PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# The first run may install WSL and Debian (Windows asks for administrator rights) and then needs a restart of
# Windows; run it again afterwards. Running it again later repairs or updates the installation.
# Uninstall: wsl -d Debian -u root -- /opt/weft/src/install.sh --remove, then remove the "Weft" shortcuts, the
# scheduled task "Weft server" (Task Scheduler) and the folder %LOCALAPPDATA%\Weft.
$ErrorActionPreference = 'Stop'
$Distro = 'Debian'
$Port = 8790

function Say($text) { Write-Host "weft: $text" }
# wsl.exe prints UTF-16; the names come with NUL characters between the letters.
function Get-Distros { (wsl.exe --list --quiet 2>$null) | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ } }
function Test-Admin { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue) -or -not (Get-Distros | Where-Object { $_ -eq $Distro })) {
  if (-not (Test-Admin)) {
    Say 'Weft needs WSL with Debian; Windows will ask for administrator rights to install it.'
    Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
  }
  Say "installing WSL and $Distro"
  wsl.exe --install --distribution $Distro --no-launch
  if ($LASTEXITCODE -ne 0) { throw "wsl --install failed ($LASTEXITCODE)" }
  if (-not (Get-Distros | Where-Object { $_ -eq $Distro })) {
    # Older WSL registers the distribution only on its first start; as root it asks for no Linux user.
    $launcher = Get-Command debian.exe -ErrorAction SilentlyContinue
    if ($launcher) { & $launcher.Source install --root }
  }
  if (-not (Get-Distros | Where-Object { $_ -eq $Distro })) {
    Say 'Restart Windows, then run install.ps1 again.'
    Read-Host 'Press Enter to close'
    exit
  }
}

$here = (wsl.exe -d $Distro -u root -- wslpath -a ($PSScriptRoot -replace '\\', '/')).Trim()
function Install-Weft { wsl.exe -d $Distro -u root -- bash "$here/install.sh" | Tee-Object -Variable script:out | Write-Host; $LASTEXITCODE }
$code = Install-Weft
if ($code -eq 3) {
  # install.sh switched systemd on; WSL starts the distribution again with it.
  wsl.exe --terminate $Distro | Out-Null
  $code = Install-Weft
}
if ($code -ne 0) { throw "install.sh failed ($code)" }
$url = ($out | Where-Object { $_ -like 'WEFT_URL=*' } | Select-Object -Last 1) -replace '^WEFT_URL=', ''

# WSL stops a distribution soon after its last Windows program ends, and the server with it. A hidden task keeps
# it running from each sign-in to Windows.
# wsl.exe started directly would keep a console window open, so a small script starts it hidden.
$home_dir = Join-Path $env:LOCALAPPDATA 'Weft'
New-Item -ItemType Directory -Force -Path $home_dir | Out-Null
$starter = Join-Path $home_dir 'start-server.vbs'
Set-Content -Path $starter -Encoding ASCII -Value "CreateObject(""WScript.Shell"").Run ""wsl.exe -d $Distro -u root --exec /bin/sleep infinity"", 0, False"
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B `"$starter`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
Register-ScheduledTask -TaskName 'Weft server' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'Weft server'

# A shortcut that opens Weft, on the desktop and in the Start menu.
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $link = $shell.CreateShortcut((Join-Path $dir 'Weft.url'))
  $link.TargetPath = "http://localhost:$Port/"
  $link.Save()
}

Say "Weft runs on http://localhost:$Port/ and updates itself every day."
if ($url) { Start-Process $url }
