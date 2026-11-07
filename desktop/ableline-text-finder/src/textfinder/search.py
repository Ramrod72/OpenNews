"""ripgrep integration: locating rg, building the command line, running a search.

This module has no Qt dependency so it can be tested on its own.

Safety properties:
* rg is started with an argument list (never ``shell=True``), stdin closed.
* The query is always passed with ``-e`` and ``--fixed-strings`` so it is a
  literal string and can never be interpreted as an option or a regex.
* ``--no-config`` (and removing RIPGREP_CONFIG_PATH from the environment)
  prevents any user/system ripgrep configuration from changing behaviour.
* Symbolic links and junctions are not followed (ripgrep's default; we never
  pass ``--follow``). Hidden files and files excluded by .gitignore/.ignore
  rules are skipped (ripgrep's default). Binary files are skipped.
* rg only reads files. This application never writes to searched folders.
"""

from __future__ import annotations

import base64
import enum
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

DEFAULT_MAX_RESULTS = 10_000
MAX_LINE_CHARS = 1_000          # matching text is truncated for display
MAX_STORED_ERRORS = 500         # error messages kept for the details dialog
_EXT_RE = re.compile(r"^[A-Za-z0-9_+\-]{1,32}$")


class RipgrepNotFound(Exception):
    """Raised when no usable rg executable can be located."""


class SearchError(ValueError):
    """Raised for invalid user input (shown to the user verbatim)."""


# --------------------------------------------------------------------------- rg


def _exe_name() -> str:
    return "rg.exe" if os.name == "nt" else "rg"


def bundled_rg_path() -> Path:
    """Location of the rg binary shipped with the application."""
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    else:
        base = Path(__file__).resolve().parents[2] / "vendor"
    return base / "ripgrep" / _exe_name()


def find_rg() -> Path:
    """Return the rg executable to use.

    Order: ``ABLELINE_RG`` environment variable (tests/dev), the bundled copy,
    then - only when running from source - ``rg`` on PATH. The packaged
    application never falls back to PATH, so it always uses the verified,
    bundled binary.
    """
    override = os.environ.get("ABLELINE_RG")
    if override:
        p = Path(override)
        if p.is_file():
            return p
        raise RipgrepNotFound(f"ABLELINE_RG points to a missing file: {override}")
    bundled = bundled_rg_path()
    if bundled.is_file():
        return bundled
    if not getattr(sys, "frozen", False):
        found = shutil.which("rg")
        if found:
            return Path(found)
    raise RipgrepNotFound(
        "The search engine (ripgrep) could not be found. Please reinstall "
        f"Ableline Text Finder. Expected: {bundled}"
    )


def rg_version(rg: Path) -> str:
    out = subprocess.run(
        [str(rg), "--version"], capture_output=True, text=True, timeout=15,
        stdin=subprocess.DEVNULL, creationflags=_creationflags(), env=_clean_env(),
    )
    return out.stdout.strip().splitlines()[0] if out.stdout else ""


def _creationflags() -> int:
    # Do not flash a console window when started from the windowed GUI.
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _clean_env() -> dict[str, str]:
    env = dict(os.environ)
    env.pop("RIPGREP_CONFIG_PATH", None)
    return env


# ---------------------------------------------------------------------- options


def parse_extensions(text: str | list[str]) -> list[str]:
    """Normalise user-entered extensions: 'TXT, .csv log' -> ['txt','csv','log'].

    Only simple alphanumeric extensions are accepted so user input can never
    become an arbitrary glob pattern.
    """
    items = text if isinstance(text, list) else re.split(r"[\s,;]+", text)
    result: list[str] = []
    for raw in items:
        ext = raw.strip().lstrip("*").lstrip(".").lower()
        if not ext:
            continue
        if not _EXT_RE.match(ext):
            raise SearchError(f"'{raw.strip()}' is not a valid file extension. Use letters and digits only, e.g. txt, csv, log.")
        if ext not in result:
            result.append(ext)
    return result


@dataclass(frozen=True)
class SearchOptions:
    folder: Path
    query: str
    recursive: bool = True
    extensions: tuple[str, ...] = ()
    case_sensitive: bool = False
    max_results: int = DEFAULT_MAX_RESULTS


