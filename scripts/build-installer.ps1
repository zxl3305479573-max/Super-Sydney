param([switch]$Unpacked)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$env:ELECTRON_BUILDER_CACHE = Join-Path $projectRoot '.electron-builder-cache'

Push-Location $projectRoot
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "electron-vite build failed with exit code $LASTEXITCODE" }

  if ($Unpacked) {
    npx --no-install electron-builder --dir --win --x64
  } else {
    npx --no-install electron-builder --win --x64
  }
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}
