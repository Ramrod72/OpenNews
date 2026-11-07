"""Attribution text shown in the About dialog."""

from __future__ import annotations

import sys
from pathlib import Path

from textfinder import APP_NAME, APP_VERSION

ATTRIBUTION = (
    f"<p><b>{APP_NAME}</b> {APP_VERSION}</p>"
    "<p>An independently developed graphical interface for searching text "
    "inside files. It works entirely offline, collects no data, and never "
    "modifies the files it searches.</p>"
    "<p>Searching is <b>powered by ripgrep</b>, created by Andrew Gallant "
    "(Copyright &copy; 2015 Andrew Gallant), used under the MIT License "
    "(ripgrep is dual-licensed under the MIT License and the Unlicense). "
    "Ableline is not affiliated with, endorsed by, or sponsored by the "
    "ripgrep project or its maintainers.</p>"
    "<p>The bundled ripgrep binary includes the PCRE2 library "
    "(BSD licence, Copyright &copy; University of Cambridge and Philip Hazel) "
    "and Rust libraries under MIT/Apache-2.0 licenses.</p>"
    "<p>The user interface uses Qt for Python (PySide6), licensed under the "
    "GNU LGPL v3. Full third-party notices and license texts are in the "
    "<i>licenses</i> folder next to the application.</p>"
)


def licenses_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent / "licenses"
    return Path(__file__).resolve().parents[2] / "licenses"
