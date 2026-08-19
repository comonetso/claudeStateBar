#!/usr/bin/env python3
"""Rebuild images/icon.png — the Claude star with a Codex badge in the corner.

The extension is Claude-first, but it also reads Codex CLI sessions, so the
marketplace icon carries both: the star stays the subject, the OpenAI mark sits
in the bottom-right as a badge.

Sources kept next to this script so the icon can be regenerated later:
  icon-star.png       the original star-only artwork (never overwritten)
  codex-blossom.png   OpenAI's "blossom" mark, copied from the ChatGPT VS Code
                      extension (resources/blossom.dark.png). White mark on an
                      opaque black square; the black is dropped below.

The mark is an OpenAI trademark, used here to identify which CLI the extension
reads. Neither logo is ours.

Run from anywhere:  python images/icon-src/make-icon.py
Requires Pillow.
"""

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
STAR_SRC = HERE / "icon-star.png"
BADGE_SRC = HERE / "codex-blossom.png"
OUT = HERE.parent / "icon.png"

SIZE = 128          # marketplace icon is 128x128
SS = 8              # supersample factor; the disc is drawn 8x and downsampled
BG = (10, 10, 10, 255)          # sampled from the original artwork

STAR_SCALE = 0.82   # shrink the star to open up the bottom-right corner
STAR_SHIFT = 10     # ...and nudge it up-left, away from the badge
BADGE_WIDTH = 0.523 # width of the mark itself, as a fraction of the canvas.
                    # Measured on the trimmed artwork, so this is the visible
                    # size — the source PNG's own 8% margin is cropped away in
                    # mark() rather than padding the badge out.
BADGE_MARGIN = 6    # px from the bottom/right edge; keeps the mark off the
                    # corner, centred where the smaller badge used to sit
DISC = 1.04         # background disc behind the mark, relative to mark width.
                    # Without it the petals show through the gaps in the knot;
                    # 1.04 is just enough to back the knot without reading as
                    # padding around it.


def mark(px: int) -> Image.Image:
    """The blossom as white-on-transparent, trimmed to the ink.

    The source is a white mark on opaque black, so luminance doubles as the
    alpha channel — which keeps the original anti-aliasing intact. It also
    carries ~8% margin per side; that gets cropped here so `px` means the mark
    itself, not the mark plus a band of black.
    """
    src = Image.open(BADGE_SRC).convert("RGBA")
    trimmed = Image.new("RGBA", src.size, (255, 255, 255, 0))
    trimmed.putalpha(src.convert("L"))
    return trimmed.crop(trimmed.getbbox()).resize((px, px), Image.LANCZOS)


def build() -> Image.Image:
    canvas = Image.new("RGBA", (SIZE, SIZE), BG)

    star_px = int(SIZE * STAR_SCALE)
    star = Image.open(STAR_SRC).convert("RGBA").resize((star_px, star_px), Image.LANCZOS)
    offset = (SIZE - star_px) // 2 - STAR_SHIFT
    canvas.paste(star, (offset, offset))

    badge_px = round(SIZE * BADGE_WIDTH)
    x = y = SIZE - badge_px - BADGE_MARGIN

    disc = Image.new("RGBA", (SIZE * SS, SIZE * SS), (0, 0, 0, 0))
    d = badge_px * DISC * SS
    cx = (x + badge_px / 2) * SS
    cy = (y + badge_px / 2) * SS
    ImageDraw.Draw(disc).ellipse([cx - d / 2, cy - d / 2, cx + d / 2, cy + d / 2], fill=BG)
    canvas.alpha_composite(disc.resize((SIZE, SIZE), Image.LANCZOS))

    canvas.alpha_composite(mark(badge_px), (x, y))
    return canvas


if __name__ == "__main__":
    build().save(OUT)
    print(f"wrote {OUT}")
