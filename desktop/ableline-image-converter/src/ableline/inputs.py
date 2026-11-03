"""Collecting input files from drops and file-picker selections."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

from ableline.formats import INPUT_EXTENSIONS

MAX_QUEUE = 5000


@dataclass
class Collected:
    accepted: list[Path] = field(default_factory=list)
    skipped: list[Path] = field(default_factory=list)


def collect_inputs(paths: Iterable[Path], already: Iterable[Path] = ()) -> Collected:
    """Expand folders (one level, not recursive), keep supported local files,
    and drop duplicates of each other and of *already* queued files."""
    seen = {_key(p) for p in already}
    result = Collected()
    for raw in paths:
        path = Path(raw)
        entries = sorted(path.iterdir()) if path.is_dir() else [path]
        for entry in entries:
            if entry.is_dir():
                continue
            if entry.suffix.lower() not in INPUT_EXTENSIONS or not entry.is_file():
                result.skipped.append(entry)
                continue
            key = _key(entry)
            if key in seen:
                continue
            if len(seen) >= MAX_QUEUE:
                result.skipped.append(entry)
                continue
            seen.add(key)
            result.accepted.append(entry.resolve())
    return result


def _key(path: Path) -> str:
    return str(Path(path).resolve()).casefold()
