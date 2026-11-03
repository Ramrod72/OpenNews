"""Attribution and license text shown in the About dialog."""

from __future__ import annotations

import sys
from pathlib import Path

from ableline import APP_NAME, APP_VERSION

ATTRIBUTION = (
    f"<p><b>{APP_NAME}</b> {APP_VERSION}</p>"
    "<p>An independent, offline image converter. It collects no data and "
    "needs no internet connection or account.</p>"
    "<p>Image processing is performed by <b>ImageMagick</b>, "
    "Copyright &copy; 1999 ImageMagick Studio LLC, used under the "
    "ImageMagick License (included below). ImageMagick is a trademark of "
    "ImageMagick Studio LLC. This application is not affiliated with, "
    "endorsed by, or sponsored by ImageMagick Studio LLC.</p>"
    "<p>The user interface uses Qt for Python (PySide6), licensed under the LGPL v3. "
    "Full third-party notices and license texts are in the <i>licenses</i> folder "
    "next to the application.</p>"
)


def licenses_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "licenses"
    return Path(__file__).resolve().parents[2] / "licenses"


def license_text() -> str:
    path = licenses_dir() / "ImageMagick-LICENSE.txt"
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return "ImageMagick License: https://imagemagick.org/script/license.php"
