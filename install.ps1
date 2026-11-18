<#
.SYNOPSIS
  vLLM Gateway — Windows Auto-Installer (PowerShell)
.EXAMPLE
  $env:VLLM_REPO = "your-org/your-repo"; irm https://raw.githubusercontent.com/your-org/your-repo/main/install.ps1 | iex
.EXAMPLE
  .\install.ps1 -Uninstall
#>

param(
  [switch]$Uninstall,
  [switch]$Purge
)

$ErrorActionPreference = "Stop"

$Repo = $env:VLLM_REPO
$InstallDir = if ($env:VLLM_INSTALL_DIR) { $env:VLLM_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "vllm-gateway" }
$DataDir = if ($env:VLLM_DATA_DIR) { $env:VLLM_DATA_DIR } else { Join-Path $env:USERPROFILE ".vllm-gateway" }

if ($Uninstall) {
  Write-Host "==> Uninstalling vLLM Gateway..."
  if (Test-Path $InstallDir) {
    Remove-Item -Path $InstallDir -Recurse -Force
  }
  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($UserPath -and $UserPath -like "*$InstallDir*") {
    $Cleaned = ($UserPath -split ";" | Where-Object { $_ -and $_ -ne $InstallDir }) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $Cleaned, "User")
  }
  if ($Purge -and (Test-Path $DataDir)) {
    Remove-Item -Path $DataDir -Recurse -Force
    Write-Host "Removed binary and $DataDir."
  } else {
    Write-Host "Removed binary. Preserved models and config in $DataDir (use -Purge to delete)."
  }
  exit 0
}

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
New-Item -ItemType Directory -Force -Path (Join-Path $DataDir "archives") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $DataDir "logs") | Out-Null

$Installed = $false

if ($Repo) {
  $InstallerName = "vllm-gateway-setup-win-x64.exe"
  $InstallerUrl = "https://github.com/$Repo/releases/latest/download/$InstallerName"
  $TmpInstaller = Join-Path $env:TEMP $InstallerName
  Write-Host "==> Downloading Windows installer from $InstallerUrl ..."
  try {
    Invoke-WebRequest -Uri $InstallerUrl -OutFile $TmpInstaller -UseBasicParsing
    $process = Start-Process -FilePath $TmpInstaller -ArgumentList @("/DIR=`"$InstallDir`"", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART") -Wait -PassThru
    if ($process.ExitCode -ne 0) {
      throw "Windows installer exited with code $($process.ExitCode)"
    }
    Remove-Item $TmpInstaller -Force
    $Installed = $true
  } catch {
    Write-Warning "Prebuilt Windows installer not available; trying portable ZIP."
    if (Test-Path $TmpInstaller) { Remove-Item $TmpInstaller -Force }
  }
}

if (-not $Installed -and $Repo) {
  $DownloadUrl = "https://github.com/$Repo/releases/latest/download/$AssetName"
  $SumsUrl = "https://github.com/$Repo/releases/latest/download/SHA256SUMS.txt"
  $TmpZip = Join-Path $env:TEMP $AssetName
  $TmpSums = Join-Path $env:TEMP "vllm-SHA256SUMS.txt"
  Write-Host "==> Downloading vLLM Gateway from $DownloadUrl ..."
  try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $TmpZip -UseBasicParsing
    try {
      Invoke-WebRequest -Uri $SumsUrl -OutFile $TmpSums -UseBasicParsing
      $ExpectedLine = Get-Content $TmpSums | Where-Object { $_ -match "\s+$AssetName$" } | Select-Object -First 1
      if ($ExpectedLine) {
        $ExpectedHash = ($ExpectedLine -split "\s+")[0].ToUpperInvariant()
        $ActualHash = (Get-FileHash -Path $TmpZip -Algorithm SHA256).Hash.ToUpperInvariant()
        if ($ActualHash -ne $ExpectedHash) {
          throw "SHA-256 checksum mismatch for $AssetName!"
        }
        Write-Host "==> SHA-256 checksum verified."
      }
    } catch {
      if ($_.Exception.Message -like "*checksum mismatch*") { throw }
    }
    Expand-Archive -Path $TmpZip -DestinationPath $InstallDir -Force
    Remove-Item $TmpZip -Force -ErrorAction SilentlyContinue
    Remove-Item $TmpSums -Force -ErrorAction SilentlyContinue
    $Installed = $true
  } catch {
    Write-Warning "Prebuilt release binary not available or verification failed: $($_.Exception.Message)"
  }
}

if (-not $Installed) {
  if ((Test-Path ".\package.json") -and (Get-Command node -ErrorAction SilentlyContinue) -and (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host "==> Building standalone Windows binary locally..."
    bun install --frozen-lockfile
    bun run build:release
    Copy-Item -Path "release-build\*" -Destination $InstallDir -Recurse -Force
    $Installed = $true
  } else {
    throw "Set `$env:VLLM_REPO='owner/repo' to download from GitHub Releases, or run install.ps1 inside the cloned repository with Node.js 22+ and Bun."
  }
}

# Copy bundled vendor\llama-server archives (if provided) into DataDir\archives and unpack any matching win zip
$ArchiveCandidates = @(
  (Join-Path (Get-Location) "vendor\llama-server"),
  (Join-Path $InstallDir "vendor\llama-server")
)
foreach ($VendorDir in $ArchiveCandidates) {
  if (Test-Path $VendorDir) {
    Get-ChildItem -Path $VendorDir -File | Where-Object { $_.Extension -in ".zip", ".tgz", ".gz" } | ForEach-Object {
      $DestArchive = Join-Path (Join-Path $DataDir "archives") $_.Name
      Copy-Item -Path $_.FullName -Destination $DestArchive -Force
      Write-Host "==> Copied llama-server archive to $DestArchive"
      if ($_.Extension -eq ".zip" -and $_.Name -match "win") {
        $TmpExtract = Join-Path $env:TEMP ("llama-extract-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $TmpExtract | Out-Null
        try {
          Expand-Archive -Path $DestArchive -DestinationPath $TmpExtract -Force
          $ServerExe = Get-ChildItem -Path $TmpExtract -Recurse -Filter "llama-server.exe" | Select-Object -First 1
          if ($ServerExe) {
            Get-ChildItem -Path $ServerExe.DirectoryName -File | Where-Object {
              $_.Name -eq "llama-server.exe" -or $_.Extension -eq ".dll"
            } | ForEach-Object {
              Copy-Item -Path $_.FullName -Destination (Join-Path (Join-Path $DataDir "bin") $_.Name) -Force
            }
            Write-Host "==> Unpacked llama-server.exe + DLLs to $(Join-Path $DataDir 'bin')"
          }
        } finally {
          Remove-Item -Path $TmpExtract -Recurse -Force -ErrorAction SilentlyContinue
        }
      }
    }
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
Write-Host "  Data dir:   $DataDir"
Write-Host "  Models dir: $(Join-Path $DataDir 'models')"
Write-Host "  Archives:   $(Join-Path $DataDir 'archives')"
Write-Host ""
Write-Host "Run in a new terminal: vllm-gateway.exe"
Write-Host "Then open http://localhost:3000"