def validate(folder: str | Path, query: str, recursive: bool = True,
             extensions: str | list[str] = "", case_sensitive: bool = False,
             max_results: int = DEFAULT_MAX_RESULTS) -> SearchOptions:
    """Validate user input and build SearchOptions (raises SearchError)."""
    if not str(folder).strip():
        raise SearchError("Choose a folder to search.")
    path = Path(str(folder).strip()).expanduser()
    if not path.exists():
        raise SearchError(f"The folder does not exist:\n{path}")
    if not path.is_dir():
        raise SearchError(f"This is not a folder:\n{path}")
    if not os.access(path, os.R_OK):
        raise SearchError(f"You do not have permission to read this folder:\n{path}")
    if not query or not query.strip():
        raise SearchError("Enter a word or phrase to search for.")
    if "\n" in query or "\r" in query:
        raise SearchError("The search text must be a single line.")
    return SearchOptions(
        folder=path.resolve(), query=query, recursive=recursive,
        extensions=tuple(parse_extensions(extensions)),
        case_sensitive=case_sensitive, max_results=max(1, int(max_results)),
    )


def build_command(rg: Path, opts: SearchOptions) -> list[str]:
    cmd = [
        str(rg),
        "--json",            # machine-readable output
        "--no-config",       # ignore any ripgrep config files
        "--fixed-strings",   # literal search - never a regex
        "--line-number",
        "--with-filename",
    ]
    cmd.append("--case-sensitive" if opts.case_sensitive else "--ignore-case")
    if not opts.recursive:
        cmd += ["--max-depth", "1"]
    for ext in opts.extensions:
        cmd += ["--iglob", f"*.{ext}"]
    cmd += ["-e", opts.query, "--", str(opts.folder)]
    return cmd


# ---------------------------------------------------------------------- results


@dataclass(frozen=True)
class Match:
    path: str
    line_number: int
    text: str

    @property
    def filename(self) -> str:
        return os.path.basename(self.path)


class Status(enum.Enum):
    COMPLETE = "complete"
    NO_MATCHES = "no_matches"
    COMPLETED_WITH_ERRORS = "completed_with_errors"
    TRUNCATED = "truncated"
    CANCELLED = "cancelled"
    FAILED = "failed"


@dataclass
class SearchResult:
    status: Status
    match_count: int = 0
    file_count: int = 0
    errors: list[str] = field(default_factory=list)
    error_count: int = 0
    elapsed: float = 0.0
    message: str = ""

    def summary(self) -> str:
        files = f"{self.file_count:,} file" + ("" if self.file_count == 1 else "s")
        lines = f"{self.match_count:,} matching line" + ("" if self.match_count == 1 else "s")
        s = self.status
        if s is Status.FAILED:
            return f"Search failed: {self.message}"
        if s is Status.CANCELLED:
            return f"Search cancelled. Showing {lines} found before cancelling (results are incomplete)."
        if s is Status.TRUNCATED:
            tail = f" {self.error_count:,} error(s) also occurred." if self.error_count else ""
            return f"Showing the first {lines} in {files}. The result limit was reached, so the search was stopped early.{tail}"
        if s is Status.COMPLETED_WITH_ERRORS:
            return (f"Found {lines} in {files}, but {self.error_count:,} item(s) could not be read "
                    "(see Details). Results may be incomplete.")
        if s is Status.NO_MATCHES:
            return "No matches found."
        return f"Found {lines} in {files}."


def _text_of(obj: dict | None) -> str:
    """Decode ripgrep's {"text": ...} / {"bytes": base64} data objects."""
    if not obj:
        return ""
    if "text" in obj:
        return obj["text"]
    try:
        return base64.b64decode(obj.get("bytes", "")).decode("utf-8", errors="replace")
    except (ValueError, TypeError):
        return ""


