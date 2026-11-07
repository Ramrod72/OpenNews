"""Runs a search on a background thread so the window never freezes."""

from __future__ import annotations

from PySide6.QtCore import QThread, Signal

from textfinder.search import Search, SearchOptions, SearchResult, Status


class SearchWorker(QThread):
    matches_found = Signal(list)    # list[Match]
    search_done = Signal(object)    # SearchResult

    def __init__(self, opts: SearchOptions, parent=None):
        super().__init__(parent)
        self._search = Search(opts)

    def cancel(self) -> None:
        self._search.cancel()

    def run(self) -> None:  # worker thread
        try:
            result = self._search.run(lambda batch: self.matches_found.emit(batch))
        except Exception as exc:  # last-resort guard: never crash the GUI
            result = SearchResult(Status.FAILED, message=f"Unexpected error: {exc}")
        self.search_done.emit(result)
