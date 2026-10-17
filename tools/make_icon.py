"""Build the AI 圆桌 app icon from tools/icon-source.webp (the cyan robot-in-orbit mark on black).

The mark is cropped out, centred on a rounded tile, and its black background is lifted to a deep navy gradient
(screen blend, so the cyan artwork itself is untouched). Writes roundtable-robot.ico / roundtable-v2.png (app root),
web/logo.png, web/favicon.png, web/assets/roundtable.png and tools/icon-preview.png.
Run:  python tools/make_icon.py   (from the AI-Roundtable folder)
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'vendor'))
from PIL import Image, ImageChops, ImageDraw  # noqa: E402

S = 1024
FILL = .80                                   # how much of the tile the mark takes
TOP, BOTTOM = (16, 34, 72), (3, 7, 18)      # tile gradient behind the mark (top-left -> bottom-right)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def mark():
    """Square crop around the bright artwork, on its own black."""
    src = Image.open(ROOT / 'tools' / 'icon-source.webp').convert('RGB')
    box = src.convert('L').point(lambda v: 255 if v > 60 else 0).getbbox()
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    side = max(box[2] - box[0], box[3] - box[1]) / FILL
    out = Image.new('RGB', (int(side), int(side)), (0, 0, 0))
    out.paste(src, (int(side / 2 - cx), int(side / 2 - cy)))
    return out.resize((S, S), Image.Resampling.LANCZOS)


def tile():
    strip = Image.new('RGB', (2 * S, 1))
    for i in range(2 * S):
        strip.putpixel((i, 0), lerp(TOP, BOTTOM, i / (2 * S - 1)))
    grad = strip.resize((2 * S, 2 * S)).rotate(-45, resample=Image.Resampling.BICUBIC).crop((S // 2, S // 2, S // 2 + S, S // 2 + S))
    img = ImageChops.screen(mark(), grad).convert('RGBA')
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * .225), fill=255)
    # a faint cyan rim so the dark tile still has an edge on a dark taskbar
    rim = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(rim).rounded_rectangle((2, 2, S - 3, S - 3), radius=int(S * .225) - 2, outline=(70, 200, 255, 70), width=6)
    img.alpha_composite(rim)
    img.putalpha(mask)
    return img


def main():
    big = tile()

    def at(n):
        return big.resize((n, n), Image.Resampling.LANCZOS)
    at(512).save(ROOT / 'roundtable-v2.png')
    at(256).save(ROOT / 'web' / 'favicon.png')
    at(256).save(ROOT / 'web' / 'logo.png')
    at(128).save(ROOT / 'web' / 'assets' / 'roundtable.png')
    sizes = (16, 20, 24, 32, 40, 48, 64, 128, 256)
    frames = {n: at(n) for n in sizes}
    frames[256].save(ROOT / 'roundtable-robot.ico', format='ICO', sizes=[(n, n) for n in sizes],
                     append_images=[frames[n] for n in sizes if n != 256])
    sheet = Image.new('RGBA', (900, 600), '#eef2f8')
    sheet.alpha_composite(Image.new('RGBA', (900, 300), '#10131a'), (0, 300))
    for y in (22, 322):
        x = 22
        for n in (256, 128, 64, 32, 16):
            sheet.alpha_composite(frames[n], (x, y))
            x += n + 30
    sheet.save(ROOT / 'tools' / 'icon-preview.png')
    print('icon written')


if __name__ == '__main__':
    main()
