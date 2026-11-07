# Ableline Text Finder

A lightweight, offline Windows app for finding text inside files.
Ableline Text Finder is an **independently developed graphical interface powered by
[ripgrep](https://github.com/BurntSushi/ripgrep)**. Ableline did not create ripgrep and is
not affiliated with its maintainers.

## Using the app

1. **Folder** – click **Browse…** (or type a path). Leave **Include subfolders** ticked to
   search everything below the folder.
2. **Search text** – type a word or phrase and press **Enter** or **Search**. Searches are
   *literal* (characters such as `.` `*` `$` have no special meaning) and *case-insensitive*
   unless you tick **Match case**.
3. **File types** – click any of TXT, CSV, LOG, JSON, XML, MD, PY, JS and/or type others
   (e.g. `html, ini`). Nothing selected = every text file.
4. **Results** – each matching line is listed with file name, full path, line number and
   the matching text. **Double-click** a row (or **Open file**) to open it in its default
   application; **Open containing folder** opens the folder in Explorer. Right-click for
   *Copy file path*. Click a column header to sort.
5. **Cancel** – stops a running search (or press **Esc**). The window stays responsive at
   all times.

The status line always says whether a search was complete, cancelled, stopped at the
result limit, or finished with errors. **Details…** lists files or folders that could not
be read (e.g. access denied).

## Search behaviour

| Behaviour | Default |
|---|---|
| Match type | Literal text (never a regular expression) |
| Case | Case-insensitive (optional *Match case*) |
| Hidden files/folders (dot-files, Windows *hidden* attribute) | Skipped |
| Files excluded by `.gitignore` (inside Git repos), `.ignore`, `.rgignore` | Skipped |
| Binary files | Skipped |
| Symbolic links and junctions | Not followed |
| Encodings | UTF-8/UTF-16 (BOM) detected; invalid bytes shown as `�` |
| Result limit | 10,000 matching lines (search stops and says so) |
| Long lines | Matching text truncated to 1,000 characters for display |
| ripgrep config files (`RIPGREP_CONFIG_PATH`) | Ignored |

PDF, DOCX and other binary document formats are **not** searched in version 1.0.

## Privacy and safety

* Works entirely offline. No telemetry, no accounts, no network access.
* Files are only read, never modified, moved or deleted; file contents are never executed.
* ripgrep runs as a separate process with an argument list (no shell); the query is always
  passed as a literal string.

## Developing

```bash
pip install -r requirements-dev.txt
```

```bash
python packaging/fetch_ripgrep.py   # Windows: pinned + SHA-256 verified rg.exe into vendor/ripgrep
```

```bash
python -m pytest                     # uses vendor/ripgrep, $ABLELINE_RG, or rg on PATH (dev only)
```

```bash
python run.py
```

Windows build (tests + PyInstaller + zip): `packaging\build_windows.ps1`. CI runs the same
script in `.github/workflows/ableline-text-finder-windows.yml` and uploads the artifact
`AblelineTextFinder-windows-x64`.

The packaged app only ever uses its bundled `rg.exe` (never one on PATH).
`AblelineTextFinder.exe --self-test report.json` runs a search with the bundled engine and
writes a JSON report (used by the build's smoke test).

## Licenses

See `licenses/THIRD_PARTY_NOTICES.txt` (ripgrep – MIT/Unlicense, PCRE2 – BSD,
Rust crates – MIT/Apache-2.0, Qt/PySide6 – LGPL-3.0, Python – PSF).
