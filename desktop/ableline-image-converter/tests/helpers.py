"""Test helpers: minimal PNG writer and image-size readers (no third-party deps)."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path


def write_png(path: Path, width: int, height: int, rgba: bool = False) -> Path:
    channels = 4 if rgba else 3
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            px = [(x * 255) // max(width - 1, 1), (y * 255) // max(height - 1, 1), 128]
            if rgba:
                px.append(0 if x < width // 2 else 255)
            row += bytes(px)
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6 if rgba else 2, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", raw) + chunk(b"IEND", b""))
    return path


def image_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if data.startswith(b"\x89PNG"):
        return struct.unpack(">II", data[16:24])
    if data.startswith(b"BM"):
        w, h = struct.unpack("<ii", data[18:26])
        return w, abs(h)
    if data.startswith(b"\xff\xd8"):
        i = 2
        while i < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2):
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return w, h
            seg_len = struct.unpack(">H", data[i + 2:i + 4])[0]
            i += 2 + seg_len
    raise ValueError(f"cannot read size of {path}")
