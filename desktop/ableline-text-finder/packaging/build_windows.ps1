<#
.SYNOPSIS
  Builds the Windows distribution of Ableline Text Finder.
  Downloads + verifies the pinned ripgrep, runs tests, packages with PyInstaller,
  and creates dist\AblelineTextFinder-windows-x64.zip.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File packaging\build_windows.ps1
#>
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

# 1. Virtual environment with build tooling
if (-not (Test-Path ".venv")) {
    if (Get-Command py -ErrorAction SilentlyContinue) { py -3.12 -m venv .venv } else { python -m venv .venv }
}
$Py = Join-Path $Root ".venv\Scripts\python.exe"
& $Py -m pip install --upgrade pip
& $Py -m pip install -r requirements-dev.txt
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }

# 2. Official ripgrep, pinned version, SHA-256 verified
& $Py packaging\fetch_ripgrep.py
if ($LASTEXITCODE -ne 0) { throw "ripgrep download/verification failed." }
$Rg = Join-Path $Root "vendor\ripgrep\rg.exe"
& $Rg --version

# 3. Tests against the exact rg.exe that will be bundled
$env:ABLELINE_RG = $Rg
New-Item -ItemType Directory -Force -Path "dist" | Out-Null
& $Py -m pytest -v --junitxml=dist\test-results.xml 2>&1 | Tee-Object -FilePath dist\test-results.txt
if ($LASTEXITCODE -ne 0) { throw "Tests failed." }
Remove-Item Env:\ABLELINE_RG -ErrorAction SilentlyContinue

# 4. Package
& $Py -m PyInstaller packaging\textfinder.spec --noconfirm --clean
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed." }
$App = "dist\AblelineTextFinder"
Copy-Item -Recurse -Force "licenses" "$App\licenses"
Copy-Item -Force "vendor\ripgrep\VERSION.txt" "$App\licenses\ripgrep-VERSION.txt"
Copy-Item -Force "README.md" "$App\README.md"
if (-not (Test-Path "$App\_internal\ripgrep\rg.exe")) { throw "rg.exe missing from the package." }

$Zip = "dist\AblelineTextFinder-windows-x64.zip"
if (Test-Path $Zip) { Remove-Item -Force $Zip }
Compress-Archive -Path $App -DestinationPath $Zip
Write-Host "`nBuilt: $Root\$App\AblelineTextFinder.exe"
Write-Host "Zip:   $Root\$Zip"
