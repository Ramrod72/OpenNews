"""Supported image formats and content sniffing.

Only these five formats are ever read or written. The format of an input
file is decided by its *content* (magic bytes), and must agree with its
extension, so ImageMagick is never asked to auto-detect a coder.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ImageFormat:
    key: str            # Stable identifier used in the UI/settings
    label: str          # Human-readable name
    coder: str          # ImageMagick coder name (explicit prefix)
    extension: str      # Extension used for output files
    extensions: tuple[str, ...]  # Extensions accepted for input
    supports_quality: bool


PNG = ImageFormat("png", "PNG", "PNG", ".png", (".png",), False)
JPG = ImageFormat("jpg", "JPG", "JPEG", ".jpg", (".jpg", ".jpeg", ".jpe"), True)
WEBP = ImageFormat("webp", "WebP", "WEBP", ".webp", (".webp",), True)
BMP = ImageFormat("bmp", "BMP", "BMP", ".bmp", (".bmp", ".dib"), False)
TIFF = ImageFormat("tiff", "TIFF", "TIFF", ".tiff", (".tif", ".tiff"), False)

FORMATS: tuple[ImageFormat, ...] = (PNG, JPG, WEBP, BMP, TIFF)
FORMATS_BY_KEY = {f.key: f for f in FORMATS}
INPUT_EXTENSIONS = frozenset(ext for f in FORMATS for ext in f.extensions)


def format_for_extension(path: Path) -> ImageFormat | None:
    ext = path.suffix.lower()
    for fmt in FORMATS:
        if ext in fmt.extensions:
            return fmt
    return None


def sniff_format(header: bytes) -> ImageFormat | None:
    """Identify one of the supported formats from the first bytes of a file."""
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return PNG
    if header.startswith(b"\xff\xd8\xff"):
        return JPG
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return WEBP
    if header.startswith(b"BM"):
        return BMP
    if header[:4] in (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+"):
        return TIFF
    return None


def file_dialog_filter() -> str:
    patterns = " ".join(f"*{ext}" for f in FORMATS for ext in f.extensions)
    return f"Images ({patterns})"
