"""The single application window."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QDialog, QDialogButtonBox, QFileDialog, QFrame, QGridLayout,
    QHBoxLayout, QLabel, QLineEdit, QListWidget, QListWidgetItem, QMainWindow, QMessageBox,
    QProgressBar, QPushButton, QSlider, QSpinBox, QStackedWidget, QTextBrowser, QVBoxLayout,
    QWidget,
)

from ableline import APP_NAME, about
from ableline.converter import BatchSummary, FileResult
from ableline.formats import FORMATS, FORMATS_BY_KEY, file_dialog_filter
from ableline.inputs import collect_inputs
from ableline.magick import MagickEngine
from ableline.ui.drop_area import DropArea
from ableline.validation import MAX_DIMENSION, MAX_PERCENT, ResizeMode, ValidationError, build_settings
from ableline.worker import ConversionWorker

PATH_ROLE = Qt.ItemDataRole.UserRole


def _card() -> tuple[QFrame, QVBoxLayout]:
    frame = QFrame()
    frame.setObjectName("Card")
    layout = QVBoxLayout(frame)
    layout.setContentsMargins(16, 14, 16, 14)
    layout.setSpacing(10)
    return frame, layout


def _section(text: str) -> QLabel:
    label = QLabel(text)
    label.setObjectName("SectionLabel")
    return label


def _repolish(widget: QWidget) -> None:
    widget.style().unpolish(widget)
    widget.style().polish(widget)


class MainWindow(QMainWindow):
    def __init__(self, engine: MagickEngine | None, engine_error: str = ""):
        super().__init__()
        self.engine = engine
        self.worker: ConversionWorker | None = None
        self._queued: list[Path] = []

        self.setWindowTitle(APP_NAME)
        self.resize(900, 720)
        self.setMinimumSize(760, 620)

        central = QWidget(objectName="Central")
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(24, 20, 24, 16)
        root.setSpacing(14)

        # Header
        title = QLabel(APP_NAME, objectName="Title")
        subtitle = QLabel("Convert, resize and compress images in batches — entirely offline.",
                          objectName="Subtitle")
        root.addWidget(title)
        root.addWidget(subtitle)

        if engine is None:
            banner = QLabel(engine_error or "ImageMagick is not available.", objectName="Banner")
            banner.setWordWrap(True)
            root.addWidget(banner)

        # Inputs: drop area + queued file list
        inputs = QHBoxLayout()
        inputs.setSpacing(14)
        self.drop_area = DropArea()
        self.drop_area.paths_dropped.connect(self.add_paths)
        self.drop_area.clicked.connect(self.browse_files)
        inputs.addWidget(self.drop_area, 3)

        list_box = QVBoxLayout()
        self.file_count = QLabel("No images added", objectName="Muted")
        self.file_list = QListWidget()
        self.file_list.setSelectionMode(QListWidget.SelectionMode.ExtendedSelection)
        self.file_list.setAccessibleName("Images to convert")
        list_buttons = QHBoxLayout()
        self.remove_btn = QPushButton("Remove selected")
        self.remove_btn.clicked.connect(self.remove_selected)
        self.clear_btn = QPushButton("Clear")
        self.clear_btn.clicked.connect(self.clear_files)
        list_buttons.addWidget(self.remove_btn)
        list_buttons.addWidget(self.clear_btn)
        list_buttons.addStretch()
        list_box.addWidget(self.file_count)
        list_box.addWidget(self.file_list, 1)
        list_box.addLayout(list_buttons)
        inputs.addLayout(list_box, 2)
        root.addLayout(inputs, 1)

        # Settings card
        card, card_layout = _card()
        grid = QGridLayout()
        grid.setHorizontalSpacing(14)
        grid.setVerticalSpacing(10)
        grid.setColumnStretch(1, 1)
        grid.setColumnStretch(3, 1)

        grid.addWidget(_section("Format"), 0, 0)
        self.format_combo = QComboBox()
        for fmt in FORMATS:
            self.format_combo.addItem(fmt.label, fmt.key)
        self.format_combo.setCurrentIndex(self.format_combo.findData("jpg"))
        self.format_combo.currentIndexChanged.connect(self._update_quality_enabled)
        grid.addWidget(self.format_combo, 0, 1)

        grid.addWidget(_section("Quality"), 0, 2)
        quality_row = QHBoxLayout()
        self.quality_slider = QSlider(Qt.Orientation.Horizontal)
        self.quality_slider.setRange(1, 100)
        self.quality_slider.setValue(90)
        self.quality_spin = QSpinBox()
        self.quality_spin.setRange(1, 100)
        self.quality_spin.setValue(90)
        self.quality_slider.valueChanged.connect(self.quality_spin.setValue)
        self.quality_spin.valueChanged.connect(self.quality_slider.setValue)
        quality_row.addWidget(self.quality_slider, 1)
        quality_row.addWidget(self.quality_spin)
        grid.addLayout(quality_row, 0, 3)

        grid.addWidget(_section("Resize"), 1, 0)
        self.resize_combo = QComboBox()
        self.resize_combo.addItem("Original size", ResizeMode.NONE.value)
        self.resize_combo.addItem("Percentage", ResizeMode.PERCENT.value)
        self.resize_combo.addItem("Dimensions", ResizeMode.DIMENSIONS.value)
        grid.addWidget(self.resize_combo, 1, 1)

        self.resize_stack = QStackedWidget()
        self.resize_stack.addWidget(QLabel("Images keep their original dimensions.", objectName="Muted"))

        pct_page = QWidget()
        pct_row = QHBoxLayout(pct_page)
        pct_row.setContentsMargins(0, 0, 0, 0)
        self.percent_spin = QSpinBox()
        self.percent_spin.setRange(1, MAX_PERCENT)
        self.percent_spin.setValue(50)
        self.percent_spin.setSuffix(" %")
        pct_row.addWidget(self.percent_spin)
        pct_row.addStretch()
        self.resize_stack.addWidget(pct_page)

        dim_page = QWidget()
        dim_row = QHBoxLayout(dim_page)
        dim_row.setContentsMargins(0, 0, 0, 0)
        self.width_spin = QSpinBox()
        self.height_spin = QSpinBox()
        for spin, label in ((self.width_spin, "W"), (self.height_spin, "H")):
            spin.setRange(0, MAX_DIMENSION)
            spin.setSpecialValueText("auto")
            spin.setSuffix(" px")
            spin.setAccessibleName(f"{label} in pixels (0 = automatic)")
            dim_row.addWidget(QLabel(label, objectName="Muted"))
            dim_row.addWidget(spin)
        self.width_spin.setValue(1920)
        self.keep_aspect = QCheckBox("Keep aspect ratio")
        self.keep_aspect.setChecked(True)
        dim_row.addWidget(self.keep_aspect)
        dim_row.addStretch()
        self.resize_stack.addWidget(dim_page)

        self.resize_combo.currentIndexChanged.connect(self.resize_stack.setCurrentIndex)
        grid.addWidget(self.resize_stack, 1, 2, 1, 2)

        grid.addWidget(_section("Save to"), 2, 0)
        out_row = QHBoxLayout()
        self.output_edit = QLineEdit()
        self.output_edit.setReadOnly(True)
        self.output_edit.setPlaceholderText("Choose an output folder…")
        self.output_btn = QPushButton("Browse…")
        self.output_btn.clicked.connect(self.browse_output)
        out_row.addWidget(self.output_edit, 1)
        out_row.addWidget(self.output_btn)
        grid.addLayout(out_row, 2, 1, 1, 3)

        card_layout.addLayout(grid)
        note = QLabel("Originals are never changed. Existing files are never overwritten — "
                      "a number is added instead, e.g. “photo (1).jpg”.", objectName="Muted")
        note.setWordWrap(True)
        card_layout.addWidget(note)
        root.addWidget(card)

        # Progress + action
        self.progress = QProgressBar()
        self.progress.setTextVisible(False)
        self.progress.setValue(0)
        root.addWidget(self.progress)

        action_row = QHBoxLayout()
        self.status = QLabel("Add images to get started.", objectName="Status")
        self.status.setWordWrap(True)
        self.convert_btn = QPushButton("Convert Images", objectName="PrimaryButton")
        self.convert_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self.convert_btn.clicked.connect(self._on_convert_clicked)
        action_row.addWidget(self.status, 1)
        action_row.addWidget(self.convert_btn)
        root.addLayout(action_row)

        footer = QHBoxLayout()
        engine_label = QLabel(engine.display_name if engine else "ImageMagick not found", objectName="Muted")
        about_btn = QPushButton("About && licenses", objectName="LinkButton")
        about_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        about_btn.clicked.connect(self.show_about)
        footer.addWidget(engine_label)
        footer.addStretch()
        footer.addWidget(about_btn)
        root.addLayout(footer)

        for spin in self.findChildren(QSpinBox):
            spin.setButtonSymbols(QSpinBox.ButtonSymbols.NoButtons)
            spin.setMinimumWidth(80)

        self._update_quality_enabled()
        self._refresh_file_state()

    # ----- file queue -------------------------------------------------
    def browse_files(self) -> None:
        if self._busy():
            return
        files, _ = QFileDialog.getOpenFileNames(self, "Add images", "", file_dialog_filter())
        if files:
            self.add_paths([Path(f) for f in files])

    def add_paths(self, paths: list[Path]) -> None:
        if self._busy():
            return
        try:
            collected = collect_inputs(paths, already=self._queued)
        except OSError as exc:
            self._set_status(f"Could not read the dropped items: {exc.strerror or exc}", "error")
            return
        for path in collected.accepted:
            self._queued.append(path)
            item = QListWidgetItem(path.name)
            item.setData(PATH_ROLE, str(path))
            item.setToolTip(str(path))
            self.file_list.addItem(item)
        self._refresh_file_state()
        if collected.skipped:
            n = len(collected.skipped)
            self._set_status(f"Skipped {n} unsupported item{'s' if n != 1 else ''}. "
                             "Only PNG, JPG, WebP, BMP and TIFF files can be added.", "error")
        elif collected.accepted:
            self._set_status(f"Added {len(collected.accepted)} image(s).")

    def remove_selected(self) -> None:
        for item in self.file_list.selectedItems():
            path = Path(item.data(PATH_ROLE))
            self._queued = [p for p in self._queued if p != path]
            self.file_list.takeItem(self.file_list.row(item))
        self._refresh_file_state()

    def clear_files(self) -> None:
        self._queued.clear()
        self.file_list.clear()
        self.progress.setValue(0)
        self._refresh_file_state()
        self._set_status("Add images to get started.")

    def queued_files(self) -> list[Path]:
        return list(self._queued)

    def _refresh_file_state(self) -> None:
        n = len(self._queued)
        self.file_count.setText(f"{n} image{'s' if n != 1 else ''} queued" if n else "No images added")
        busy = self._busy()
        self.remove_btn.setEnabled(n > 0 and not busy)
        self.clear_btn.setEnabled(n > 0 and not busy)
        self.convert_btn.setEnabled(busy or (n > 0 and self.engine is not None))

    # ----- settings ---------------------------------------------------
    def browse_output(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "Choose output folder", self.output_edit.text())
        if folder:
            self.output_edit.setText(str(Path(folder)))

    def _update_quality_enabled(self) -> None:
        fmt = FORMATS_BY_KEY[self.format_combo.currentData()]
        for w in (self.quality_slider, self.quality_spin):
            w.setEnabled(fmt.supports_quality)
            w.setToolTip("" if fmt.supports_quality else f"{fmt.label} does not use a quality setting.")

    def current_settings(self):
        """Validated settings from the form (raises ValidationError)."""
        return build_settings(
            output_format_key=self.format_combo.currentData(),
            output_dir=self.output_edit.text() or None,
            resize_mode=self.resize_combo.currentData(),
            width=self.width_spin.value() or None,
            height=self.height_spin.value() or None,
            percent=self.percent_spin.value(),
            keep_aspect=self.keep_aspect.isChecked(),
            quality=self.quality_spin.value(),
        )

    # ----- conversion -------------------------------------------------
    def _busy(self) -> bool:
        return self.worker is not None and self.worker.isRunning()

    def _on_convert_clicked(self) -> None:
        if self._busy():
            self.worker.cancel()
            self.convert_btn.setEnabled(False)
            self._set_status("Cancelling…")
            return
        self.start_conversion()

    def start_conversion(self) -> bool:
        if self.engine is None:
            self._set_status("ImageMagick is not available.", "error")
            return False
        files = self.queued_files()
        if not files:
            self._set_status("Add at least one image.", "error")
            return False
        try:
            settings = self.current_settings()
        except ValidationError as exc:
            self._set_status(str(exc), "error")
            QMessageBox.warning(self, "Check settings", str(exc))
            return False

        for i in range(self.file_list.count()):
            item = self.file_list.item(i)
            item.setText(Path(item.data(PATH_ROLE)).name)
            item.setForeground(Qt.GlobalColor.black)
        self.progress.setRange(0, len(files))
        self.progress.setValue(0)
        self._set_status(f"Converting 0 of {len(files)}…")

        self.worker = ConversionWorker(files, settings, self.engine, self)
        self.worker.file_done.connect(self._on_file_done)
        self.worker.batch_done.connect(self._on_batch_done)
        self._set_controls_enabled(False)
        self.worker.start()
        return True

    def _set_controls_enabled(self, enabled: bool) -> None:
        for w in (self.drop_area, self.format_combo, self.resize_combo, self.resize_stack,
                  self.output_btn, self.quality_slider, self.quality_spin):
            w.setEnabled(enabled)
        if enabled:
            self._update_quality_enabled()
        self.convert_btn.setText("Convert Images" if enabled else "Cancel")
        self.convert_btn.setProperty("cancel", "false" if enabled else "true")
        _repolish(self.convert_btn)
        self.convert_btn.setEnabled(True)
        self._refresh_file_state()

    def _on_file_done(self, index: int, result: FileResult) -> None:
        self.progress.setValue(index + 1)
        item = self.file_list.item(index)
        if item is not None:
            mark = "✓" if result.ok else "✗"
            item.setText(f"{mark}  {result.source.name}")
            item.setForeground(Qt.GlobalColor.darkGreen if result.ok else Qt.GlobalColor.darkRed)
            item.setToolTip(f"{result.source}\n→ {result.output}" if result.ok
                            else f"{result.source}\n{result.message}")
        self._set_status(f"Converting {index + 1} of {self.progress.maximum()}…")

    def _on_batch_done(self, summary: BatchSummary) -> None:
        self.worker.wait()
        self.worker.deleteLater()
        self.worker = None
        self._set_controls_enabled(True)
        self.last_summary = summary

        ok, failed = len(summary.succeeded), len(summary.failed)
        parts = [f"{ok} converted"]
        if failed:
            parts.append(f"{failed} failed")
        if summary.cancelled:
            parts.append("cancelled")
        text = ", ".join(parts) + "."
        self._set_status(text, "error" if failed or summary.cancelled else "ok")

        if failed:
            box = QMessageBox(QMessageBox.Icon.Warning, "Conversion finished with errors",
                              f"{text}\n\nSee the details for the reason each file failed.",
                              QMessageBox.StandardButton.Ok, self)
            box.setDetailedText("\n".join(f"{r.source.name}: {r.message}" for r in summary.failed))
            box.open()

    def _set_status(self, text: str, state: str = "") -> None:
        self.status.setText(text)
        self.status.setProperty("state", state)
        _repolish(self.status)

    # ----- about -------------------------------------------------------
    def show_about(self) -> None:
        dlg = QDialog(self)
        dlg.setWindowTitle(f"About {APP_NAME}")
        dlg.resize(620, 520)
        layout = QVBoxLayout(dlg)
        intro = QLabel(about.ATTRIBUTION)
        intro.setWordWrap(True)
        intro.setTextFormat(Qt.TextFormat.RichText)
        text = QTextBrowser()
        text.setPlainText(about.license_text())
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        buttons.rejected.connect(dlg.reject)
        layout.addWidget(intro)
        layout.addWidget(text, 1)
        layout.addWidget(buttons)
        dlg.exec()

    def closeEvent(self, event) -> None:
        if self._busy():
            self.worker.cancel()
            self.worker.wait(10_000)
        super().closeEvent(event)
