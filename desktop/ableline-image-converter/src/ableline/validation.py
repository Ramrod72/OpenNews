"""Input validation for files and conversion settings."""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from ableline.formats import FORMATS_BY_KEY, ImageFormat, format_for_extension, sniff_format

MAX_INPUT_BYTES = 500 * 1024 * 1024   # 500 MB per file
MAX_DIMENSION = 16000                  # pixels, matches policy.xml width/height
MAX_PERCENT = 1000


class ValidationError(ValueError):
    """Raised when a file or a setting is not acceptable."""


class ResizeMode(str, Enum):
    NONE = "none"
    PERCENT = "percent"
    DIMENSIONS = "dimensions"


@dataclass(frozen=True)
class ConversionSettings:
    output_format: ImageFormat
    output_dir: Path
    resize_mode: ResizeMode = ResizeMode.NONE
    width: int | None = None
    height: int | None = None
    percent: int | None = None
    keep_aspect: bool = True
    quality: int = 90


def validate_input_file(path: Path) -> ImageFormat:
    """Check that *path* is a local, regular, supported image file.

    Returns the detected format. Raises ValidationError with a
    user-readable message otherwise.
    """
    if not path.exists():
        raise ValidationError("File does not exist.")
    if path.is_symlink() or not path.is_file():
        raise ValidationError("Not a regular file.")
    if str(path).startswith(("\\\\", "//")):
        raise ValidationError("Network paths are not supported; copy the file locally first.")
    ext_format = format_for_extension(path)
    if ext_format is None:
        raise ValidationError(f"Unsupported file type '{path.suffix or '(none)'}'.")
    size = path.stat().st_size
    if size == 0:
        raise ValidationError("File is empty.")
    if size > MAX_INPUT_BYTES:
        raise ValidationError(f"File is larger than {MAX_INPUT_BYTES // (1024 * 1024)} MB.")
    try:
        with path.open("rb") as fh:
            header = fh.read(16)
    except OSError as exc:
        raise ValidationError(f"Cannot read file: {exc.strerror or exc}.") from exc
    content_format = sniff_format(header)
    if content_format is None:
        raise ValidationError("File content is not a supported image.")
    if content_format is not ext_format:
        raise ValidationError(
            f"File extension says {ext_format.label} but content is {content_format.label}."
        )
    return content_format


def validate_output_dir(path: Path | None) -> Path:
    if path is None or str(path).strip() == "":
        raise ValidationError("Choose an output folder.")
    path = Path(path)
    if not path.is_dir():
        raise ValidationError("Output folder does not exist.")
    if not os.access(path, os.W_OK):
        raise ValidationError("Output folder is not writable.")
    return path.resolve()


def build_settings(
    *,
    output_format_key: str,
    output_dir: Path | str | None,
    resize_mode: ResizeMode | str = ResizeMode.NONE,
    width: int | None = None,
    height: int | None = None,
    percent: int | None = None,
    keep_aspect: bool = True,
    quality: int = 90,
) -> ConversionSettings:
    """Validate raw settings and return an immutable ConversionSettings."""
    fmt = FORMATS_BY_KEY.get(output_format_key)
    if fmt is None:
        raise ValidationError(f"Unsupported output format '{output_format_key}'.")
    out = validate_output_dir(Path(output_dir) if output_dir else None)
    try:
        mode = ResizeMode(resize_mode)
    except ValueError as exc:
        raise ValidationError(f"Unknown resize mode '{resize_mode}'.") from exc

    width = width or None
    height = height or None
    if mode is ResizeMode.PERCENT:
        if percent is None or not 1 <= percent <= MAX_PERCENT:
            raise ValidationError(f"Resize percentage must be between 1 and {MAX_PERCENT}.")
        width = height = None
    elif mode is ResizeMode.DIMENSIONS:
        for name, value in (("Width", width), ("Height", height)):
            if value is not None and not 1 <= value <= MAX_DIMENSION:
                raise ValidationError(f"{name} must be between 1 and {MAX_DIMENSION} pixels.")
        if width is None and height is None:
            raise ValidationError("Enter a width, a height, or both.")
        if not keep_aspect and (width is None or height is None):
            raise ValidationError("Enter both width and height when not preserving aspect ratio.")
        percent = None
    else:
        width = height = percent = None

    if not 1 <= quality <= 100:
        raise ValidationError("Quality must be between 1 and 100.")

    return ConversionSettings(
        output_format=fmt,
        output_dir=out,
        resize_mode=mode,
        width=width,
        height=height,
        percent=percent,
        keep_aspect=keep_aspect,
        quality=quality,
    )
