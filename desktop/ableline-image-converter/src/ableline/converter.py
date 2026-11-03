"""Conversion of single images and batches (no GUI dependencies)."""

from __future__ import annotations

import shutil
import tempfile
import threading
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

from ableline import magick
from ableline.formats import JPG, TIFF, ImageFormat, sniff_format
from ableline.magick import Cancelled, MagickEngine, MagickError
from ableline.naming import reserve_output_path
from ableline.validation import ConversionSettings, ResizeMode, ValidationError, validate_input_file


@dataclass(frozen=True)
class FileResult:
    source: Path
    ok: bool
    output: Path | None = None
    message: str = ""


@dataclass
class BatchSummary:
    results: list[FileResult] = field(default_factory=list)
    cancelled: bool = False

    @property
    def succeeded(self) -> list[FileResult]:
        return [r for r in self.results if r.ok]

    @property
    def failed(self) -> list[FileResult]:
        return [r for r in self.results if not r.ok]


def resize_geometry(settings: ConversionSettings) -> str | None:
    """ImageMagick geometry string for the requested resize, or None."""
    if settings.resize_mode is ResizeMode.PERCENT:
        return f"{settings.percent}%"
    if settings.resize_mode is ResizeMode.DIMENSIONS:
        w = settings.width or ""
        h = settings.height or ""
        if settings.keep_aspect:
            return f"{w}x{h}"          # fit within the box, aspect preserved
        return f"{w}x{h}!"             # exact size
    return None


def build_arguments(
    input_name: str, input_format: ImageFormat, output_name: str, settings: ConversionSettings
) -> list[str]:
    """Argument list for one conversion. File names are relative to the work dir."""
    args: list[str] = []
    for name, value in magick.RESOURCE_LIMITS:
        args += ["-limit", name, value]
    # Explicit coder prefixes: ImageMagick never guesses formats. [0] = first frame only.
    args.append(f"{input_format.coder}:{input_name}[0]")
    args.append("-auto-orient")
    geometry = resize_geometry(settings)
    if geometry:
        args += ["-resize", geometry]
    out_fmt = settings.output_format
    if out_fmt is JPG:
        # JPEG has no transparency; flatten onto white instead of black.
        args += ["-background", "white", "-alpha", "remove", "-alpha", "off"]
    if out_fmt.supports_quality:
        args += ["-quality", str(settings.quality)]
    if out_fmt is TIFF:
        args += ["-compress", "LZW"]
    args.append(f"{out_fmt.coder}:{output_name}")
    return args


def convert_file(
    source: Path,
    settings: ConversionSettings,
    engine: MagickEngine,
    cancel: threading.Event | None = None,
) -> FileResult:
    """Convert one file. Never raises for per-file problems; returns a FileResult.

    The original is never modified: ImageMagick works on a private copy in
    a temporary directory, and the result is written to a freshly reserved
    (previously non-existent) path in the output folder.
    """
    source = Path(source)
    try:
        in_fmt = validate_input_file(source)
    except ValidationError as exc:
        return FileResult(source, False, message=str(exc))

    reserved: Path | None = None
    work = Path(tempfile.mkdtemp(prefix="ableline-"))
    try:
        # Fixed, ASCII-only names: no ImageMagick filename syntax ([], %, @, :) can leak in.
        in_name = "input" + in_fmt.extension
        out_name = "output" + settings.output_format.extension
        shutil.copyfile(source, work / in_name)

        magick.run(engine, build_arguments(in_name, in_fmt, out_name, settings), cwd=work, cancel=cancel)

        produced = work / out_name
        if not produced.is_file() or produced.stat().st_size == 0:
            raise MagickError("ImageMagick did not produce an output file.")
        with produced.open("rb") as fh:
            if sniff_format(fh.read(16)) is not settings.output_format:
                raise MagickError("Output file has unexpected content.")

        reserved = reserve_output_path(settings.output_dir, source.stem, settings.output_format.extension)
        shutil.copyfile(produced, reserved)
        return FileResult(source, True, output=reserved, message="Converted")
    except Cancelled:
        _discard(reserved)
        return FileResult(source, False, message="Cancelled")
    except MagickError as exc:
        _discard(reserved)
        return FileResult(source, False, message=str(exc))
    except OSError as exc:
        _discard(reserved)
        return FileResult(source, False, message=f"File error: {exc.strerror or exc}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _discard(path: Path | None) -> None:
    if path is not None:
        try:
            path.unlink()
        except OSError:
            pass


def iter_batch(
    files: Iterable[Path],
    settings: ConversionSettings,
    engine: MagickEngine,
    cancel: threading.Event | None = None,
) -> Iterator[FileResult]:
    """Yield one FileResult per input, stopping early if *cancel* is set."""
    for path in files:
        if cancel is not None and cancel.is_set():
            return
        yield convert_file(Path(path), settings, engine, cancel)


def run_batch(
    files: list[Path],
    settings: ConversionSettings,
    engine: MagickEngine,
    cancel: threading.Event | None = None,
    on_result: Callable[[int, FileResult], None] | None = None,
) -> BatchSummary:
    summary = BatchSummary()
    for index, result in enumerate(iter_batch(files, settings, engine, cancel)):
        summary.results.append(result)
        if on_result is not None:
            on_result(index, result)
    summary.cancelled = bool(cancel is not None and cancel.is_set())
    return summary
