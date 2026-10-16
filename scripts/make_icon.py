"""生成 Sydney 应用图标：与侧栏品牌标同一套渐变蓝圆角方块 + 白色 S。

输出 icon.png（512）和多尺寸 icon.ico。小尺寸（≤32）把方块铺满画布，保证任务栏里看得清。
用法：python -I scripts/make_icon.py desktop/assets
"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


def oklch_to_rgb(l, c, h):
    a = c * math.cos(math.radians(h))
    b = c * math.sin(math.radians(h))
    l_ = l + 0.3963377774 * a + 0.2158037573 * b
    m_ = l - 0.1055613458 * a - 0.0638541728 * b
    s_ = l - 0.0894841775 * a - 1.2914855480 * b
    l3, m3, s3 = l_ ** 3, m_ ** 3, s_ ** 3
    r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
    g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
    bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3

    def enc(x):
        x = max(0.0, min(1.0, x))
        return round(255 * (12.92 * x if x <= 0.0031308 else 1.055 * x ** (1 / 2.4) - 0.055))

    return enc(r), enc(g), enc(bl)


TOP = oklch_to_rgb(0.58, 0.17, 262)
BOTTOM = oklch_to_rgb(0.44, 0.17, 270)
FONT = "C:/Windows/Fonts/segoeuib.ttf"


def render(size: int, fill: float) -> Image.Image:
    """fill：方块占画布的比例。先在 4 倍画布上画，再缩小抗锯齿。"""
    big = size * 4 if size >= 64 else 512
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    side = round(big * fill)
    offset = (big - side) // 2
    radius = round(side * 0.24)

    # 对角线渐变
    gradient = Image.new("RGBA", (side, side))
    pixels = gradient.load()
    for y in range(side):
        for x in range(side):
            t = (x + y) / (2 * (side - 1))
            pixels[x, y] = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)) + (255,)
    mask = Image.new("L", (side, side), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, side - 1, side - 1), radius=radius, fill=255)

    # 大尺寸加一层很淡的投影，让图标在浅色任务栏上有边界
    if fill < 1:
        shadow = Image.new("RGBA", (big, big), (0, 0, 0, 0))
        shadow_mask = Image.new("L", (big, big), 0)
        ImageDraw.Draw(shadow_mask).rounded_rectangle(
            (offset, offset + big * 0.012, offset + side - 1, offset + side - 1 + big * 0.012), radius=radius, fill=70)
        shadow.putalpha(shadow_mask.filter(ImageFilter.GaussianBlur(big * 0.018)))
        canvas.alpha_composite(shadow)

    tile = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    tile.paste(gradient, (0, 0), mask)

    # 白色 S，按字形实际包围盒居中
    draw = ImageDraw.Draw(tile)
    font = ImageFont.truetype(FONT, round(side * 0.62))
    left, top, right, bottom = draw.textbbox((0, 0), "S", font=font)
    x = (side - (right - left)) / 2 - left
    y = (side - (bottom - top)) / 2 - top
    draw.text((x, y), "S", font=font, fill=(255, 255, 255, 255))

    canvas.alpha_composite(tile, (offset, offset))
    return canvas.resize((size, size), Image.LANCZOS)


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    render(512, 0.86).save(out / "icon.png")
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = [render(s, 1.0 if s <= 32 else 0.9) for s in sizes]
    frames[-1].save(out / "icon.ico", format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    print("ok", TOP, BOTTOM)


if __name__ == "__main__":
    main()
