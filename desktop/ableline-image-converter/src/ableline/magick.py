"""Locating and invoking the ImageMagick command-line tool.

ImageMagick is always run through ``subprocess`` with an argument list
(never a shell), with a private configuration path that points at the
restrictive ``policy.xml`` shipped with this application.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

IS_WINDOWS = sys.platform == "win32"
DEFAULT_TIMEOUT_S = 300

# Command-line resource limits, applied in addition to policy.xml.
RESOURCE_LIMITS: tuple[tuple[str, str], ...] = (
    ("memory", "1GiB"),
    ("map", "2GiB"),
    ("disk", "4GiB"),
    ("area", "256MP"),
    ("width", "16KP"),
    ("height", "16KP"),
    ("thread", "4"),
    ("time", "300"),
)


class MagickError(RuntimeError):
    """ImageMagick is missing or a conversion command failed."""


class Cancelled(Exception):
    """The running command was cancelled by the user."""


@dataclass(frozen=True)
class MagickEngine:
    executable: Path
    version: str
    major: int
    bundled: bool
    policy_dir: Path

    @property
    def display_name(self) -> str:
        where = "bundled" if self.bundled else "system"
        return f"ImageMagick {self.version} ({where})"


def app_base_dir() -> Path:
    """Directory holding application resources (PyInstaller aware)."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent


def policy_dir() -> Path:
    return app_base_dir() / "resources"


def _bundled_candidates() -> list[Path]:
    exe = "magick.exe" if IS_WINDOWS else "magick"
    roots = [app_base_dir()]
    if getattr(sys, "frozen", False):
        roots.append(Path(sys.executable).parent)
    else:
        # Development checkout: <project>/vendor/imagemagick/
        roots.append(Path(__file__).resolve().parents[2] / "vendor")
    return [root / "imagemagick" / exe for root in roots]


def _system_candidates() -> list[Path]:
    found: list[Path] = []
    names = ["magick"]
    if not IS_WINDOWS:
        # ImageMagick 6 for Linux/macOS development only. On Windows,
        # "convert" is the unrelated system disk utility and is never used.
        names.append("convert")
    for name in names:
        hit = shutil.which(name)
        if hit:
            found.append(Path(hit))
    return found


def _subprocess_kwargs() -> dict:
    kwargs: dict = {"stdin": subprocess.DEVNULL, "shell": False}
    if IS_WINDOWS:
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW  # no console flash
    return kwargs


def build_environment(engine_dir: Path | None, policy: Path, temp_dir: Path | None = None) -> dict[str, str]:
    """Environment for the ImageMagick child process."""
    env = dict(os.environ)
    # Drop variables that could redirect ImageMagick to other configs/modules.
    for var in list(env):
        if var.upper().startswith("MAGICK_"):
            del env[var]
    paths = [str(policy)]
    if engine_dir is not None:
        env["MAGICK_HOME"] = str(engine_dir)
        paths.append(str(engine_dir))
    env["MAGICK_CONFIGURE_PATH"] = os.pathsep.join(paths)
    if temp_dir is not None:
        env["MAGICK_TEMPORARY_PATH"] = str(temp_dir)
    return env


_VERSION_RE = re.compile(r"Version:\s*ImageMagick\s+(\d+)\.(\d+)\.(\d+)(-\d+)?")


def _probe(executable: Path, bundled: bool) -> MagickEngine | None:
    pol = policy_dir()
    env = build_environment(executable.parent if bundled else None, pol)
    try:
        proc = subprocess.run(
            [str(executable), "-version"],
            capture_output=True, text=True, timeout=15, env=env, **_subprocess_kwargs(),
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = _VERSION_RE.search(proc.stdout or "")
    if proc.returncode != 0 or not match:
        return None
    major = int(match.group(1))
    if major < 6:
        return None
    version = ".".join(match.group(i) for i in (1, 2, 3)) + (match.group(4) or "")
    return MagickEngine(executable, version, major, bundled, pol)


def find_engine() -> MagickEngine:
    """Return the ImageMagick installation to use.

    Order: ``ABLELINE_MAGICK`` override, bundled binaries, ``magick`` on PATH
    (plus ImageMagick 6 ``convert`` on non-Windows systems, for development).
    """
    override = os.environ.get("ABLELINE_MAGICK")
    candidates: list[tuple[Path, bool]] = []
    if override:
        candidates.append((Path(override), False))
    candidates += [(p, True) for p in _bundled_candidates() if p.is_file()]
    candidates += [(p, False) for p in _system_candidates()]
    for path, bundled in candidates:
        engine = _probe(path, bundled)
        if engine is not None:
            return engine
    raise MagickError(
        "ImageMagick was not found. Install ImageMagick 7 (with the 'magick' "
        "command on PATH) or use a build of this app that bundles it."
    )


_PREFIX_RE = re.compile(r"^(magick|convert)(\.exe)?:\s*", re.IGNORECASE)


def summarize_error(stderr: str) -> str:
    """Turn ImageMagick stderr into a short, user-readable message."""
    lines = [ln.strip() for ln in (stderr or "").splitlines() if ln.strip()]
    if not lines:
        return "ImageMagick failed without an error message."
    errors = [ln for ln in lines if "error" in ln.lower()] or lines
    msg = _PREFIX_RE.sub("", errors[0])
    msg = re.sub(r"\s*@\s*(error|warning|fatal)/\S+\.c/\S+/\d+\.?$", "", msg)
    lower = msg.lower()
    if "not authorized" in lower or "security policy" in lower:
        return "Blocked by the security policy (unsupported or disallowed content)."
    if "cache resources exhausted" in lower or "resource limit" in lower or "width or height exceeds" in lower:
        return "Image is too large to process within the configured resource limits."
    if "time limit exceeded" in lower:
        return "Processing took too long and was stopped."
    return msg[:300]


def _kill(proc: subprocess.Popen) -> None:
    """Stop *proc* without waiting on its pipes (a child could keep them open)."""
    proc.kill()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass
    for stream in (proc.stdout, proc.stderr):
        if stream is not None:
            stream.close()


def run(
    engine: MagickEngine,
    args: list[str],
    *,
    cwd: Path,
    cancel: threading.Event | None = None,
    timeout: float = DEFAULT_TIMEOUT_S,
) -> None:
    """Run ImageMagick with *args* (list, no shell). Raises on failure."""
    if not all(isinstance(a, str) for a in args):
        raise TypeError("arguments must be strings")
    env = build_environment(engine.executable.parent if engine.bundled else None, engine.policy_dir, cwd)
    try:
        proc = subprocess.Popen(
            [str(engine.executable), *args],
            cwd=str(cwd), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            **_subprocess_kwargs(),
        )
    except OSError as exc:
        raise MagickError(f"Could not start ImageMagick: {exc}") from exc

    deadline = time.monotonic() + timeout
    while True:
        try:
            _, stderr = proc.communicate(timeout=0.2)
            break
        except subprocess.TimeoutExpired:
            if cancel is not None and cancel.is_set():
                _kill(proc)
                raise Cancelled()
            if time.monotonic() > deadline:
                _kill(proc)
                raise MagickError("Processing took too long and was stopped.")
    if proc.returncode != 0:
        raise MagickError(summarize_error(stderr.decode("utf-8", "replace")))
