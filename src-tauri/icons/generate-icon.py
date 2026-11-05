#!/usr/bin/env python3
"""Generate OpenLoc's icon.png (teal, RGBA) without shipping a binary file.

Run: python3 src-tauri/icons/generate-icon.py
Then: npx @tauri-apps/cli icon src-tauri/icons/icon.png
"""
import zlib
import struct
from pathlib import Path

w = h = 512
raw = b"".join(b"\x00" + b"\x0e\x74\x90\xff" * w for _ in range(h))


def chunk(typ, data):
    c = struct.pack(">I", len(data)) + typ + data
    return c + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)


png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(raw))
    + chunk(b"IEND", b"")
)
out = Path(__file__).with_name("icon.png")
out.write_bytes(png)
print(f"Wrote {out} ({len(png)} bytes)")
