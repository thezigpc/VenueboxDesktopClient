<#
.SYNOPSIS
  Updates an installed Venuebox to the latest release, keeping its pairing and settings.

.DESCRIPTION
  For copies older than 0.3.0 (they can't update themselves). From 0.3.0 on, Venuebox checks
  for updates by itself and asks before installing; this script still works any time.

  Shows the installed and latest versions, then (if newer) runs install-venuebox.ps1 from the
  same repository without -Box, so the box, the pairing and the settings in %APPDATA%\Venuebox
  stay as they are. The app ends up in -InstallDir (default C:\VenueboxDesktopClient); a copy
  installed elsewhere is moved there.

.EXAMPLE
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; & ([scriptblock]::Create((irm https://raw.githubusercontent.com/thezigpc/VenueboxDesktopClient/main/scripts/update-venuebox.ps1)))
#>
[CmdletBinding()]
param(
  [string]$Repo = "thezigpc/VenueboxDesktopClient",
  [string]$InstallDir = "C:\VenueboxDesktopClient",
  # Reinstall even if it's already the latest version.
  [switch]$Force,
  # Passed on to the installer: laptop stays awake on AC power.
  [switch]$KeepAwake
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }

$entry = Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
  Get-ItemProperty | Where-Object { $_.DisplayName -like "Venuebox*" } | Select-Object -First 1
if (-not $entry) { throw "Venuebox isn't installed for this Windows user. Use install-venuebox.ps1 instead." }
$installed = [version]($entry.DisplayVersion)
$where = if ($entry.QuietUninstallString -match '^"([^"]+)"') { Split-Path $Matches[1] -Parent } else { "?" }
Step "Installed: Venuebox $installed in $where"

$rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "venuebox-installer" } -UseBasicParsing
$latest = [version]($rel.tag_name -replace '^v', '')
Step "Latest release: $latest"

if ($installed -ge $latest -and -not $Force) {
  Ok "Already up to date. (Use -Force to reinstall.)"
  return
}

Step "Updating $installed -> $latest (the box, pairing and settings are kept)"
# ?t= skips GitHub's 5-minute raw cache, so a just-pushed fix is used at once.
$script = Invoke-RestMethod -Uri "https://raw.githubusercontent.com/$Repo/main/scripts/install-venuebox.ps1?t=$([DateTime]::UtcNow.Ticks)" -UseBasicParsing
$params = @{ Repo = $Repo; InstallDir = $InstallDir }
if ($KeepAwake) { $params.KeepAwake = $true }
& ([scriptblock]::Create($script)) @params
