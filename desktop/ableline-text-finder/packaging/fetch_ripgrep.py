"""Download the pinned official ripgrep Windows binary and verify it.

Source: official GitHub Releases of https://github.com/BurntSushi/ripgrep
Integrity: the archive's SHA-256 must equal the value pinned below (recorded
from the release and cross-checked against the .sha256 file the ripgrep
maintainers publish next to each release asset). The published checksum is
also downloaded and compared, so both must agree.

Usage:  python packaging/fetch_ripgrep.py   ->  vendor/ripgrep/rg.exe
"""

from __future__ import annotations

import hashlib
import io
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

RG_VERSION = "15.1.0"
ASSET = f"ripgrep-{RG_VERSION}-x86_64-pc-windows-msvc.zip"
PINNED_SHA256 = "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a"
BASE_URL = f"https://github.com/BurntSushi/ripgrep/releases/download/{RG_VERSION}/"
KEEP = ("rg.exe", "COPYING", "LICENSE-MIT", "UNLICENSE")

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "vendor" / "ripgrep"


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "ableline-build"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def main() -> int:
    print(f"Downloading {BASE_URL}{ASSET}")
    data = fetch(BASE_URL + ASSET)
    actual = hashlib.sha256(data).hexdigest()
    published = fetch(BASE_URL + ASSET + ".sha256").decode("ascii", "replace")
    published_hashes = {tok.lower() for tok in published.split() if len(tok) == 64}
    print(f"SHA-256 actual:    {actual}")
    print(f"SHA-256 pinned:    {PINNED_SHA256}")
    print(f"SHA-256 published: {', '.join(sorted(published_hashes)) or '(none)'}")
    if actual != PINNED_SHA256:
        print("ERROR: archive does not match the pinned SHA-256.", file=sys.stderr)
        return 1
    if PINNED_SHA256 not in published_hashes:
        print("ERROR: archive does not match the checksum published with the release.", file=sys.stderr)
        return 1

    if DEST.exists():
        shutil.rmtree(DEST)
    DEST.mkdir(parents=True)
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for info in zf.infolist():
            name = info.filename.rsplit("/", 1)[-1]
            if name in KEEP and not info.is_dir():
                (DEST / name).write_bytes(zf.read(info))
    missing = [k for k in KEEP if not (DEST / k).is_file()]
    if missing:
        print(f"ERROR: missing from archive: {missing}", file=sys.stderr)
        return 1
    (DEST / "VERSION.txt").write_text(f"ripgrep {RG_VERSION}\n{ASSET}\nsha256 {actual}\n", encoding="utf-8")
    print(f"Verified ripgrep {RG_VERSION} extracted to {DEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
