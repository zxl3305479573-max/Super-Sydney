"""从 ZXL 抽象线稿生成侧栏品牌图与多尺寸 Windows 应用图标。

用法：python -I scripts/make_icon.py desktop/assets
"""
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageEnhance, ImageOps


def load_mark(source: Path) -> Image.Image:
    image = Image.open(source).convert("RGB")
    white = Image.new("RGB", image.size, "white")
    difference = ImageChops.difference(image, white).convert("L")
    bounds = difference.point(lambda value: 255 if value > 20 else 0).getbbox()
    if not bounds:
        raise ValueError(f"No dark logo artwork found in {source}")
    mark = image.crop(bounds).convert("L")
    mark = ImageOps.autocontrast(mark)
    alpha = ImageOps.invert(mark)
    result = Image.new("RGBA", mark.size, (17, 17, 17, 0))
    result.putalpha(alpha)
    return result


def render(mark: Image.Image, size: int, fill: float) -> Image.Image:
    padding = max(2, round(size * (1 - fill) / 2))
    available = size - padding * 2
    fitted = ImageOps.contain(mark, (available, available), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    x = (size - fitted.width) // 2
    y = (size - fitted.height) // 2
    canvas.alpha_composite(fitted, (x, y))
    if size <= 32:
        alpha = canvas.getchannel("A")
        alpha = ImageEnhance.Contrast(alpha).enhance(1.35)
        canvas.putalpha(alpha)
    return canvas


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    mark = load_mark(out / "zxl-logo-concept-v3.png")
    render(mark, 512, 0.82).save(out / "brand-mark.png")
    render(mark, 512, 0.86).save(out / "icon.png")
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = [render(mark, s, 1.0 if s <= 32 else 0.9) for s in sizes]
    frames[-1].save(out / "icon.ico", format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    print("ok: brand-mark.png, icon.png, icon.ico")


if __name__ == "__main__":
    main()
