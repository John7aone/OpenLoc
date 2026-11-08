#!/usr/bin/env python3
"""OpenLoc 应用图标：蓝底上一个清晰的大写字母 O。

窗口、任务栏、托盘和安装包都从这张图来。
侧栏左上角的 OL 品牌块不在这个脚本里，不要改成 O。
只用标准库，方便 Windows 打包脚本直接跑。

Run: python3 src-tauri/icons/generate-icon.py
Then: npx @tauri-apps/cli icon src-tauri/icons/icon.png
"""
import struct
import zlib
from pathlib import Path

SIZE = 512
# 和界面主色一致。#2563eb 在左上，#1d4ed8 在右下。
BLUE_A = (0x25, 0x63, 0xEB)
BLUE_B = (0x1D, 0x4E, 0xD8)
WHITE = (255, 255, 255)


def lerp(a, b, t):
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return tuple(int(a[i] + (b[i] - a[i]) * t + 0.5) for i in range(3))


def o_cover(x, y, size):
    """大写 O：略高的超椭圆环，笔画粗到 32px 还能看见中间的洞。"""
    cx = (size - 1) / 2
    cy = (size - 1) / 2
    rx = size * 0.355
    ry = size * 0.395
    stroke = size * 0.118
    n = 2.25
    dx = abs(x - cx)
    dy = abs(y - cy)
    outer = (dx / rx) ** n + (dy / ry) ** n
    ix = rx - stroke
    iy = ry - stroke
    inner = (dx / ix) ** n + (dy / iy) ** n
    if outer >= 1.06:
        return 0.0
    if inner <= 0.94:
        return 0.0
    cover = 1.0
    if outer > 1.0:
        cover = min(cover, max(0.0, (1.06 - outer) / 0.06))
    if inner < 1.0:
        cover = min(cover, max(0.0, (inner - 0.94) / 0.06))
    return cover


def sample(x, y, size):
    bg = lerp(BLUE_A, BLUE_B, (x + y) / (2 * (size - 1)))
    letter = o_cover(x, y, size)
    rgb = tuple(int(WHITE[i] * letter + bg[i] * (1 - letter) + 0.5) for i in range(3))
    return (rgb[0], rgb[1], rgb[2], 255)


def render(size, ss=4):
    """ss 倍超采样后再平均，边缘更干净。"""
    raw = bytearray(size * size * 4)
    step = 1.0 / ss
    origin = step / 2
    for y in range(size):
        row = bytearray(size * 4)
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    px = x + origin + sx * step
                    py = y + origin + sy * step
                    p = sample(px, py, size)
                    for i in range(4):
                        acc[i] += p[i]
            n = ss * ss
            row[x * 4 : x * 4 + 4] = bytes(v // n for v in acc)
        raw[y * size * 4 : (y + 1) * size * 4] = row
    return bytes(raw)


def chunk(typ, data):
    c = struct.pack(">I", len(data)) + typ + data
    return c + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)


def to_png(rgba, size):
    raw = b"".join(b"\x00" + rgba[y * size * 4 : (y + 1) * size * 4] for y in range(size))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def downsample(rgba, size, dst):
    if size % dst != 0:
        raise SystemExit(f"cannot downsample {size} to {dst}")
    out = bytearray(dst * dst * 4)
    scale = size // dst
    area = scale * scale
    for y in range(dst):
        for x in range(dst):
            acc = [0, 0, 0, 0]
            for sy in range(scale):
                base = ((y * scale + sy) * size + x * scale) * 4
                for sx in range(scale):
                    i = base + sx * 4
                    for c in range(4):
                        acc[c] += rgba[i + c]
            j = (y * dst + x) * 4
            out[j : j + 4] = bytes(v // area for v in acc)
    return bytes(out)


def assert_reads_as_o(rgba, size):
    """中间必须是蓝洞，笔画上是白，不能再是一整块没有字母的纯色。"""

    def px(x, y):
        i = (y * size + x) * 4
        return rgba[i : i + 4]

    mid = px(size // 2, size // 2)
    if mid[2] < 160 or mid[0] > 90 or mid[1] > 150:
        raise SystemExit(f"{size}px 图标中心不是 O 的空洞：{tuple(mid)}")
    top = px(size // 2, max(0, int(size * 0.16)))
    if top[0] < 200 or top[1] < 200 or top[2] < 200:
        raise SystemExit(f"{size}px O 的上沿不够白：{tuple(top)}")
    side = px(max(0, int(size * 0.16)), size // 2)
    if side[0] < 200 or side[1] < 200 or side[2] < 200:
        raise SystemExit(f"{size}px O 的左侧不够白：{tuple(side)}")
    # 洞要比笔画小一圈，左右不能也是洞。
    if mid[0] > 180 and mid[1] > 180 and mid[2] > 180:
        raise SystemExit(f"{size}px 中心发白，O 没有洞")
    teal = 0
    for i in range(0, len(rgba), 4):
        r, g, b = rgba[i], rgba[i + 1], rgba[i + 2]
        if abs(r - 0x0E) < 12 and abs(g - 0x74) < 12 and abs(b - 0x90) < 12:
            teal += 1
    if teal > (size * size) // 20:
        raise SystemExit(f"{size}px 图标仍是旧的青绿纯色块")


def main():
    rgba = render(SIZE, ss=3)
    assert_reads_as_o(rgba, SIZE)
    for dst in (128, 32, 16):
        assert_reads_as_o(downsample(rgba, SIZE, dst), dst)
    png = to_png(rgba, SIZE)
    out = Path(__file__).with_name("icon.png")
    out.write_bytes(png)
    print(f"Wrote {out} ({len(png)} bytes)")


if __name__ == "__main__":
    main()
