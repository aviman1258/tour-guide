"""Build every Deodap image the app uses from the four source pictures in artwork/.

    python scripts/make-artwork.py

Sources (PNG, transparent unless noted):
  artwork/deodap-full.png   Deodap standing / waving, 1024x1024
  artwork/deodap-head.png   head and ears, 512x512
  artwork/deodap-research.png  6 frames of Deodap reading, flipping a page and taking notes, one row
  artwork/deodap-scene.png  Deodap in a car on a coast road, 1200x630 (opaque)

Outputs:
  web/img/deodap.png            full body, trimmed, 512x512, transparent (logo, mascot, overlay)
  web/img/deodap-head.png       head, trimmed, 256x256, transparent (small favicons, doc pages)
  web/img/deodap-busy.png       sprite sheet, 6 frames of 120x120 (the "working" spinner)
  web/img/og.png                1200x630 social preview: the scene plus the wordmark
  web/img/hero.jpg              1200x318 landing-page banner: the sharp band of the scene (the generator letterboxed it)
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


def components(alpha):
    """Connected groups of opaque pixels, as lists of (x, y). Plain flood fill; a 2000 px row takes a second or two."""
    w, h = alpha.size
    px = alpha.load()
    seen = bytearray(w * h)
    out = []
    for y0 in range(h):
        for x0 in range(w):
            if not px[x0, y0] or seen[y0 * w + x0]:
                continue
            stack, pixels = [(x0, y0)], []
            seen[y0 * w + x0] = 1
            while stack:
                x, y = stack.pop()
                pixels.append((x, y))
                for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                    if 0 <= nx < w and 0 <= ny < h and px[nx, ny] and not seen[ny * w + nx]:
                        seen[ny * w + nx] = 1
                        stack.append((nx, ny))
            out.append(pixels)
    return out


def bbox_of(pixels):
    xs = [x for x, _ in pixels]
    ys = [y for _, y in pixels]
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1)


def split_columns(sheet, frames):
    """Fallback for frames that touch: cut at the thinnest column near each expected boundary."""
    alpha = sheet.split()[3].point(lambda v: 255 if v > 8 else 0)
    w, h = alpha.size
    px = alpha.load()
    density = [sum(1 for y in range(h) if px[x, y]) for x in range(w)]
    fw = w / frames
    cuts = []
    for i in range(1, frames):
        centre = round(i * fw)
        lo, hi = max(1, round(centre - 0.3 * fw)), min(w - 1, round(centre + 0.3 * fw))
        cuts.append(min(range(lo, hi), key=lambda x: (density[x], abs(x - centre))))
    edges = [0, *cuts, w]
    cells = []
    for i in range(frames):
        cell = sheet.crop((edges[i], 0, edges[i + 1], h))
        b = cell.split()[3].point(lambda v: 255 if v > 8 else 0).getbbox()
        cells.append((cell, b or (0, 0, cell.width, cell.height)))
    return cells


def split_row(sheet, frames):
    """Separate the frames of a row by connected pixels, grouped by horizontal position: a frame may be
    several pieces (elephant, desk, a pencil) and generators never space frames evenly. The pieces are
    clustered into `frames` groups at the biggest jumps between their centres, so a trunk reaching into
    the next frame's column still belongs to its own elephant. If a piece spans two frames (they touch),
    fall back to cutting columns. Returns [(image, bbox)] left to right, each image the size of the sheet."""
    alpha = sheet.split()[3].point(lambda v: 255 if v > 8 else 0)
    comps = [c for c in components(alpha) if len(c) > 4]
    fw = sheet.width / frames
    if len(comps) < frames or any(bbox_of(c)[2] - bbox_of(c)[0] > 1.5 * fw for c in comps):
        return split_columns(sheet, frames)
    centres = sorted(((sum(x for x, _ in c) / len(c), i) for i, c in enumerate(comps)))
    gaps = sorted(range(1, len(centres)), key=lambda k: centres[k][0] - centres[k - 1][0], reverse=True)[: frames - 1]
    edges = [0, *sorted(gaps), len(centres)]
    groups = [[comps[i] for _, i in centres[edges[g]:edges[g + 1]]] for g in range(frames)]
    cells = []
    for group in groups:
        pixels = [pt for c in group for pt in c]
        mask = Image.new("L", sheet.size, 0)
        mp = mask.load()
        for x, y in pixels:
            mp[x, y] = 255
        img = Image.new("RGBA", sheet.size, (0, 0, 0, 0))
        img.paste(sheet, (0, 0), mask)
        cells.append((img, bbox_of(pixels)))
    return cells


def sprite_sheet(src, frames=8, frame_px=112):
    """Re-pack the run frames on a shared ground line, so the bounce of a run cycle survives while
    every frame sits in the same place on the sheet."""
    sheet = Image.open(src).convert("RGBA")
    cells = split_row(sheet, frames)
    top = min(b[1] for _, b in cells)
    bottom = max(b[3] for _, b in cells)
    widest = max(b[2] - b[0] for _, b in cells)
    side = max(widest, bottom - top)
    out = Image.new("RGBA", (frame_px * frames, frame_px), (0, 0, 0, 0))
    for i, (img, b) in enumerate(cells):
        cell = img.crop(b)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        y = side - (bottom - top) + (b[1] - top)  # each frame keeps its own height above the shared ground line
        canvas.alpha_composite(cell, ((side - cell.width) // 2, y))
        out.alpha_composite(canvas.resize((frame_px, frame_px), RS), (i * frame_px, 0))
    return out


def hero_band(scene_path, height=318):
    """The scene came letterboxed inside blurred bars; keep the sharp middle band as a wide banner."""
    im = Image.open(scene_path).convert("RGB").resize((1200, 630), RS)
    edges = im.convert("L").filter(ImageFilter.FIND_EDGES)
    w, h = edges.size
    px = edges.load()
    energy = [sum(px[x, y] for x in range(0, w, 4)) / (w / 4) for y in range(h)]
    sharp = [y for y in range(8, h - 8) if energy[y] > 3]
    top, bottom = (sharp[0], sharp[-1]) if len(sharp) > height // 2 else (0, h)
    mid = (top + bottom) // 2
    y0 = max(0, min(h - height, mid - height // 2))
    return im.crop((0, y0, 1200, y0 + height))


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
    sprite_sheet(ART / "deodap-research.png", frames=6, frame_px=120).save(IMG / "deodap-busy.png", optimize=True)
    og_image(ART / "deodap-scene.png").save(IMG / "og.png", optimize=True)
    hero_band(ART / "deodap-scene.png").save(IMG / "hero.jpg", quality=84, optimize=True, progressive=True)
    for p in sorted(list(IMG.glob("*.png")) + list(IMG.glob("*.jpg")) + list(ICONS.glob("*.png"))):
        im = Image.open(p)
        print(f"{p.relative_to(ROOT)}  {im.size[0]}x{im.size[1]}  {p.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
