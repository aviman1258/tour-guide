"""Build every Deodap image the app uses from the four source pictures in artwork/.

    python scripts/make-artwork.py

Sources (PNG, transparent unless noted):
  artwork/deodap-full.png   Deodap standing / waving, 1024x1024
  artwork/deodap-head.png   head and ears, 512x512
  artwork/deodap-run.png    8-frame run cycle in one row, 4096x512
  artwork/deodap-scene.png  Deodap in a car on a coast road, 1200x630 (opaque)

Outputs:
  web/img/deodap.png            full body, trimmed, 512x512, transparent (logo, mascot, overlay)
  web/img/deodap-head.png       head, trimmed, 256x256, transparent (small favicons, doc pages)
  web/img/deodap-run.png        sprite sheet, 8 frames of 112x112 (the "working" spinner)
  web/img/og.png                1200x630 social preview: the scene plus the wordmark
  web/icons/favicon-32.png, favicon-64.png
  web/icons/icon-192.png, icon-512.png, apple-touch-icon-180.png   (opaque cream background)
  web/icons/icon-512-maskable.png   (same, character inside the 80% safe zone)
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
ART, IMG, ICONS = ROOT / "artwork", ROOT / "web" / "img", ROOT / "web" / "icons"
CREAM = (255, 246, 229, 255)
RS = Image.LANCZOS


def trimmed(im):
    """Crop to the opaque pixels (alpha > 8), so margins the generator left don't shrink the character."""
    im = im.convert("RGBA")
    a = im.split()[3].point(lambda v: 255 if v > 8 else 0)
    box = a.getbbox()
    return im.crop(box) if box else im


def square(im, size, fill=0.86, bg=None):
    """Fit the character into a size x size canvas using `fill` of the side, centred; bg None = transparent."""
    im = trimmed(im)
    scale = (size * fill) / max(im.size)
    im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), RS)
    canvas = Image.new("RGBA", (size, size), bg or (0, 0, 0, 0))
    canvas.alpha_composite(im, ((size - im.width) // 2, (size - im.height) // 2))
    return canvas


def sprite_sheet(src, frames=8, frame_px=112):
    """Slice the run row into frames, crop them all to the same box (so the ground line stays put), and re-pack."""
    sheet = Image.open(src).convert("RGBA")
    fw = sheet.width // frames
    cells = [sheet.crop((i * fw, 0, (i + 1) * fw, sheet.height)) for i in range(frames)]
    boxes = [c.split()[3].point(lambda v: 255 if v > 8 else 0).getbbox() for c in cells]
    boxes = [b for b in boxes if b]
    l, t = min(b[0] for b in boxes), min(b[1] for b in boxes)
    r, btm = max(b[2] for b in boxes), max(b[3] for b in boxes)
    side = max(r - l, btm - t)
    out = Image.new("RGBA", (frame_px * frames, frame_px), (0, 0, 0, 0))
    for i, c in enumerate(cells):
        cell = c.crop((l, t, r, btm))
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.alpha_composite(cell, ((side - cell.width) // 2, side - cell.height))  # feet on the bottom edge
        out.alpha_composite(canvas.resize((frame_px, frame_px), RS), (i * frame_px, 0))
    return out


def og_image(scene_path):
    """The scene with the wordmark laid over its lower band."""
    im = Image.open(scene_path).convert("RGBA").resize((1200, 630), RS)
    shade = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(shade)
    for y in range(430, 630):  # darken the bottom so white text reads on any sky
        a = int(170 * (y - 430) / 200)
        d.line([(0, y), (1200, y)], fill=(20, 24, 32, a))
    im.alpha_composite(shade)
    d = ImageDraw.Draw(im)
    try:
        big = ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", 66)
        small = ImageFont.truetype("C:/Windows/Fonts/seguisb.ttf", 30)
    except OSError:
        big = small = ImageFont.load_default()
    for dx, dy in ((2, 2), (0, 2), (2, 0)):
        d.text((60 + dx, 490 + dy), "Deodapper", font=big, fill=(0, 0, 0, 120))
    d.text((60, 490), "Deodapper", font=big, fill=(255, 255, 255, 255))
    d.text((62, 570), "Self-guided driving tours, narrated as you go", font=small, fill=(255, 240, 220, 255))
    return im.convert("RGB")


def main():
    IMG.mkdir(exist_ok=True)
    ICONS.mkdir(exist_ok=True)
    full = Image.open(ART / "deodap-full.png")
    head = Image.open(ART / "deodap-head.png")

    square(full, 512, fill=0.96).save(IMG / "deodap.png", optimize=True)
    square(head, 256, fill=0.96).save(IMG / "deodap-head.png", optimize=True)
    for s in (32, 64):
        square(head, s, fill=1.0).save(ICONS / f"favicon-{s}.png", optimize=True)
    for name, size, fill in (("icon-192.png", 192, 0.82), ("icon-512.png", 512, 0.82), ("apple-touch-icon-180.png", 180, 0.84)):
        square(full, size, fill=fill, bg=CREAM).convert("RGB").save(ICONS / name, optimize=True)
    # maskable: platforms may crop to a circle covering the central 80%; keep him inside it
    square(full, 512, fill=0.62, bg=CREAM).convert("RGB").save(ICONS / "icon-512-maskable.png", optimize=True)
    sprite_sheet(ART / "deodap-run.png").save(IMG / "deodap-run.png", optimize=True)
    og_image(ART / "deodap-scene.png").save(IMG / "og.png", optimize=True)
    for p in sorted(list(IMG.glob("*.png")) + list(ICONS.glob("*.png"))):
        im = Image.open(p)
        print(f"{p.relative_to(ROOT)}  {im.size[0]}x{im.size[1]}  {p.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
