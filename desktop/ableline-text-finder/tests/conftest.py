from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from textfinder.search import RipgrepNotFound, find_rg  # noqa: E402


@pytest.fixture(scope="session")
def rg():
    try:
        return find_rg()
    except RipgrepNotFound:
        pytest.skip("ripgrep is not available (set ABLELINE_RG or run packaging/fetch_ripgrep.py)")


@pytest.fixture
def folder(tmp_path):
    d = tmp_path / "data"
    d.mkdir()
    return d


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path
