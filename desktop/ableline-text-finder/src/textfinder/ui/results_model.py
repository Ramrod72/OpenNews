"""Table model for search results (handles 10,000+ rows efficiently)."""

from __future__ import annotations

import os

from PySide6.QtCore import QAbstractTableModel, QModelIndex, Qt

from textfinder.search import Match

COLUMNS = ("File name", "File path", "Line", "Matching text")


class ResultsModel(QAbstractTableModel):
    def __init__(self, parent=None):
        super().__init__(parent)
        self._rows: list[Match] = []

    def rowCount(self, parent=QModelIndex()) -> int:  # noqa: N802
        return 0 if parent.isValid() else len(self._rows)

    def columnCount(self, parent=QModelIndex()) -> int:  # noqa: N802
        return 0 if parent.isValid() else len(COLUMNS)

    def headerData(self, section, orientation, role=Qt.DisplayRole):  # noqa: N802
        if role == Qt.DisplayRole and orientation == Qt.Horizontal:
            return COLUMNS[section]
        return None

    def data(self, index, role=Qt.DisplayRole):
        if not index.isValid():
            return None
        m = self._rows[index.row()]
        col = index.column()
        if role == Qt.DisplayRole:
            if col == 0:
                return m.filename
            if col == 1:
                return os.path.normpath(m.path)
            if col == 2:
                return m.line_number
            return m.text.strip()
        if role == Qt.ToolTipRole:
            return os.path.normpath(m.path) if col < 2 else m.text[:500]
        if role == Qt.TextAlignmentRole and col == 2:
            return int(Qt.AlignRight | Qt.AlignVCenter)
        return None

    def match_at(self, row: int) -> Match:
        return self._rows[row]

    def add(self, matches: list[Match]) -> None:
        if not matches:
            return
        start = len(self._rows)
        self.beginInsertRows(QModelIndex(), start, start + len(matches) - 1)
        self._rows.extend(matches)
        self.endInsertRows()

    def clear(self) -> None:
        self.beginResetModel()
        self._rows = []
        self.endResetModel()
