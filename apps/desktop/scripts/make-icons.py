"""Builds Lumo's app icon and live (animated) icon frames from the blue knot artwork.

    python3 apps/desktop/scripts/make-icons.py      # needs Pillow and numpy
    pnpm --dir apps/desktop tauri icon src-tauri/icons/source-1024.png

Input: docs/brand/knot-source.png (transparent background).
Output:
  - apps/desktop/src-tauri/icons/source-1024.png: the knot on a soft white-to-blue tile (feed it to
    `tauri icon` for every installer, Dock and taskbar size);
  - apps/desktop/src-tauri/icons/live/*.png: 64 px frames the running app swaps in (live_icon.rs):
    idle (still), blink (a light sweeps across the fur), work (the knot turns slowly while a
    shimmer runs through it), wave (a happy bounce when a reply is ready).
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "docs/brand/knot-source.png"
ICONS = ROOT / "apps/desktop/src-tauri/icons"


def clean(img: Image.Image) -> Image.Image:
    """Remove the cyan fringe and stray specks left by the background cut-out."""
    a = np.asarray(img.convert("RGBA")).astype(np.float32)
    alpha = a[..., 3]
    solid = alpha >= 220
    # The body's own color, spread outward: a blur of solid pixels divided by the blur of the mask.
    rgb = Image.fromarray(np.where(solid[..., None], a[..., :3], 0).astype(np.uint8))
    mask = Image.fromarray((solid * 255).astype(np.uint8))
    blur_rgb = np.asarray(rgb.filter(ImageFilter.GaussianBlur(6))).astype(np.float32)
    blur_m = np.asarray(mask.filter(ImageFilter.GaussianBlur(6))).astype(np.float32)[..., None] / 255
    body = blur_rgb / np.maximum(blur_m, 1e-3)
    edge = ~solid
    a[edge, :3] = body[edge]
    # Faint specks and haze around the outline go; the soft fur edge stays.
    alpha = np.where(alpha < 40, 0, alpha)
    alpha = np.where(solid, 255, alpha)
    a[..., 3] = alpha
    out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGBA")
    bbox = out.getchannel("A").point(lambda v: 255 if v > 24 else 0).getbbox()
    out = out.crop(bbox)
    # A square canvas as wide as the circle around the knot, so it can turn without clipping.
    al = np.asarray(out.getchannel("A")) > 24
    ys, xs = np.nonzero(al)
    cx, cy = out.width / 2, out.height / 2
    side = int(np.ceil(2 * np.sqrt(((xs - cx) ** 2 + (ys - cy) ** 2).max()))) + 2
    sq = Image.new("RGBA", (side, side))
    sq.paste(out, ((side - out.width) // 2, (side - out.height) // 2))
    return sq


def tile(size: int) -> Image.Image:
    """A squircle tile: white at the top fading to light blue, like the app."""
    s = size
    y = np.linspace(0, 1, s)[:, None]
    x = np.linspace(-1, 1, s)[None, :]
    d = np.sqrt(x**2 + (y * 2 - 0.6) ** 2)
    top = np.array([255, 255, 255])
    bottom = np.array([196, 216, 255])
    t = np.clip(d * 0.75, 0, 1)[..., None]
    rgb = (top * (1 - t) + bottom * t).astype(np.uint8)
    img = Image.fromarray(np.dstack([rgb, np.full((s, s), 255, np.uint8)]), "RGBA")
    m = Image.new("L", (s * 4, s * 4))
    ImageDraw.Draw(m).rounded_rectangle((0, 0, s * 4 - 1, s * 4 - 1), radius=int(s * 4 * 0.225), fill=255)
    img.putalpha(m.resize((s, s), Image.LANCZOS))
    return img


def shimmer(knot: Image.Image, pos: float, strength: float = 0.55) -> Image.Image:
    """A soft diagonal band of light at pos (0..1 across the knot), only on the fur."""
    s = knot.width
    yy, xx = np.mgrid[0:s, 0:s] / s
    band = np.exp(-(((xx + yy) / 2 - pos) ** 2) / 0.006) * strength
    a = np.asarray(knot).astype(np.float32)
    a[..., :3] = a[..., :3] + (255 - a[..., :3]) * band[..., None]
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGBA")


def compose(knot: Image.Image, size: int, scale: float = 0.8, angle: float = 0, dy: float = 0) -> Image.Image:
    out = tile(size)
    k = knot.rotate(angle, resample=Image.BICUBIC, expand=False)
    side = int(size * scale)
    k = k.resize((side, side), Image.LANCZOS)
    # A soft shadow under the knot so it sits on the tile.
    shadow = Image.new("RGBA", k.size, (30, 60, 160, 0))
    shadow.putalpha(k.getchannel("A").point(lambda v: v * 0.35).filter(ImageFilter.GaussianBlur(size * 0.02)))
    off = ((size - side) // 2, (size - side) // 2 + int(dy * size))
    out.alpha_composite(shadow, (off[0], off[1] + int(size * 0.025)))
    out.alpha_composite(k, off)
    return out


def main() -> None:
    knot = clean(Image.open(SRC))
    compose(knot, 1024, 0.98).save(ICONS / "source-1024.png")
    live = ICONS / "live"
    live.mkdir(exist_ok=True)
    for f in live.glob("*.png"):
        f.unlink()
    big = 256  # work at 4x, then downsample to 64 for crisp small frames
    small = knot.resize((big, big), Image.LANCZOS)

    def save(name: str, img: Image.Image) -> None:
        img.resize((64, 64), Image.LANCZOS).save(live / f"{name}.png")

    save("idle-0", compose(small, big, 1.0))
    for i in range(6):  # blink: a light sweeps across the fur
        save(f"blink-{i}", compose(shimmer(small, -0.1 + i * 0.24), big, 1.0))
    for i in range(24):  # work: a slow full turn with a shimmer running through
        save(f"work-{i}", compose(shimmer(small, (i % 8) / 7 * 1.2 - 0.1, 0.4), big, 1.0, angle=-i * 15))
    for i in range(10):  # wave: a happy bounce with a little wiggle
        t = i / 9
        bounce = np.sin(t * np.pi)
        wiggle = np.sin(t * np.pi * 3) * 8 * (1 - t)
        save(f"wave-{i}", compose(small, big, 1.0 + 0.08 * bounce, angle=wiggle, dy=-0.06 * bounce))
    print("icons written to", ICONS)


if __name__ == "__main__":
    main()
