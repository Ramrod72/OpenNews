"""Command construction and error parsing (no ImageMagick required)."""

from pathlib import Path

import pytest

from ableline import magick
from ableline.converter import build_arguments, resize_geometry
from ableline.formats import PNG
from ableline.magick import MagickEngine, build_environment, summarize_error
from ableline.validation import build_settings


def settings(out_dir, **kw):
    return build_settings(output_dir=out_dir, **{"output_format_key": "png", **kw})


@pytest.mark.parametrize("kw,expected", [
    (dict(), None),
    (dict(resize_mode="percent", percent=50), "50%"),
    (dict(resize_mode="dimensions", width=800), "800x"),
    (dict(resize_mode="dimensions", height=600), "x600"),
    (dict(resize_mode="dimensions", width=800, height=600), "800x600"),
    (dict(resize_mode="dimensions", width=800, height=600, keep_aspect=False), "800x600!"),
])
def test_resize_geometry(out_dir, kw, expected):
    assert resize_geometry(settings(out_dir, **kw)) == expected


def test_arguments_use_explicit_coders_and_limits(out_dir):
    args = build_arguments("input.png", PNG, "output.jpg", settings(out_dir, output_format_key="jpg", quality=55))
    assert all(isinstance(a, str) for a in args)
    assert "PNG:input.png[0]" in args
    assert args[-1] == "JPEG:output.jpg"
    assert args[args.index("-quality") + 1] == "55"
    assert args.count("-limit") == len(magick.RESOURCE_LIMITS)
    assert "-alpha" in args  # JPEG flattens transparency


@pytest.mark.parametrize("fmt", ["png", "bmp", "tiff"])
def test_quality_only_where_supported(out_dir, fmt):
    args = build_arguments("input.png", PNG, "output.x", settings(out_dir, output_format_key=fmt))
    assert "-quality" not in args


def test_environment_points_to_policy_and_drops_magick_vars(monkeypatch, tmp_path):
    monkeypatch.setenv("MAGICK_CONFIGURE_PATH", "/evil")
    monkeypatch.setenv("MAGICK_CODER_MODULE_PATH", "/evil")
    env = build_environment(None, tmp_path / "policy")
    assert env["MAGICK_CONFIGURE_PATH"].split(__import__("os").pathsep)[0] == str(tmp_path / "policy")
    assert "MAGICK_CODER_MODULE_PATH" not in env


def test_policy_file_is_restrictive():
    text = (magick.policy_dir() / "policy.xml").read_text()
    assert 'domain="delegate" rights="none" pattern="*"' in text
    assert 'domain="coder" rights="none" pattern="*"' in text
    assert 'domain="path" rights="none" pattern="@*"' in text
    for name in ("memory", "disk", "width", "height", "area", "time"):
        assert f'name="{name}"' in text


@pytest.mark.parametrize("stderr,expected", [
    ("magick: attempt to perform an operation not allowed by the security policy `GIF' @ error/constitute.c/IsCoderAuthorized/427.",
     "security policy"),
    ("convert: width or height exceeds limit `x.png' @ error/cache.c/OpenPixelCache/3909.", "too large"),
    ("", "without an error"),
    ("magick: improper image header `input.png' @ error/png.c/ReadPNGImage/4107.", "improper image header"),
])
def test_summarize_error(stderr, expected):
    assert expected in summarize_error(stderr)


def test_run_rejects_non_string_args(tmp_path):
    eng = MagickEngine(Path("magick"), "7.0.0", 7, False, tmp_path)
    with pytest.raises(TypeError):
        magick.run(eng, ["-version", 5], cwd=tmp_path)


def test_find_engine_reports_missing(monkeypatch):
    monkeypatch.delenv("ABLELINE_MAGICK", raising=False)
    monkeypatch.setattr(magick, "_bundled_candidates", lambda: [])
    monkeypatch.setattr(magick, "_system_candidates", lambda: [])
    with pytest.raises(magick.MagickError, match="not found"):
        magick.find_engine()
