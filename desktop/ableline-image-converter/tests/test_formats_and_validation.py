import os
from pathlib import Path

import pytest

from helpers import write_png
from ableline.formats import BMP, JPG, PNG, TIFF, WEBP, format_for_extension, sniff_format
from ableline.validation import ResizeMode, ValidationError, build_settings, validate_input_file


@pytest.mark.parametrize("header,expected", [
    (b"\x89PNG\r\n\x1a\n....", PNG),
    (b"\xff\xd8\xff\xe0....", JPG),
    (b"RIFF\x00\x00\x00\x00WEBPVP8 ", WEBP),
    (b"BM\x00\x00", BMP),
    (b"II*\x00", TIFF),
    (b"MM\x00*", TIFF),
    (b"GIF89a", None),
    (b"%PDF-1.7", None),
    (b"<svg", None),
    (b"", None),
])
def test_sniff_format(header, expected):
    assert sniff_format(header) is expected


@pytest.mark.parametrize("name,expected", [
    ("a.PNG", PNG), ("a.jpeg", JPG), ("a.JPG", JPG), ("a.webp", WEBP),
    ("a.tif", TIFF), ("a.bmp", BMP), ("a.gif", None), ("a.svg", None), ("noext", None),
])
def test_format_for_extension(name, expected):
    assert format_for_extension(Path(name)) is expected


def test_valid_png(png):
    assert validate_input_file(png) is PNG


def test_missing_file(tmp_path):
    with pytest.raises(ValidationError, match="does not exist"):
        validate_input_file(tmp_path / "nope.png")


def test_empty_file(src_dir):
    p = src_dir / "empty.png"
    p.write_bytes(b"")
    with pytest.raises(ValidationError, match="empty"):
        validate_input_file(p)


def test_unsupported_extension(src_dir):
    p = src_dir / "anim.gif"
    p.write_bytes(b"GIF89a" + b"\x00" * 20)
    with pytest.raises(ValidationError, match="Unsupported file type"):
        validate_input_file(p)


def test_extension_content_mismatch(src_dir):
    p = write_png(src_dir / "fake.jpg", 4, 4)
    with pytest.raises(ValidationError, match="content is PNG"):
        validate_input_file(p)


def test_disguised_non_image(src_dir):
    p = src_dir / "evil.png"
    p.write_bytes(b"push graphic-context\nviewbox 0 0 640 480\n")  # MVG/ImageTragick style payload
    with pytest.raises(ValidationError, match="not a supported image"):
        validate_input_file(p)


def test_directory_rejected(src_dir):
    d = src_dir / "folder.png"
    d.mkdir()
    with pytest.raises(ValidationError, match="regular file"):
        validate_input_file(d)


@pytest.mark.skipif(os.name == "nt", reason="symlinks need privileges on Windows")
def test_symlink_rejected(png, src_dir):
    link = src_dir / "link.png"
    link.symlink_to(png)
    with pytest.raises(ValidationError, match="regular file"):
        validate_input_file(link)


def test_settings_ok(out_dir):
    s = build_settings(output_format_key="webp", output_dir=out_dir, quality=70)
    assert s.output_format is WEBP and s.quality == 70 and s.resize_mode is ResizeMode.NONE


@pytest.mark.parametrize("kwargs,match", [
    (dict(output_format_key="gif"), "Unsupported output format"),
    (dict(output_dir=None), "output folder"),
    (dict(quality=0), "Quality"),
    (dict(quality=101), "Quality"),
    (dict(resize_mode="percent", percent=0), "percentage"),
    (dict(resize_mode="percent", percent=5000), "percentage"),
    (dict(resize_mode="dimensions"), "width, a height"),
    (dict(resize_mode="dimensions", width=99999), "Width"),
    (dict(resize_mode="dimensions", width=100, keep_aspect=False), "both width and height"),
    (dict(resize_mode="sideways"), "resize mode"),
])
def test_settings_invalid(out_dir, kwargs, match):
    base = dict(output_format_key="png", output_dir=out_dir)
    base.update(kwargs)
    with pytest.raises(ValidationError, match=match):
        build_settings(**base)


def test_output_dir_must_exist(tmp_path):
    with pytest.raises(ValidationError, match="does not exist"):
        build_settings(output_format_key="png", output_dir=tmp_path / "missing")
