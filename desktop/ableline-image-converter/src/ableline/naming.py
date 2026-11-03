"""Safe, collision-free output file naming.

A name is *reserved* by creating an empty placeholder with exclusive
creation (O_EXCL), so two jobs - or a pre-existing file - can never
end up sharing a destination, and nothing existing is ever overwritten.
"""

from __future__ import annotations

import re
from pathlib import Path

_INVALID_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
MAX_ATTEMPTS = 10_000


def sanitize_stem(stem: str) -> str:
    """Make a file stem safe on Windows (and everywhere else)."""
    cleaned = _INVALID_CHARS.sub("_", stem).strip().rstrip(".")
    if not cleaned:
        cleaned = "image"
    if cleaned.upper().split(".")[0] in _RESERVED_NAMES:
        cleaned = f"_{cleaned}"
    return cleaned[:150]


def reserve_output_path(output_dir: Path, stem: str, extension: str) -> Path:
    """Create and return a new, empty, uniquely named file in *output_dir*.

    ``photo.jpg`` -> ``photo.jpg``, ``photo (1).jpg``, ``photo (2).jpg`` ...
    """
    base = sanitize_stem(stem)
    for n in range(MAX_ATTEMPTS):
        name = f"{base}{extension}" if n == 0 else f"{base} ({n}){extension}"
        candidate = output_dir / name
        try:
            with candidate.open("xb"):
                pass
        except FileExistsError:
            continue
        return candidate
    raise OSError(f"Could not find a free file name for '{base}{extension}'.")
