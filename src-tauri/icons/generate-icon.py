#!/usr/bin/env python3
"""OpenLoc 应用图标：蓝底上一个清晰的大写字母 O。

窗口、任务栏、托盘和安装包都从这张图来。侧栏左上角的 OL 品牌块不在这里改。
只用标准库，方便 Windows 打包脚本直接跑。

Run: python3 src-tauri/icons/generate-icon.py
Then: npx @tauri-apps/cli icon src-tauri/icons/icon.png
"""
import struct
import zlib
from pathlib import Path

SIZE = 512
# OpenLoc 蓝，和界面主色一致，不用青绿，也不换成别的品牌。
BLUE_A = (0x25, 0x63, 0xEB)  # #2563eb
BLUE_B = (0x1D, 0x4E, 0xD8)  # #1d4ed8
WHITE = (255, 255, 255)


def lerp(a, b, t):
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return tuple(int(a[i] + (b[i] - a[i]) * t + 0.5) for i in range(3))


def rounded_rect_cover(x, y, size, radius):
    """1 在圆角矩形内，0 在外，边缘返回 0..1。"""
    r = radius
    cx = r if x < r else size - r if x > size - r else x
    cy = r if y < r else size - r if y > size - r else y
    if cx == x and cy == y:
        return 1.0
    dx = x - cx
    dy = y - cy
    dist = (dx * dx + dy * dy) ** 0.5
    if dist >= r + 0.6:
        return 0.0
    if dist <= r - 0.6:
        return 1.0
    return max(0.0, min(1.0, r + 0.5 - dist))


def o_cover(x, y, size):
    """大写 O：略高的超椭圆环，中间留空，小尺寸还能看出洞。"""
    cx = (size - 1) / 2
    cy = (size - 1) / 2 - size * 0.012
    rx = size * 0.292
    ry = size * 0.348
    stroke = size * 0.088
    n = 2.45
    dx = abs(x - cx)
    dy = abs(y - cy)
    outer = (dx / rx) ** n + (dy / ry) ** n
    ix = rx - stroke
    iy = ry - stroke
    inner = (dx / ix) ** n + (dy / iy) ** n
    # 外沿和内沿各留一点过渡，避免锯齿。
    if outer >= 1.08:
        return 0.0
    if inner <= 0.92:
        return 0.0
    cover = 1.0
    if outer > 1.0:
        cover = min(cover, max(0.0, (1.08 - outer) / 0.08))
    if inner < 1.0:
        cover = min(cover, max(0.0, (inner - 0.92) / 0.08))
    return cover


def sample(x, y, size):
    bg = lerp(BLUE_A, BLUE_B, (x + y) / (2 * (size - 1)))
    tile = rounded_rect_cover(x, y, size, size * 0.22)
    if tile <= 0:
        return (0, 0, 0, 0)
    letter = o_cover(x, y, size)
    rgb = tuple(int(WHITE[i] * letter + bg[i] * (1 - letter) + 0.5) for i in range(3))
    a = int(255 * tile + 0.5)
    return (rgb[0], rgb[1], rgb[2], a)


def render(size, ss=4):
    """ss 倍超采样后再平均，边缘更干净。"""
    raw = bytearray(size * size * 4)
    step = 1.0 / ss
    origin = step / 2
    for y in range(size):
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
            i = (y * size + x) * 4
            raw[i : i + 4] = bytes(v // n for v in acc)
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
    out = bytearray(dst * dst * 4)
    scale = size // dst
    for y in range(dst):
        for x in range(dst):
            acc = [0, 0, 0, 0]
            for sy in range(scale):
                for sx in range(scale):
                    i = ((y * scale + sy) * size + (x * scale + sx)) * 4
                    for c in range(4):
                        acc[c] += rgba[i + c]
            n = scale * scale
            j = (y * dst + x) * 4
            out[j : j + 4] = bytes(v // n for v in acc)
    return bytes(out)


def assert_reads_as_o(rgba, size):
    """中间必须是蓝洞，笔画上是白，不能再是一整块没有字母的纯色。"""
    def px(x, y):
        i = (y * size + x) * 4
        return rgba[i : i + 4]

    mid = px(size // 2, size // 2)
    # 洞：蓝色明显，不能发白。
    if mid[2] < 160 or mid[0] > 80 or mid[1] > 140:
        raise SystemExit(f"图标中心不是 O 的空洞：{tuple(mid)}")
    # 正上方笔画：偏白。
    top = px(size // 2, int(size * 0.20))
    if top[0] < 210 or top[1] < 210 or top[2] < 210:
        raise SystemExit(f"O 的上沿不够白：{tuple(top)}")
    # 旧图标是整片青绿 #0e7490，这里不应再占多数。
    teal = 0
    for i in range(0, len(rgba), 4):
        r, g, b = rgba[i], rgba[i + 1], rgba[i + 2]
        if abs(r - 0x0E) < 12 and abs(g - 0x74) < 12 and abs(b - 0x90) < 12:
            teal += 1
    if teal > (size * size) // 20:
        raise SystemExit("图标仍是旧的青绿纯色块")


def main():
    rgba = render(SIZE, ss=3)
    assert_reads_as_o(rgba, SIZE)
    small = downsample(rgba, SIZE, 32)
    assert_reads_as_o(small, 32)
    png = to_png(rgba, SIZE)
    out = Path(__file__).with_name("icon.png")
    out.write_bytes(png)
    print(f"Wrote {out} ({len(png)} bytes)")


if __name__ == "__main__":
    main()