def parse_line(raw: bytes) -> tuple[str, object] | None:
    """Parse one JSON line of rg output. Returns (type, payload) or None."""
    try:
        msg = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None
    kind = msg.get("type")
    data = msg.get("data") or {}
    if kind == "match":
        text = _text_of(data.get("lines")).rstrip("\r\n")
        if len(text) > MAX_LINE_CHARS:
            text = text[:MAX_LINE_CHARS] + " …"
        return "match", Match(_text_of(data.get("path")), int(data.get("line_number") or 0), text)
    if kind == "begin":
        return "begin", _text_of(data.get("path"))
    return kind, data


class Search:
    """One ripgrep search. ``run`` blocks; ``cancel`` may be called from any thread."""

    def __init__(self, opts: SearchOptions, rg: Path | None = None):
        self.opts = opts
        self.rg = rg
        self._cancel = threading.Event()
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self.returncode: int | None = None

    def cancel(self) -> None:
        self._cancel.set()
        self._kill()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def _kill(self) -> None:
        with self._lock:
            p = self._proc
            if p is not None and p.poll() is None:
                try:
                    p.kill()      # TerminateProcess on Windows
                except OSError:
                    pass

    def run(self, on_matches: Callable[[list[Match]], None] | None = None,
            batch_size: int = 250, batch_interval: float = 0.1) -> SearchResult:
        start = time.monotonic()
        try:
            rg = self.rg or find_rg()
        except RipgrepNotFound as exc:
            return SearchResult(Status.FAILED, message=str(exc))
        cmd = build_command(rg, self.opts)

        with self._lock:
            if self._cancel.is_set():
                return SearchResult(Status.CANCELLED)
            try:
                self._proc = subprocess.Popen(
                    cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    creationflags=_creationflags(), env=_clean_env(),
                )
            except OSError as exc:
                return SearchResult(Status.FAILED, message=f"Could not start the search engine: {exc}")
        proc = self._proc

        errors: list[str] = []
        error_count = [0]

        def read_stderr() -> None:
            for raw in proc.stderr:
                line = raw.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                error_count[0] += 1
                if len(errors) < MAX_STORED_ERRORS:
                    errors.append(line[4:] if line.startswith("rg: ") else line)

        err_thread = threading.Thread(target=read_stderr, daemon=True)
        err_thread.start()

        count = 0
        files: set[str] = set()
        truncated = False
        batch: list[Match] = []
        last_flush = time.monotonic()

        def flush() -> None:
            nonlocal batch, last_flush
            if batch and on_matches:
                on_matches(batch)
            batch = []
            last_flush = time.monotonic()

        try:
            for raw in proc.stdout:
                if self._cancel.is_set():
                    break
                parsed = parse_line(raw)
                if parsed is None or parsed[0] != "match":
                    continue
                m: Match = parsed[1]  # type: ignore[assignment]
                count += 1
                files.add(m.path)
                batch.append(m)
                if len(batch) >= batch_size or time.monotonic() - last_flush >= batch_interval:
                    flush()
                if count >= self.opts.max_results:
                    truncated = True
                    break
        finally:
            if truncated or self._cancel.is_set():
                self._kill()
            flush()
            try:
                proc.stdout.close()
            except OSError:
                pass
            self.returncode = proc.wait()
            err_thread.join(timeout=5)

        result = SearchResult(
            Status.COMPLETE, match_count=count, file_count=len(files), errors=errors,
            error_count=error_count[0], elapsed=time.monotonic() - start,
        )
        rc = self.returncode
        if self._cancel.is_set():
            result.status = Status.CANCELLED
        elif truncated:
            result.status = Status.TRUNCATED
        elif rc == 2 or result.error_count:
            result.status = Status.COMPLETED_WITH_ERRORS
            if not result.errors:
                result.errors.append("ripgrep reported an error but gave no details.")
                result.error_count = max(result.error_count, 1)
        elif rc == 1 or count == 0:
            result.status = Status.NO_MATCHES
        elif rc != 0:
            result.status = Status.FAILED
            result.message = f"The search engine exited unexpectedly (code {rc})."
        return result


def run_search(opts: SearchOptions, on_matches: Callable[[list[Match]], None] | None = None,
               rg: Path | None = None) -> SearchResult:
    """Convenience wrapper: run a search to completion."""
    return Search(opts, rg).run(on_matches)
