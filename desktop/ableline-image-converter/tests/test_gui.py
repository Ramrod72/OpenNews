"""Smoke tests of the window, run headless (QT_QPA_PLATFORM=offscreen)."""

import pytest

pytest.importorskip("PySide6")
pytest.importorskip("pytestqt")

from helpers import write_png  # noqa: E402
from ableline.ui.main_window import MainWindow  # noqa: E402


@pytest.fixture
def window(qtbot, engine):
    w = MainWindow(engine)
    qtbot.addWidget(w)
    return w


def test_add_files_filters_unsupported(window, src_dir):
    a = write_png(src_dir / "a.png", 4, 4)
    txt = src_dir / "b.txt"
    txt.write_text("x")
    window.add_paths([a, txt, a])
    assert window.queued_files() == [a.resolve()]
    assert "Skipped 1" in window.status.text()
    assert window.convert_btn.isEnabled()


def test_quality_disabled_for_png(window):
    window.format_combo.setCurrentIndex(window.format_combo.findData("png"))
    assert not window.quality_slider.isEnabled()
    window.format_combo.setCurrentIndex(window.format_combo.findData("webp"))
    assert window.quality_slider.isEnabled()


def test_missing_output_folder_is_reported(window, src_dir, monkeypatch):
    shown = []
    monkeypatch.setattr("ableline.ui.main_window.QMessageBox.warning", lambda *a: shown.append(a))
    window.add_paths([write_png(src_dir / "a.png", 4, 4)])
    assert window.start_conversion() is False
    assert "output folder" in window.status.text()
    assert shown


def test_full_conversion_in_background(window, qtbot, src_dir, out_dir):
    files = [write_png(src_dir / f"p{i}.png", 50, 40) for i in range(3)]
    window.add_paths(files)
    window.output_edit.setText(str(out_dir))
    window.format_combo.setCurrentIndex(window.format_combo.findData("jpg"))
    window.resize_combo.setCurrentIndex(window.resize_combo.findData("percent"))
    assert window.start_conversion()
    assert window.convert_btn.text() == "Cancel"
    with qtbot.waitSignal(window.worker.batch_done, timeout=30_000):
        pass
    qtbot.waitUntil(lambda: window.worker is None, timeout=5000)
    assert window.progress.value() == 3
    assert "3 converted" in window.status.text()
    assert sorted(p.name for p in out_dir.iterdir()) == ["p0.jpg", "p1.jpg", "p2.jpg"]
    assert window.convert_btn.text() == "Convert Images"


def test_runs_without_engine(qtbot):
    w = MainWindow(None, "ImageMagick was not found.")
    qtbot.addWidget(w)
    assert not w.convert_btn.isEnabled()
