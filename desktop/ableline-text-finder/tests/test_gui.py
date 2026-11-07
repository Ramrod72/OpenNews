"""GUI tests (offscreen Qt)."""

from __future__ import annotations

import pytest

from conftest import write
from textfinder.search import Status
from textfinder.ui.main_window import MainWindow


@pytest.fixture
def window(qtbot, rg, monkeypatch):
    monkeypatch.setattr("textfinder.ui.main_window.QMessageBox.warning", lambda *a, **k: None)
    w = MainWindow()
    qtbot.addWidget(w)
    return w


def run(window, qtbot):
    window.search_btn.click()
    qtbot.waitUntil(lambda: window._last_result is not None, timeout=20_000)
    return window._last_result


def test_gui_search_flow(window, qtbot, folder):
    write(folder / "notes.txt", "Alpha\nbeta GAMMA\n")
    write(folder / "data.csv", "gamma,1\n")
    write(folder / "skip.md", "gamma\n")
    window.folder_edit.setText(str(folder))
    window.query_edit.setText("gamma")
    window.type_chips["txt"].setChecked(True)
    window.other_types.setText("csv")
    result = run(window, qtbot)
    assert result.status is Status.COMPLETE
    assert window.model.rowCount() == 2
    assert window.count_label.text() == "2 matches"
    names = sorted(window.model.data(window.model.index(r, 0)) for r in range(2))
    assert names == ["data.csv", "notes.txt"]
    assert window.search_btn.isEnabled() and not window.cancel_btn.isEnabled()


def test_gui_validation_message(window, qtbot):
    window.folder_edit.setText("")
    window.query_edit.setText("x")
    window.search_btn.click()
    assert "Choose a folder" in window.status_label.text()
    assert window._worker is None


def test_gui_cancel(window, qtbot, folder):
    for i in range(300):
        write(folder / f"f{i}.txt", "match\n" * 300)
    window.folder_edit.setText(str(folder))
    window.query_edit.setText("match")
    window.search_btn.click()
    assert window.cancel_btn.isEnabled()
    window.cancel_search()
    qtbot.waitUntil(lambda: window._last_result is not None, timeout=20_000)
    assert window._last_result.status in (Status.CANCELLED, Status.TRUNCATED, Status.COMPLETE)
    assert window.search_btn.isEnabled()


def test_gui_missing_engine(qtbot):
    w = MainWindow(engine_error="engine missing")
    qtbot.addWidget(w)
    assert not w.search_btn.isEnabled() and not w.banner.isHidden()
