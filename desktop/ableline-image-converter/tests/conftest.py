from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from helpers import write_png  # noqa: E402
from ableline.magick import MagickError, find_engine  # noqa: E402


@pytest.fixture(scope="session")
def engine():
    try:
        return find_engine()
    except MagickError:
        pytest.skip("ImageMagick is not installed")


@pytest.fixture
def src_dir(tmp_path):
    d = tmp_path / "in"
    d.mkdir()
    return d


@pytest.fixture
def out_dir(tmp_path):
    d = tmp_path / "out"
    d.mkdir()
    return d


@pytest.fixture
def png(src_dir):
    return write_png(src_dir / "sample.png", 200, 100)
