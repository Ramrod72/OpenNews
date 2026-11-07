"""Application entry point."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

from textfinder import APP_NAME, APP_VERSION, ORG_NAME
from textfinder.search import RipgrepNotFound, Status, bundled_rg_path, find_rg, rg_version, run_search, validate


def self_test(report_path: str) -> int:
    """Non-interactive check used by the build: runs a real search with the
    bundled ripgrep and writes a JSON report. Exit code 0 means success."""
    report: dict = {"app": APP_NAME, "version": APP_VERSION, "frozen": bool(getattr(sys, "frozen", False))}
    ok = False
    try:
        rg = find_rg()
        report["rg_path"] = str(rg)
        report["rg_is_bundled"] = rg.resolve() == bundled_rg_path().resolve()
        report["rg_version"] = rg_version(rg)
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "Self test – Ünïcødé"
            folder.mkdir()
            (folder / "résumé notes.txt").write_text("Hello World\nnothing\nhello again\n", encoding="utf-8")
            (folder / "skip.bin").write_bytes(b"hello\x00binary")
            result = run_search(validate(folder, "HELLO", extensions="txt"))
            report["status"] = result.status.value
            report["matches"] = result.match_count
            report["errors"] = result.errors
            ok = result.status is Status.COMPLETE and result.match_count == 2
            if report["frozen"]:
                ok = ok and report["rg_is_bundled"]
    except (RipgrepNotFound, OSError, ValueError) as exc:
        report["exception"] = str(exc)
    report["ok"] = ok
    Path(report_path).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv if argv is None else argv)
    if len(argv) >= 3 and argv[1] == "--self-test":
        return self_test(argv[2])

    from PySide6.QtWidgets import QApplication

    from textfinder.ui.main_window import MainWindow
    from textfinder.ui.styles import STYLESHEET

    app = QApplication(argv)
    app.setApplicationName(APP_NAME)
    app.setOrganizationName(ORG_NAME)
    app.setApplicationVersion(APP_VERSION)
    app.setStyle("Fusion")
    app.setStyleSheet(STYLESHEET)

    try:
        find_rg()
        error = ""
    except RipgrepNotFound as exc:
        error = str(exc)

    window = MainWindow(engine_error=error)
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
