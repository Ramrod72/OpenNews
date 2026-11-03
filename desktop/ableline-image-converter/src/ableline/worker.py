"""Background thread that runs a batch without blocking the GUI."""

from __future__ import annotations

import threading
from pathlib import Path

from PySide6.QtCore import QThread, Signal

from ableline.converter import BatchSummary, FileResult, run_batch
from ableline.magick import MagickEngine
from ableline.validation import ConversionSettings


class ConversionWorker(QThread):
    """Converts files on a worker thread; results are delivered via signals."""

    file_done = Signal(int, object)        # index, FileResult
    batch_done = Signal(object)            # BatchSummary

    def __init__(self, files: list[Path], settings: ConversionSettings, engine: MagickEngine, parent=None):
        super().__init__(parent)
        self._files = list(files)
        self._settings = settings
        self._engine = engine
        self._cancel = threading.Event()

    def cancel(self) -> None:
        self._cancel.set()

    def run(self) -> None:  # executed on the worker thread
        try:
            summary = run_batch(
                self._files, self._settings, self._engine, self._cancel,
                on_result=lambda i, r: self.file_done.emit(i, r),
            )
        except Exception as exc:  # last-resort guard: never crash the GUI
            summary = BatchSummary(results=[FileResult(Path("?"), False, message=f"Unexpected error: {exc}")])
        self.batch_done.emit(summary)
