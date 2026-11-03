"""Application entry point."""

from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication

from ableline import APP_NAME, APP_VERSION
from ableline.magick import MagickError, find_engine
from ableline.ui.main_window import MainWindow
from ableline.ui.styles import STYLESHEET


def main(argv: list[str] | None = None) -> int:
    app = QApplication(sys.argv if argv is None else argv)
    app.setApplicationName(APP_NAME)
    app.setApplicationVersion(APP_VERSION)
    app.setStyle("Fusion")
    app.setStyleSheet(STYLESHEET)

    try:
        engine, error = find_engine(), ""
    except MagickError as exc:
        engine, error = None, str(exc)

    window = MainWindow(engine, error)
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
