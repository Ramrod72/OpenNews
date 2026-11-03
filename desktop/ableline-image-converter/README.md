# Ableline Image Converter

A small, offline Windows desktop app for batch converting, resizing and
compressing images. It is a GUI for [ImageMagick 7](https://imagemagick.org),
which does all of the image processing.

- Drag and drop images (or click to browse); dropping a folder adds the images directly inside it
- Convert between **PNG, JPG, WebP, BMP and TIFF**
- Resize by **percentage** or **dimensions** (aspect ratio kept by default)
- **Quality** 1–100 for JPG and WebP (the formats where it applies)
- Output folder, progress bar, per-file ✓/✗ and an error summary

No accounts, telemetry, network access or updates. Everything runs locally.

> Ableline Image Converter is an independent product and is not affiliated
> with, endorsed by, or sponsored by ImageMagick Studio LLC.

## Safety guarantees

- **Originals are never modified.** ImageMagick works on a private copy in a temp folder.
- **Nothing is ever overwritten.** Output names are reserved with exclusive creation;
  collisions become `photo (1).jpg`, `photo (2).jpg`, …
- Inputs must be regular local files whose **content** (magic bytes) matches a
  supported format and agrees with the extension. Size limit: 500 MB per file.
- ImageMagick runs via `subprocess` with an **argument list (never a shell)**,
  explicit coder prefixes (`PNG:input.png`) and fixed temp names, so filenames
  containing `[ ] % @ :` can't be misinterpreted.
- A restrictive [`policy.xml`](src/ableline/resources/policy.xml) allows only the five
  coders, disables all delegates, filters and indirect `@file` reads, and limits
  memory, disk, dimensions, threads and time. The same limits are also passed as
  `-limit` arguments. Each file has a 5-minute timeout.
- Conversion runs on a background thread; the window stays responsive and **Cancel** stops the current file immediately.

## Get the Windows build (no local setup)

Every push that changes this folder runs the GitHub Actions workflow
**Ableline Image Converter (Windows build)** (`.github/workflows/ableline-windows.yml`). It:

1. downloads the latest ImageMagick 7 portable Q16 x64 build from the official
   [ImageMagick GitHub Releases](https://github.com/ImageMagick/ImageMagick/releases)
   and verifies it against the SHA-256 digest GitHub publishes for the asset,
2. runs the full test suite on Windows against that ImageMagick,
3. builds the app with PyInstaller and checks that the `.exe` starts,
4. uploads **AblelineImageConverter-windows-x64** as a downloadable artifact.

Download the artifact from the workflow run, unzip it, and run
`AblelineImageConverter.exe`. You can also start the workflow by hand from the
Actions tab (**Run workflow**).

## Run from source (Windows 10/11)

Requirements: Python 3.12, and ImageMagick 7 installed with `magick` on PATH
(or a portable build in `vendor\imagemagick\`).

```powershell
py -3.12 -m venv .venv
.venv\Scripts\pip install -r requirements-dev.txt
.venv\Scripts\python run.py
```

Engine lookup order: `ABLELINE_MAGICK` environment variable (path to `magick.exe`)
→ bundled `imagemagick\magick.exe` → `magick` on PATH. On Linux/macOS the
ImageMagick 6 `convert` command is also accepted, for development only; it is never
used on Windows, where `convert.exe` is an unrelated system tool.

## Tests

```powershell
.venv\Scripts\python -m pytest -q
```

The tests cover conversion between all formats, resizing modes, quality, batch
processing, cancellation, timeouts, collisions, the security policy, error
handling and a headless GUI run. Tests that need ImageMagick are skipped if it
isn't installed.

## Build the Windows executable locally

1. Download the **portable** ImageMagick 7 build (`ImageMagick-7.x.x-portable-Q16-x64`)
   from the official [ImageMagick GitHub Releases](https://github.com/ImageMagick/ImageMagick/releases),
   check its SHA-256 (shown next to the asset), and extract it.
2. Run:

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build_windows.ps1 -ImageMagickDir C:\path\to\ImageMagick-7.x.x-portable-Q16-x64
```

The script creates `.venv`, copies ImageMagick into `vendor\imagemagick`,
**replaces its `policy.xml` with ours**, copies ImageMagick's license/notice files
into `licenses\`, runs the tests and builds `dist\AblelineImageConverter\`.
Distribute that whole folder (zip it or wrap it in an installer).

## Licenses and distribution

- App license notices: `licenses/THIRD_PARTY_NOTICES.txt`
- ImageMagick License: `licenses/ImageMagick-LICENSE.txt` (also shown under **About & licenses** in the app)
- Qt for Python (PySide6): LGPL v3, `licenses/LGPL-3.0.txt` and `licenses/GPL-3.0.txt`.
  The one-folder build keeps the Qt libraries as separate, replaceable files, as the LGPL requires.

The build copies `licenses/` to the top level of the distribution folder.

## Project layout

```
src/ableline/
  app.py            entry point
  formats.py        the 5 supported formats + magic-byte sniffing
  validation.py     input file + settings validation
  naming.py         collision-free output names (exclusive create)
  inputs.py         collecting dropped/selected files
  magick.py         locating and safely invoking ImageMagick
  converter.py      single-file and batch conversion (no GUI code)
  worker.py         QThread wrapper so the GUI never blocks
  about.py          attribution text
  resources/policy.xml
  ui/               main window, drop area, stylesheet
tests/              pytest suite
packaging/          PyInstaller spec + Windows build script
licenses/           license texts shipped with the app
```
