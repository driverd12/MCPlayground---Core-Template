#!/usr/bin/env python3
"""Generate a cute pixel-office launcher icon without external image deps."""

from __future__ import annotations

import argparse
import struct
import zlib
from pathlib import Path


Palette = dict[str, tuple[int, int, int, int]]


PALETTE: Palette = {
    "bg": (21, 27, 43, 255),
    "floor": (58, 82, 114, 255),
    "desk": (138, 96, 52, 255),
    "desk_shadow": (104, 72, 40, 255),
    "monitor": (122, 225, 214, 255),
    "monitor_dark": (43, 87, 97, 255),
    "coffee": (214, 189, 140, 255),
    "plant": (86, 185, 112, 255),
    "pot": (173, 157, 145, 255),
    "chair": (236, 123, 101, 255),
    "agent": (255, 170, 94, 255),
    "agent_dark": (204, 114, 51, 255),
    "eye": (36, 32, 40, 255),
    "paper": (238, 240, 247, 255),
    "spark": (255, 233, 136, 255),
    "outline": (12, 14, 20, 255),
}


def chunk(tag: bytes, data: bytes) -> bytes:
    payload = tag + data
    return (
        struct.pack("!I", len(data))
        + payload
        + struct.pack("!I", zlib.crc32(payload) & 0xFFFFFFFF)
    )


def write_png(path: Path, pixels: list[list[tuple[int, int, int, int]]]) -> None:
    height = len(pixels)
    width = len(pixels[0]) if height else 0
    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for r, g, b, a in row:
            raw.extend((r, g, b, a))
    ihdr = struct.pack("!IIBBBBB", width, height, 8, 6, 0, 0, 0)
    payload = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")
    path.write_bytes(payload)


def build_canvas(size: int) -> list[list[tuple[int, int, int, int]]]:
    return [[PALETTE["bg"] for _ in range(size)] for _ in range(size)]


def fill_rect(
    pixels: list[list[tuple[int, int, int, int]]],
    x: int,
    y: int,
    w: int,
    h: int,
    color: tuple[int, int, int, int],
) -> None:
    max_y = len(pixels)
    max_x = len(pixels[0]) if max_y else 0
    for row in range(max(0, y), min(max_y, y + h)):
        for col in range(max(0, x), min(max_x, x + w)):
            pixels[row][col] = color


def dot(pixels: list[list[tuple[int, int, int, int]]], x: int, y: int, color: tuple[int, int, int, int]) -> None:
    if 0 <= y < len(pixels) and 0 <= x < len(pixels[y]):
        pixels[y][x] = color


def draw_scene(pixels: list[list[tuple[int, int, int, int]]]) -> None:
    size = len(pixels)
    scale = max(1, size // 32)
    fill_rect(pixels, 0, size // 2, size, size // 2, PALETTE["floor"])

    desk_x = 7 * scale
    desk_y = 17 * scale
    desk_w = 18 * scale
    desk_h = 8 * scale
    fill_rect(pixels, desk_x, desk_y, desk_w, desk_h, PALETTE["desk"])
    fill_rect(pixels, desk_x, desk_y + desk_h - scale, desk_w, scale, PALETTE["desk_shadow"])
    fill_rect(pixels, desk_x + 2 * scale, desk_y + desk_h, 2 * scale, 4 * scale, PALETTE["desk_shadow"])
    fill_rect(pixels, desk_x + desk_w - 4 * scale, desk_y + desk_h, 2 * scale, 4 * scale, PALETTE["desk_shadow"])

    fill_rect(pixels, 10 * scale, 10 * scale, 10 * scale, 6 * scale, PALETTE["monitor_dark"])
    fill_rect(pixels, 11 * scale, 11 * scale, 8 * scale, 4 * scale, PALETTE["monitor"])
    fill_rect(pixels, 13 * scale, 16 * scale, 4 * scale, scale, PALETTE["outline"])
    fill_rect(pixels, 12 * scale, 17 * scale, 6 * scale, scale, PALETTE["outline"])

    fill_rect(pixels, 21 * scale, 13 * scale, 2 * scale, 3 * scale, PALETTE["coffee"])
    fill_rect(pixels, 23 * scale, 14 * scale, scale, scale, PALETTE["coffee"])

    fill_rect(pixels, 4 * scale, 16 * scale, 3 * scale, 4 * scale, PALETTE["pot"])
    fill_rect(pixels, 4 * scale, 14 * scale, scale, 2 * scale, PALETTE["plant"])
    fill_rect(pixels, 5 * scale, 13 * scale, scale, 3 * scale, PALETTE["plant"])
    fill_rect(pixels, 6 * scale, 14 * scale, scale, 2 * scale, PALETTE["plant"])

    fill_rect(pixels, 24 * scale, 22 * scale, 4 * scale, 5 * scale, PALETTE["chair"])
    fill_rect(pixels, 25 * scale, 19 * scale, 2 * scale, 3 * scale, PALETTE["chair"])

    fill_rect(pixels, 13 * scale, 18 * scale, 6 * scale, 6 * scale, PALETTE["agent"])
    fill_rect(pixels, 14 * scale, 19 * scale, 4 * scale, 4 * scale, PALETTE["agent_dark"])
    dot(pixels, 15 * scale, 20 * scale, PALETTE["eye"])
    dot(pixels, 17 * scale, 20 * scale, PALETTE["eye"])
    fill_rect(pixels, 14 * scale, 24 * scale, scale, 4 * scale, PALETTE["agent_dark"])
    fill_rect(pixels, 17 * scale, 24 * scale, scale, 4 * scale, PALETTE["agent_dark"])

    fill_rect(pixels, 23 * scale, 6 * scale, 5 * scale, 6 * scale, PALETTE["paper"])
    fill_rect(pixels, 24 * scale, 7 * scale, 3 * scale, scale, PALETTE["monitor_dark"])
    fill_rect(pixels, 24 * scale, 9 * scale, 3 * scale, scale, PALETTE["monitor_dark"])

    for offset in range(4):
        dot(pixels, (7 + offset) * scale, 6 * scale, PALETTE["spark"])
        dot(pixels, 25 * scale, (3 + offset) * scale, PALETTE["spark"])


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the Agent Office launcher icon.")
    parser.add_argument("--out", required=True, help="Output PNG path.")
    parser.add_argument("--size", type=int, default=256, help="Output square size in pixels.")
    args = parser.parse_args()

    size = max(64, int(args.size))
    pixels = build_canvas(size)
    draw_scene(pixels)
    out_path = Path(args.out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    write_png(out_path, pixels)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
