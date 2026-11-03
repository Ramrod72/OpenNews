"""Batch processing and error handling."""

import os
import threading
import time

import pytest

from helpers import write_png
from ableline import magick
from ableline.converter import convert_file, run_batch
from ableline.magick import MagickEngine
from ableline.validation import build_settings


def test_batch_mixed_results(engine, src_dir, out_dir):
    good = [write_png(src_dir / f"img{i}.png", 30 + i, 20) for i in range(5)]
    corrupt = src_dir / "broken.png"
    corrupt.write_bytes(b"\x89PNG\r\n\x1a\n" + b"garbage" * 20)
    missing = src_dir / "missing.png"
    files = good[:2] + [corrupt, missing] + good[2:]

    seen = []
    summary = run_batch(files, build_settings(output_format_key="webp", output_dir=out_dir), engine,
                        on_result=lambda i, r: seen.append(i))
    assert seen == list(range(len(files)))
    assert len(summary.succeeded) == 5
    assert {r.source.name for r in summary.failed} == {"broken.png", "missing.png"}
    assert all(r.message for r in summary.failed)
    assert not summary.cancelled
    assert sorted(p.name for p in out_dir.iterdir()) == sorted(f"img{i}.webp" for i in range(5))


def test_batch_same_stem_from_different_folders(engine, tmp_path, out_dir):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir(), b.mkdir()
    files = [write_png(a / "pic.png", 10, 10), write_png(b / "pic.png", 10, 10)]
    summary = run_batch(files, build_settings(output_format_key="jpg", output_dir=out_dir), engine)
    assert sorted(r.output.name for r in summary.succeeded) == ["pic (1).jpg", "pic.jpg"]


def test_batch_cancel_stops_early(engine, src_dir, out_dir):
    files = [write_png(src_dir / f"c{i}.png", 10, 10) for i in range(6)]
    cancel = threading.Event()

    def on_result(i, r):
        if i == 1:
            cancel.set()

    summary = run_batch(files, build_settings(output_format_key="png", output_dir=out_dir), engine,
                        cancel=cancel, on_result=on_result)
    assert summary.cancelled
    assert len(summary.results) == 2


def test_corrupt_image_leaves_no_output(engine, src_dir, out_dir):
    bad = src_dir / "bad.jpg"
    bad.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 64)
    r = convert_file(bad, build_settings(output_format_key="png", output_dir=out_dir), engine)
    assert not r.ok and r.message
    assert list(out_dir.iterdir()) == []


def test_unsupported_input_rejected_before_imagemagick(engine, src_dir, out_dir, monkeypatch):
    calls = []
    monkeypatch.setattr(magick, "run", lambda *a, **k: calls.append(a))
    gif = src_dir / "x.gif"
    gif.write_bytes(b"GIF89a" + b"\x00" * 32)
    r = convert_file(gif, build_settings(output_format_key="png", output_dir=out_dir), engine)
    assert not r.ok and "Unsupported" in r.message
    assert calls == []


def test_security_policy_blocks_other_coders(engine, tmp_path):
    (tmp_path / "x.gif").write_bytes(b"GIF89a\x01\x00\x01\x00\x00\x00\x00;")
    try:
        magick.run(engine, ["GIF:x.gif", "PNG:y.png"], cwd=tmp_path)
    except magick.MagickError as exc:
        assert "security policy" in str(exc) or "decode" in str(exc).lower()
    else:
        raise AssertionError("GIF should have been blocked by policy.xml")
    assert not (tmp_path / "y.png").exists()


def test_security_policy_blocks_indirect_read(engine, tmp_path):
    (tmp_path / "list.txt").write_text("/etc/passwd\n")
    try:
        magick.run(engine, ["@list.txt", "PNG:y.png"], cwd=tmp_path)
    except magick.MagickError:
        pass
    else:
        raise AssertionError("indirect read should be blocked")


def test_unwritable_output_reports_error(engine, png, out_dir, monkeypatch):
    def boom(*a, **k):
        raise PermissionError(13, "Permission denied")
    s = build_settings(output_format_key="png", output_dir=out_dir)
    monkeypatch.setattr("ableline.converter.reserve_output_path", boom)
    r = convert_file(png, s, engine)
    assert not r.ok and "Permission denied" in r.message


@pytest.fixture
def slow_engine(tmp_path):
    if os.name == "nt":
        pytest.skip("uses a POSIX shell script as a stand-in executable")
    exe = tmp_path / "slow-magick"
    exe.write_text("#!/bin/sh\nsleep 30\n")
    exe.chmod(0o755)
    return MagickEngine(exe, "7.0.0", 7, False, magick.policy_dir())


def test_timeout_is_reported(slow_engine, tmp_path):
    start = time.monotonic()
    with pytest.raises(magick.MagickError, match="too long"):
        magick.run(slow_engine, ["x"], cwd=tmp_path, timeout=0.5)
    assert time.monotonic() - start < 5


def test_cancel_kills_running_process(slow_engine, png, out_dir):
    cancel = threading.Event()
    threading.Timer(0.3, cancel.set).start()
    start = time.monotonic()
    r = convert_file(png, build_settings(output_format_key="png", output_dir=out_dir), slow_engine, cancel)
    assert not r.ok and r.message == "Cancelled"
    assert time.monotonic() - start < 5
    assert list(out_dir.iterdir()) == []
