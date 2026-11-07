"""The single main window of Ableline Text Finder."""

from __future__ import annotations

import os
from pathlib import Path

from PySide6.QtCore import QSettings, QSortFilterProxyModel, Qt, QUrl
from PySide6.QtGui import QAction, QDesktopServices, QKeySequence
from PySide6.QtWidgets import (
    QAbstractItemView, QCheckBox, QFileDialog, QFrame, QHBoxLayout, QHeaderView, QLabel,
    QLineEdit, QMainWindow, QMenu, QMessageBox, QProgressBar, QPushButton, QTableView,
    QVBoxLayout, QWidget,
)

from textfinder import APP_NAME
from textfinder.about import ATTRIBUTION, licenses_dir
from textfinder.search import SearchError, SearchResult, Status, parse_extensions, validate
from textfinder.ui.results_model import ResultsModel
from textfinder.worker import SearchWorker

PRESET_EXTENSIONS = ("txt", "csv", "log", "json", "xml", "md", "py", "js")


def _card() -> tuple[QFrame, QVBoxLayout]:
    frame = QFrame()
    frame.setObjectName("Card")
    lay = QVBoxLayout(frame)
    lay.setContentsMargins(16, 14, 16, 14)
    lay.setSpacing(10)
    return frame, lay


class MainWindow(QMainWindow):
    def __init__(self, engine_error: str = "", parent=None):
        super().__init__(parent)
        self.setWindowTitle(APP_NAME)
        self.resize(1100, 760)
        self.setMinimumSize(760, 560)
        self._worker: SearchWorker | None = None
        self._last_result: SearchResult | None = None
        self._settings = QSettings()
        self._build_ui()
        if engine_error:
            self.banner.setText(engine_error)
            self.banner.show()
            self.search_btn.setEnabled(False)
        last = self._settings.value("last_folder", "", str)
        if last and Path(last).is_dir():
            self.folder_edit.setText(last)

    # ------------------------------------------------------------------ layout

    def _build_ui(self) -> None:
        central = QWidget()
        central.setObjectName("Central")
        root = QVBoxLayout(central)
        root.setContentsMargins(20, 16, 20, 16)
        root.setSpacing(12)

        # Top: name + folder
        header = QHBoxLayout()
        titles = QVBoxLayout()
        titles.setSpacing(0)
        title = QLabel(APP_NAME)
        title.setObjectName("Title")
        subtitle = QLabel("Find text inside files on your computer. Fast, private and offline.")
        subtitle.setObjectName("Subtitle")
        titles.addWidget(title)
        titles.addWidget(subtitle)
        header.addLayout(titles, 1)
        about_btn = QPushButton("About")
        about_btn.setObjectName("LinkButton")
        about_btn.clicked.connect(self.show_about)
        header.addWidget(about_btn, 0, Qt.AlignTop)
        root.addLayout(header)

        self.banner = QLabel()
        self.banner.setObjectName("Banner")
        self.banner.setWordWrap(True)
        self.banner.hide()
        root.addWidget(self.banner)

        folder_card, fl = _card()
        lbl = QLabel("Folder to search")
        lbl.setObjectName("SectionLabel")
        fl.addWidget(lbl)
        row = QHBoxLayout()
        self.folder_edit = QLineEdit()
        self.folder_edit.setPlaceholderText("Choose a folder…")
        self.folder_edit.returnPressed.connect(self.start_search)
        browse = QPushButton("Browse…")
        browse.clicked.connect(self.choose_folder)
        self.recursive_box = QCheckBox("Include subfolders")
        self.recursive_box.setChecked(True)
        row.addWidget(self.folder_edit, 1)
        row.addWidget(browse)
        row.addSpacing(8)
        row.addWidget(self.recursive_box)
        fl.addLayout(row)
        root.addWidget(folder_card)

        # Middle: query, file types, search button
        search_card, sl = _card()
        qrow = QHBoxLayout()
        self.query_edit = QLineEdit()
        self.query_edit.setObjectName("QueryBox")
        self.query_edit.setPlaceholderText("Enter a word or phrase to find…")
        self.query_edit.setClearButtonEnabled(True)
        self.query_edit.returnPressed.connect(self.start_search)
        self.search_btn = QPushButton("Search")
        self.search_btn.setObjectName("PrimaryButton")
        self.search_btn.setDefault(True)
        self.search_btn.clicked.connect(self.start_search)
        qrow.addWidget(self.query_edit, 1)
        qrow.addWidget(self.search_btn)
        sl.addLayout(qrow)

        trow = QHBoxLayout()
        trow.setSpacing(6)
        tl = QLabel("File types:")
        tl.setObjectName("SectionLabel")
        trow.addWidget(tl)
        self.type_chips: dict[str, QPushButton] = {}
        for ext in PRESET_EXTENSIONS:
            chip = QPushButton(ext.upper())
            chip.setObjectName("Chip")
            chip.setCheckable(True)
            chip.setCursor(Qt.PointingHandCursor)
            self.type_chips[ext] = chip
            trow.addWidget(chip)
        trow.addSpacing(8)
        self.other_types = QLineEdit()
        self.other_types.setPlaceholderText("Other, e.g. html, ini")
        self.other_types.setMaximumWidth(200)
        trow.addWidget(self.other_types)
        trow.addSpacing(8)
        self.case_box = QCheckBox("Match case")
        trow.addWidget(self.case_box)
        trow.addStretch(1)
        sl.addLayout(trow)
        hint = QLabel("No type selected = all text files. Hidden files, files excluded by .gitignore/.ignore "
                      "rules, and binary files are skipped.")
        hint.setObjectName("Muted")
        hint.setWordWrap(True)
        sl.addWidget(hint)
        root.addWidget(search_card)

        # Bottom: results, count, cancel
        self.model = ResultsModel(self)
        self.proxy = QSortFilterProxyModel(self)
        self.proxy.setSourceModel(self.model)
        self.table = QTableView()
        self.table.setModel(self.proxy)
        self.table.setSortingEnabled(True)
        self.table.sortByColumn(-1, Qt.AscendingOrder)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.setAlternatingRowColors(False)
        self.table.setWordWrap(False)
        self.table.setTextElideMode(Qt.ElideMiddle)
        self.table.verticalHeader().hide()
        self.table.verticalHeader().setDefaultSectionSize(24)
        hdr = self.table.horizontalHeader()
        hdr.setSectionResizeMode(QHeaderView.Interactive)
        hdr.setStretchLastSection(True)
        self.table.setColumnWidth(0, 190)
        self.table.setColumnWidth(1, 330)
        self.table.setColumnWidth(2, 60)
        self.table.doubleClicked.connect(lambda idx: self.open_file(idx.row()))
        self.table.setContextMenuPolicy(Qt.CustomContextMenu)
        self.table.customContextMenuRequested.connect(self._context_menu)
        self.table.selectionModel().selectionChanged.connect(self._update_buttons)
        root.addWidget(self.table, 1)

        self.progress = QProgressBar()
        self.progress.setTextVisible(False)
        self.progress.setRange(0, 0)       # indeterminate "busy" indicator
        self.progress.hide()
        root.addWidget(self.progress)

        bottom = QHBoxLayout()
        self.count_label = QLabel("0 matches")
        self.count_label.setObjectName("MatchCount")
        self.status_label = QLabel("Ready.")
        self.status_label.setObjectName("Status")
        self.status_label.setWordWrap(True)
        self.details_btn = QPushButton("Details…")
        self.details_btn.setObjectName("LinkButton")
        self.details_btn.clicked.connect(self.show_errors)
        self.details_btn.hide()
        self.open_btn = QPushButton("Open file")
        self.open_btn.clicked.connect(lambda: self.open_file(self._selected_row()))
        self.folder_btn = QPushButton("Open containing folder")
        self.folder_btn.clicked.connect(lambda: self.open_folder(self._selected_row()))
        self.cancel_btn = QPushButton("Cancel")
        self.cancel_btn.clicked.connect(self.cancel_search)
        self.cancel_btn.setEnabled(False)
        bottom.addWidget(self.count_label)
        bottom.addSpacing(12)
        bottom.addWidget(self.status_label, 1)
        bottom.addWidget(self.details_btn)
        bottom.addWidget(self.open_btn)
        bottom.addWidget(self.folder_btn)
        bottom.addWidget(self.cancel_btn)
        root.addLayout(bottom)

        self.setCentralWidget(central)

        esc = QAction(self)
        esc.setShortcut(QKeySequence(Qt.Key_Escape))
        esc.triggered.connect(self.cancel_search)
        self.addAction(esc)
        self._update_buttons()
        self.query_edit.setFocus()

    # ----------------------------------------------------------------- actions

    def choose_folder(self) -> None:
        start = self.folder_edit.text().strip() or str(Path.home())
        folder = QFileDialog.getExistingDirectory(self, "Choose a folder to search", start)
        if folder:
            self.folder_edit.setText(os.path.normpath(folder))

    def selected_extensions(self) -> list[str]:
        exts = [e for e, chip in self.type_chips.items() if chip.isChecked()]
        for e in parse_extensions(self.other_types.text()):
            if e not in exts:
                exts.append(e)
        return exts

    def is_searching(self) -> bool:
        return self._worker is not None

    def start_search(self) -> None:
        if self.is_searching() or not self.search_btn.isEnabled():
            return
        try:
            opts = validate(
                self.folder_edit.text(), self.query_edit.text(),
                recursive=self.recursive_box.isChecked(),
                extensions=self.selected_extensions(),
                case_sensitive=self.case_box.isChecked(),
            )
        except SearchError as exc:
            self._set_status(str(exc), "error")
            QMessageBox.warning(self, APP_NAME, str(exc))
            return
        self._settings.setValue("last_folder", str(opts.folder))
        self.model.clear()
        self._last_result = None
        self.details_btn.hide()
        self.count_label.setText("0 matches")
        self._set_status(f"Searching {opts.folder} …", "")
        self.progress.show()
        self.search_btn.setEnabled(False)
        self.cancel_btn.setEnabled(True)

        worker = SearchWorker(opts, self)
        worker.matches_found.connect(self._on_matches)
        worker.search_done.connect(self._on_done)
        worker.finished.connect(worker.deleteLater)
        self._worker = worker
        worker.start()

    def cancel_search(self) -> None:
        if self._worker is not None:
            self._set_status("Cancelling…", "")
            self.cancel_btn.setEnabled(False)
            self._worker.cancel()

    def _on_matches(self, batch: list) -> None:
        self.model.add(batch)
        n = self.model.rowCount()
        self.count_label.setText(f"{n:,} match" + ("" if n == 1 else "es"))

    def _on_done(self, result: SearchResult) -> None:
        self._worker = None
        self._last_result = result
        self.progress.hide()
        self.search_btn.setEnabled(True)
        self.cancel_btn.setEnabled(False)
        n = self.model.rowCount()
        self.count_label.setText(f"{n:,} match" + ("" if n == 1 else "es"))
        state = {
            Status.COMPLETE: "ok", Status.NO_MATCHES: "", Status.TRUNCATED: "warn",
            Status.CANCELLED: "warn", Status.COMPLETED_WITH_ERRORS: "warn", Status.FAILED: "error",
        }[result.status]
        self._set_status(result.summary(), state)
        self.details_btn.setVisible(bool(result.errors))
        self._update_buttons()

    def _set_status(self, text: str, state: str) -> None:
        self.status_label.setText(text)
        self.status_label.setProperty("state", state)
        self.status_label.style().unpolish(self.status_label)
        self.status_label.style().polish(self.status_label)

    def _selected_row(self) -> int:
        rows = self.table.selectionModel().selectedRows()
        return rows[0].row() if rows else -1

    def _update_buttons(self, *_args) -> None:
        has = self._selected_row() >= 0
        self.open_btn.setEnabled(has)
        self.folder_btn.setEnabled(has)

    def _source_path(self, proxy_row: int) -> str | None:
        if proxy_row < 0:
            return None
        src = self.proxy.mapToSource(self.proxy.index(proxy_row, 0))
        return self.model.match_at(src.row()).path if src.isValid() else None

    def open_file(self, proxy_row: int) -> None:
        path = self._source_path(proxy_row)
        if not path:
            return
        if not os.path.isfile(path):
            QMessageBox.warning(self, APP_NAME, f"The file no longer exists:\n{path}")
            return
        # Opens the file in the user's default application for that file type.
        if not QDesktopServices.openUrl(QUrl.fromLocalFile(path)):
            QMessageBox.warning(self, APP_NAME, f"Windows could not open this file:\n{path}\n\n"
                                "There may be no default application for this file type.")

    def open_folder(self, proxy_row: int) -> None:
        path = self._source_path(proxy_row)
        if not path:
            return
        folder = os.path.dirname(path)
        if not os.path.isdir(folder) or not QDesktopServices.openUrl(QUrl.fromLocalFile(folder)):
            QMessageBox.warning(self, APP_NAME, f"Could not open the folder:\n{folder}")

    def _context_menu(self, pos) -> None:
        idx = self.table.indexAt(pos)
        if not idx.isValid():
            return
        self.table.selectRow(idx.row())
        menu = QMenu(self)
        menu.addAction("Open file", lambda: self.open_file(idx.row()))
        menu.addAction("Open containing folder", lambda: self.open_folder(idx.row()))
        menu.addSeparator()
        menu.addAction("Copy file path", lambda: self._copy(os.path.normpath(self._source_path(idx.row()) or "")))
        menu.exec(self.table.viewport().mapToGlobal(pos))

    def _copy(self, text: str) -> None:
        from PySide6.QtGui import QGuiApplication
        QGuiApplication.clipboard().setText(text)

    def show_errors(self) -> None:
        r = self._last_result
        if not r or not r.errors:
            return
        box = QMessageBox(self)
        box.setWindowTitle("Search problems")
        box.setIcon(QMessageBox.Warning)
        box.setText(f"{r.error_count:,} file(s) or folder(s) could not be searched "
                    "(for example, because access was denied). Results may be incomplete.")
        shown = r.errors[:200]
        more = f"\n… and {r.error_count - len(shown):,} more." if r.error_count > len(shown) else ""
        box.setDetailedText("\n".join(shown) + more)
        box.exec()

    def show_about(self) -> None:
        box = QMessageBox(self)
        box.setWindowTitle(f"About {APP_NAME}")
        box.setTextFormat(Qt.RichText)
        box.setText(ATTRIBUTION)
        lic_btn = box.addButton("View licenses", QMessageBox.ActionRole)
        box.addButton(QMessageBox.Close)
        box.exec()
        if box.clickedButton() is lic_btn:
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(licenses_dir())))

    def closeEvent(self, event) -> None:  # noqa: N802
        if self._worker is not None:
            self._worker.cancel()
            self._worker.wait(5000)
        super().closeEvent(event)
