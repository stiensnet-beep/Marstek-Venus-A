#!/usr/bin/env python3
"""Generate the PNG assets required by the Homey app store.

Equivalent to tools/generate-images.js, but without a Node.js dependency
(uses only the Python standard library).

Usage:
    python tools/generate_images.py

Output:
    assets/images/small.png                        250 x 250
    assets/images/large.png                        500 x 500
    assets/images/xlarge.png                      1000 x 1000
    drivers/venus_a/assets/images/small.png         75 x  75
    drivers/venus_a/assets/images/large.png        500 x 500
    drivers/venus_a/assets/images/xlarge.png      1000 x 1000
"""

from __future__ import annotations

import math
import os
import struct
import zlib

APP_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TARGETS = [
    ("assets/images/small.png", 250),
    ("assets/images/large.png", 500),
    ("assets/images/xlarge.png", 1000),
    ("drivers/venus_a/assets/images/small.png", 75),
    ("drivers/venus_a/assets/images/large.png", 500),
    ("drivers/venus_a/assets/images/xlarge.png", 1000),
]


# --------------------------------------------------------------------------
# PNG encoding (truecolour with alpha, no compression tricks)
# --------------------------------------------------------------------------

def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def encode_png(width: int, height: int, rgba: bytes) -> bytes:
    signature = b"\x89PNG\r\n\x1a\n"

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)

    stride = width * 4
    raw = bytearray((stride + 1) * height)
    for y in range(height):
        row_start = y * (stride + 1)
        raw[row_start] = 0  # filter type: none
        raw[row_start + 1: row_start + 1 + stride] = rgba[y * stride:(y + 1) * stride]

    idat = zlib.compress(bytes(raw), 9)

    return (
        signature
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", idat)
        + _chunk(b"IEND", b"")
    )


# --------------------------------------------------------------------------
# Drawing helpers (signed distance fields in unit coordinate space 0..1)
# --------------------------------------------------------------------------

def clamp01(value: float) -> float:
    if value < 0.0:
        return 0.0
    if value > 1.0:
        return 1.0
    return value


def sd_round_rect(px, py, cx, cy, half_width, half_height, radius) -> float:
    dx = abs(px - cx) - (half_width - radius)
    dy = abs(py - cy) - (half_height - radius)
    ox = dx if dx > 0.0 else 0.0
    oy = dy if dy > 0.0 else 0.0
    return math.sqrt(ox * ox + oy * oy) + min(max(dx, dy), 0.0) - radius


def blend(state, red, green, blue, coverage) -> None:
    if coverage <= 0.0:
        return
    out_alpha = coverage + state[3] * (1.0 - coverage)
    if out_alpha <= 0.0:
        return
    state[0] = (red * coverage + state[0] * state[3] * (1.0 - coverage)) / out_alpha
    state[1] = (green * coverage + state[1] * state[3] * (1.0 - coverage)) / out_alpha
    state[2] = (blue * coverage + state[2] * state[3] * (1.0 - coverage)) / out_alpha
    state[3] = out_alpha


def render(size: int) -> bytes:
    rgba = bytearray(size * size * 4)
    offset = 0

    for y in range(size):
        py = (y + 0.5) / size
        for x in range(size):
            px = (x + 0.5) / size

            state = [0.0, 0.0, 0.0, 0.0]

            # Background: rounded square with a vertical brand gradient
            background = clamp01(0.5 - sd_round_rect(px, py, 0.5, 0.5, 0.5, 0.5, 0.24) * size)
            if background > 0.0:
                state[0] = 11.0 + (0.0 - 11.0) * py
                state[1] = 40.0 + (163.0 - 40.0) * py
                state[2] = 72.0 + (224.0 - 72.0) * py
                state[3] = background

            # Battery glyph, only evaluated inside its own bounding box
            if background > 0.0 and 0.13 <= px <= 0.83 and 0.26 <= py <= 0.74:
                body = sd_round_rect(px, py, 0.465, 0.5, 0.255, 0.17, 0.055)
                blend(state, 255.0, 255.0, 255.0,
                      clamp01(0.5 - (abs(body) - 0.021) * size))

                terminal = sd_round_rect(px, py, 0.755, 0.5, 0.035, 0.075, 0.022)
                blend(state, 255.0, 255.0, 255.0, clamp01(0.5 - terminal * size))

                for center_x in (0.32, 0.465, 0.61):
                    bar = sd_round_rect(px, py, center_x, 0.5, 0.042, 0.088, 0.02)
                    blend(state, 53.0, 224.0, 138.0, clamp01(0.5 - bar * size))

            rgba[offset] = int(max(0.0, min(255.0, state[0])))
            rgba[offset + 1] = int(max(0.0, min(255.0, state[1])))
            rgba[offset + 2] = int(max(0.0, min(255.0, state[2])))
            rgba[offset + 3] = int(max(0.0, min(255.0, state[3] * 255.0)))
            offset += 4

    return bytes(rgba)


def main() -> None:
    cache = {}

    for relative_path, size in TARGETS:
        if size not in cache:
            print(f"Rendering {size}x{size} ... ", end="", flush=True)
            cache[size] = encode_png(size, size, render(size))
            print("ok")

        destination = os.path.join(APP_ROOT, *relative_path.split("/"))
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        with open(destination, "wb") as handle:
            handle.write(cache[size])
        print(f"Wrote {relative_path} ({size}x{size})")

    print("Klaar.")


if __name__ == "__main__":
    main()
