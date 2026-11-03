"""End-to-end conversion and resizing through ImageMagick."""

import hashlib

import pytest

from helpers import image_size, write_png
from ableline.converter import convert_file
from ableline.formats import FORMATS, FORMATS_BY_KEY, sniff_format
from ableline.validation import build_settings


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


@pytest.mark.parametrize("fmt", [f.key for f in FORMATS])
def test_png_converts_to_every_format(engine, png, out_dir, fmt):
    r = convert_file(png, build_settings(output_format_key=fmt, output_dir=out_dir), engine)
    assert r.ok, r.message
    assert r.output.suffix == FORMATS_BY_KEY[fmt].extension
    assert sniff_format(r.output.read_bytes()[:16]) is FORMATS_BY_KEY[fmt]


@pytest.mark.parametrize("fmt", [f.key for f in FORMATS])
def test_every_format_reads_back(engine, png, tmp_path, fmt):
    """Each output format is also accepted as input."""
    mid, final = tmp_path / "mid", tmp_path / "final"
    mid.mkdir(), final.mkdir()
    first = convert_file(png, build_settings(output_format_key=fmt, output_dir=mid), engine)
    assert first.ok, first.message
    second = convert_file(first.output, build_settings(output_format_key="png", output_dir=final), engine)
    assert second.ok, second.message
    assert image_size(second.output) == (200, 100)


def test_original_is_never_modified(engine, png, src_dir):
    before = sha(png)
    # Output into the *same* folder and same format: must create a new file.
    r = convert_file(png, build_settings(output_format_key="png", output_dir=src_dir), engine)
    assert r.ok, r.message
    assert r.output.name == "sample (1).png"
    assert sha(png) == before


def test_collisions_get_numbered(engine, png, out_dir):
    (out_dir / "sample.jpg").write_bytes(b"existing")
    s = build_settings(output_format_key="jpg", output_dir=out_dir)
    names = [convert_file(png, s, engine).output.name for _ in range(2)]
    assert names == ["sample (1).jpg", "sample (2).jpg"]
    assert (out_dir / "sample.jpg").read_bytes() == b"existing"


def test_tricky_filename_is_handled_literally(engine, src_dir, out_dir):
    p = write_png(src_dir / "shot [1] %d @x 'q'.png", 20, 10)
    r = convert_file(p, build_settings(output_format_key="webp", output_dir=out_dir), engine)
    assert r.ok, r.message
    assert r.output.name == "shot [1] %d @x 'q'.webp"


@pytest.mark.parametrize("kw,expected", [
    (dict(resize_mode="percent", percent=50), (100, 50)),
    (dict(resize_mode="percent", percent=200), (400, 200)),
    (dict(resize_mode="dimensions", width=100), (100, 50)),
    (dict(resize_mode="dimensions", height=25), (50, 25)),
    (dict(resize_mode="dimensions", width=100, height=100), (100, 50)),            # fit, aspect kept
    (dict(resize_mode="dimensions", width=100, height=100, keep_aspect=False), (100, 100)),
    (dict(), (200, 100)),
])
def test_resizing(engine, png, out_dir, kw, expected):
    r = convert_file(png, build_settings(output_format_key="png", output_dir=out_dir, **kw), engine)
    assert r.ok, r.message
    assert image_size(r.output) == expected


def test_resize_to_jpg_and_bmp(engine, png, out_dir):
    for fmt in ("jpg", "bmp"):
        r = convert_file(png, build_settings(output_format_key=fmt, output_dir=out_dir,
                                             resize_mode="dimensions", width=60), engine)
        assert r.ok, r.message
        assert image_size(r.output) == (60, 30)


@pytest.mark.parametrize("fmt", ["jpg", "webp"])
def test_quality_changes_file_size(engine, src_dir, tmp_path, fmt):
    if fmt == "webp" and engine.major < 7:
        pytest.xfail("Some ImageMagick 6 distro builds ignore -quality for WebP; target is ImageMagick 7")
    big = write_png(src_dir / "big.png", 400, 300)
    sizes = []
    for q in (10, 95):
        d = tmp_path / f"q{q}"
        d.mkdir()
        r = convert_file(big, build_settings(output_format_key=fmt, output_dir=d, quality=q), engine)
        assert r.ok, r.message
        sizes.append(r.output.stat().st_size)
    assert sizes[0] < sizes[1]


def test_transparent_png_to_jpg(engine, src_dir, out_dir):
    p = write_png(src_dir / "alpha.png", 40, 20, rgba=True)
    r = convert_file(p, build_settings(output_format_key="jpg", output_dir=out_dir), engine)
    assert r.ok, r.message
    assert image_size(r.output) == (40, 20)
