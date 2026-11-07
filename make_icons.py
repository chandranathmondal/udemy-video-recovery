#!/usr/bin/env python3
"""Generate simple solid-color PNG icons with a 'play' triangle for the extension."""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(OUT, exist_ok=True)

BG = (162, 0, 237)      # Udemy-ish purple
FG = (255, 255, 255)    # white play triangle


def inside_triangle(x, y, size):
    # A play triangle centered in the icon.
    left = size * 0.34
    right = size * 0.68
    top = size * 0.30
    bottom = size * 0.70
    if x < left or x > right:
        return False
    # interpolate the triangle's vertical half-height across its width
    t = (x - left) / (right - left)  # 0..1
    half = (1 - t) * (bottom - top) / 2
    midy = (top + bottom) / 2
    return midy - half <= y <= midy + half


def make_png(size, path):
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type 0 for each scanline
        for x in range(size):
            if inside_triangle(x, y, size):
                r, g, b = FG
            else:
                r, g, b = BG
            raw += bytes((r, g, b))

    def chunk(typ, data):
        c = typ + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit, truecolor RGB
    idat = zlib.compress(bytes(raw), 9)
    png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)
    print("wrote", path)


for s in (16, 48, 128):
    make_png(s, os.path.join(OUT, f"icon{s}.png"))
