<#
.SYNOPSIS
  Builds the Windows distribution of Ableline Image Converter.

.PARAMETER ImageMagickDir
  Folder containing the extracted ImageMagick 7 *portable* Windows build
  (e.g. ImageMagick-7.1.x-portable-Q16-x64), which must contain magick.exe.
  Omit to build without bundling ImageMagick (it must then be on PATH).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File packaging\build_windows.ps1 -ImageMagickDir C:\Downloads\ImageMagick-7.1.2-portable-Q16-x64
#>
param(
    [string]$ImageMagickDir = ""
)
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

# 2. Stage ImageMagick into vendor\imagemagick with our restrictive policy
$Vendor = Join-Path $Root "vendor\imagemagick"
if ($ImageMagickDir) {
    if (-not (Test-Path (Join-Path $ImageMagickDir "magick.exe"))) {
        throw "magick.exe not found in $ImageMagickDir (use the *portable* ImageMagick 7 build)."
    }
    if (Test-Path $Vendor) { Remove-Item -Recurse -Force $Vendor }
    New-Item -ItemType Directory -Force -Path $Vendor | Out-Null
    Copy-Item -Recurse -Force (Join-Path $ImageMagickDir "*") $Vendor
    # Our policy replaces the stock one so it is always the effective policy.
    Copy-Item -Force "src\ableline\resources\policy.xml" (Join-Path $Vendor "policy.xml")
    # Ship ImageMagick's own license/notice files (third-party library notices).
    foreach ($f in @("LICENSE.txt", "NOTICE.txt", "ChangeLog.md")) {
        $src = Join-Path $ImageMagickDir $f
        if (Test-Path $src) { Copy-Item -Force $src (Join-Path "licenses" ("ImageMagick-" + $f)) }
    }
    & (Join-Path $Vendor "magick.exe") -version
}

# 3. Tests (against the staged ImageMagick when present)
if (Test-Path (Join-Path $Vendor "magick.exe")) { $env:ABLELINE_MAGICK = Join-Path $Vendor "magick.exe" }
& $Py -m pytest -q
if ($LASTEXITCODE -ne 0) { throw "Tests failed." }
Remove-Item Env:\ABLELINE_MAGICK -ErrorAction SilentlyContinue

# 4. Package
& $Py -m PyInstaller packaging\ableline.spec --noconfirm --clean
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed." }
# Put license notices at the top level of the distribution, where users see them.
Copy-Item -Recurse -Force "licenses" "dist\AblelineImageConverter\licenses"
Write-Host "`nBuilt: $Root\dist\AblelineImageConverter\AblelineImageConverter.exe"
