<#
.SYNOPSIS
  vLLM Gateway — Windows Auto-Installer (PowerShell)
.EXAMPLE
  $env:VLLM_REPO = "owner/repo"; irm https://raw.githubusercontent.com/owner/repo/main/install.ps1 | iex
#>

$ErrorActionPreference = "Stop"

$Repo = $env:VLLM_REPO
$InstallDir = if ($env:VLLM_INSTALL_DIR) { $env:VLLM_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "vllm-gateway" }
$DataDir = if ($env:VLLM_DATA_DIR) { $env:VLLM_DATA_DIR } else { Join-Path $env:USERPROFILE ".vllm-gateway" }

if (-not $Repo -and (Get-Command git -ErrorAction SilentlyContinue)) {
  try {
    $origin = git config --get remote.origin.url 2>$null
    if ($origin -match "github\.com[:/]([^/]+/[^/.]+)") {
      $Repo = $Matches[1]
    }
  } catch {}
}

$AssetName = "vllm-gateway-win-x64.zip"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DataDir "models") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DataDir "bin") | Out-Null

$Installed = $false

if ($Repo) {
  $DownloadUrl = "https://github.com/$Repo/releases/latest/download/$AssetName"
  $TmpZip = Join-Path $env:TEMP $AssetName
  Write-Host "==> Downloading vLLM Gateway from $DownloadUrl ..."
  try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $TmpZip -UseBasicParsing
    Expand-Archive -Path $TmpZip -DestinationPath $InstallDir -Force
    Remove-Item $TmpZip -Force
    $Installed = $true
  } catch {
    Write-Warning "Prebuilt release binary not available at $DownloadUrl"
  }
}

if (-not $Installed) {
  if ((Test-Path ".\package.json") -and (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "==> Building standalone Windows binary locally..."
    npm ci
    npm run build:release
    Copy-Item -Path "release-build\*" -Destination $InstallDir -Recurse -Force
    $Installed = $true
  } else {
    throw "Set `$env:VLLM_REPO='owner/repo' to download from GitHub Releases, or run install.ps1 inside the cloned repository with Node.js 22+."
  }
}

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
  Write-Host "Added $InstallDir to User PATH."
}

Write-Host ""
Write-Host "Installation complete!"
Write-Host "  Executable: $(Join-Path $InstallDir 'vllm-gateway.exe')"
Write-Host "  Models dir: $(Join-Path $DataDir 'models')"
Write-Host ""
Write-Host "Run in a new terminal: vllm-gateway.exe"
Write-Host "Then open http://localhost:3000"
