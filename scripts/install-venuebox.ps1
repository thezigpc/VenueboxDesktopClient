<#
.SYNOPSIS
  Installs (or updates) the Venuebox desktop client on a Windows PC or laptop and points it at a box.

.DESCRIPTION
  1. Turns on TLS 1.2 for this PowerShell session (old Windows 10 / PowerShell 5.1 defaults
     can't reach GitHub without it). Nothing system-wide changes.
  2. Gets the installer: -InstallerPath (a file you copied over), or the latest GitHub release.
     The installer is a self-contained .exe: no Git, Node or other runtime is needed.
  3. Closes a running Venuebox, installs silently for the current user into -InstallDir
     (default C:\VenueboxDesktopClient; no admin needed). A copy installed somewhere else
     (e.g. the old default under %LOCALAPPDATA%\Programs) is uninstalled first; the pairing
     and settings in %APPDATA%\Venuebox are kept.
  4. Checks the box answers on port 7210, then starts Venuebox with that box address.
     The screen shows a 6-digit code: type it on the box's TVs page -> Venuebox apps.
  5. Optional (-KeepAwake): a laptop driving a TV stays on with the lid closed while plugged in.

  Venuebox starts at login by itself (set on first run); change it in its settings window
  (tray icon, or Ctrl+Alt+Shift+V).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-venuebox.ps1 -Box 192.168.1.20 -KeepAwake

.EXAMPLE
  # Installer already copied to the laptop:
  powershell -ExecutionPolicy Bypass -File .\install-venuebox.ps1 -InstallerPath .\Venuebox-Setup-0.1.0.exe -Box 100.64.0.10
#>
[CmdletBinding()]
param(
  # Box address: "192.168.1.20" (port 7210 is added) or "http://host:port". Optional: without it,
  # Venuebox finds the box on the network (box 0.16.2+); use it when discovery is blocked.
  [string]$Box,
  # A local installer .exe; skips the download.
  [string]$InstallerPath,
  # GitHub repository holding the releases.
  [string]$Repo = "thezigpc/VenueboxDesktopClient",
  # Only for a private repository: a GitHub token with read access to it.
  [string]$GitHubToken,
  # Where the app goes. A per-user install: no admin needed (Windows lets users create C:\ folders).
  [string]$InstallDir = "C:\VenueboxDesktopClient",
  # Laptop: don't sleep, and do nothing when the lid closes, while on AC power.
  [switch]$KeepAwake
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is very slow with the progress bar on PS 5.1
function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }

# ---------------------------------------------------------------- 1. TLS 1.2
Step "Enabling TLS 1.2 for downloads"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# ---------------------------------------------------------------- 2. get the installer
$work = Join-Path $env:TEMP "venuebox-install"
New-Item -ItemType Directory -Force -Path $work | Out-Null

if ($InstallerPath) {
  $installer = (Resolve-Path $InstallerPath).Path
  Step "Using installer $installer"
} else {
  Step "Finding the latest release of $Repo"
  $headers = @{ "User-Agent" = "venuebox-installer"; "Accept" = "application/vnd.github+json" }
  if ($GitHubToken) { $headers["Authorization"] = "Bearer $GitHubToken" }
  try {
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $headers -UseBasicParsing
  } catch {
    throw "Couldn't read the releases of $Repo ($($_.Exception.Message)). Private repo? Pass -GitHubToken, or copy the installer over and use -InstallerPath."
  }
  $asset = $rel.assets | Where-Object { $_.name -like "*Setup*.exe" } | Select-Object -First 1
  if (-not $asset) { throw "Release $($rel.tag_name) has no Setup .exe" }
  $installer = Join-Path $work $asset.name
  Step "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB)) MB, release $($rel.tag_name))"
  Remove-Item $installer -Force -ErrorAction SilentlyContinue
  # Public repo: the plain download link. Private (token): the API asset URL, which redirects.
  $url = if ($GitHubToken) { $asset.url } else { $asset.browser_download_url }
  # curl.exe (in Windows 10 1803+) is ~50x faster than Invoke-WebRequest on PowerShell 5.1.
  $curl = Join-Path $env:SystemRoot "System32\curl.exe"
  if (Test-Path $curl) {
    $cargs = @("-fL", "--retry", "3", "-sS", "-H", "User-Agent: venuebox-installer", "-o", $installer)
    if ($GitHubToken) { $cargs += @("-H", "Accept: application/octet-stream", "-H", "Authorization: Bearer $GitHubToken") }
    & $curl @cargs $url
    if ($LASTEXITCODE -ne 0) { Remove-Item $installer -Force -ErrorAction SilentlyContinue; Warn "curl.exe failed (exit $LASTEXITCODE): trying another way" }
  }
  if (-not (Test-Path $installer) -and -not $GitHubToken -and (Get-Command Start-BitsTransfer -ErrorAction SilentlyContinue)) {
    try { Start-BitsTransfer -Source $url -Destination $installer -ErrorAction Stop } catch { Warn "BITS failed: $($_.Exception.Message)" }
  }
  if (-not (Test-Path $installer)) {
    $dl = @{ "User-Agent" = "venuebox-installer"; "Accept" = "application/octet-stream" }
    if ($GitHubToken) { $dl["Authorization"] = "Bearer $GitHubToken" }
    Invoke-WebRequest -Uri $url -Headers $dl -OutFile $installer -UseBasicParsing
  }
  $got = (Get-Item $installer).Length
  if ($got -ne $asset.size) { throw "The download is incomplete ($got of $($asset.size) bytes). Run this again." }
  Ok "Saved to $installer"
}
Unblock-File -Path $installer   # drop the downloaded-from-internet mark (fewer SmartScreen prompts)

# ---------------------------------------------------------------- 3. install
Step "Closing Venuebox if it's running"
Get-Process -Name "Venuebox" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
# An existing install elsewhere: remove it so there's one copy (settings/pairing are kept).
$old = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
  Get-ItemProperty | Where-Object { $_.DisplayName -like "Venuebox*" -and $_.QuietUninstallString } | Select-Object -First 1
if ($old -and $old.QuietUninstallString -match '^"([^"]+)"') {
  $oldUninstaller = $Matches[1]
  $oldDir = Split-Path $oldUninstaller -Parent
  if ($oldDir.TrimEnd('\') -ne $InstallDir -and (Test-Path $oldUninstaller)) {
    Step "Removing the copy installed in $oldDir"
    Start-Process -FilePath $oldUninstaller -ArgumentList "/currentuser", "/S" -Wait | Out-Null
    Start-Sleep -Seconds 3
  }
}

Step "Installing to $InstallDir (current user, silent)"
# NSIS: /D= must come last and must not be quoted, even with spaces in the path.
$p = Start-Process -FilePath $installer -ArgumentList "/S /D=$InstallDir" -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "The installer failed (exit code $($p.ExitCode))" }

$exe = Join-Path $InstallDir "Venuebox.exe"
if (-not (Test-Path $exe)) { throw "Installed, but $exe isn't there" }
Ok "Installed: $exe"
# The installer may have started it; restart below with the box address.
Start-Sleep -Seconds 2
Get-Process -Name "Venuebox" -ErrorAction SilentlyContinue | Stop-Process -Force

# ---------------------------------------------------------------- 4. box + start
$appArgs = @()
if ($Box) {
  $hostPart = $Box -replace '^[a-z]+://', '' -replace '/.*$', ''
  $port = 7210
  if ($hostPart -match '^(.+):(\d+)$') { $hostPart = $Matches[1]; $port = [int]$Matches[2] }
  Step "Checking the box at ${hostPart}:$port"
  $url = if ($Box -match '^[a-z]+://') { $Box.TrimEnd('/') } else { "http://${hostPart}:$port" }
  try {
    $h = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 5 -UseBasicParsing
    if ($h.ok) { Ok "Found `"$($h.box)`" (protocol $($h.protocol))" } else { Warn "Something answered, but it isn't a Venuebox box." }
  } catch {
    Warn "No answer from $url/health. Venuebox will keep trying, but check: same network as the box,"
    Warn "the box's firewall allows TCP $port from this network, and the address is right."
  }
  $appArgs += "--box=$Box"
} else {
  Ok "No -Box given: Venuebox looks for the box on this network (and uses it if there's exactly one)."
  Ok "If it isn't found (guest Wi-Fi keeps devices apart), type its address in the settings window."
}

# ---------------------------------------------------------------- 5. laptop power
if ($KeepAwake) {
  Step "Keeping this laptop awake on AC power (lid closed does nothing, no sleep, screen stays on)"
  try {
    powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 | Out-Null
    powercfg /change standby-timeout-ac 0 | Out-Null
    powercfg /change monitor-timeout-ac 0 | Out-Null
    powercfg /change hibernate-timeout-ac 0 | Out-Null
    powercfg /setactive SCHEME_CURRENT | Out-Null
    Ok "Done (battery settings unchanged)."
  } catch {
    Warn "Couldn't change power settings ($($_.Exception.Message)); set them in Settings > System > Power."
  }
}

Step "Starting Venuebox"
if ($appArgs.Count) { Start-Process -FilePath $exe -ArgumentList $appArgs } else { Start-Process -FilePath $exe }
Ok "Running. Already paired: it reconnects by itself. Not paired yet: each screen shows a 6-digit code;"
Ok "on the box, open the TVs page -> Venuebox apps and type it."
Ok "Settings: tray icon, or Ctrl+Alt+Shift+V. Log: $env:APPDATA\Venuebox\venuebox.log"
