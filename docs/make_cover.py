# -*- coding: utf-8 -*-
"""Build the PDF cover from the real capsule icon and a real panel screenshot."""
import os
from PIL import Image, ImageDraw, ImageFilter
import numpy as np

W, H = 1792, 1024
here = os.path.dirname(__file__)

# --- background: navy gradient + glows
base = Image.new("RGBA", (W, H), (12, 16, 30, 255))
d = ImageDraw.Draw(base)
top, bottom = (13, 17, 33), (27, 33, 62)
for y in range(H):
    t = y / (H - 1)
    d.line([(0, y), (W, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,))

glow = Image.new("RGB", (W, H), (0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse((1030, -200, 1560, 330), fill=(38, 66, 140))
gd.ellipse((-300, 560, 300, 1160), fill=(28, 56, 120))
glow = glow.filter(ImageFilter.GaussianBlur(150))
base = Image.composite(Image.blend(base.convert("RGB"), glow, 0.45), base.convert("RGB"), Image.new("L", (W, H), 90)).convert("RGBA")
base = Image.alpha_composite(Image.new("RGBA", (W, H), (13, 17, 33, 255)), base)

# --- real capsule icon: black background -> luminance alpha (glow cutout)
cap = Image.open(os.path.join(here, "..", "screenshots", "capsule.png")).convert("RGB")
arr = np.asarray(cap).astype(np.float32) / 255.0
lum = arr.max(axis=2)
alpha = np.clip((lum - 0.02) / 0.55, 0, 1) ** 0.85
rgba = np.dstack([arr, alpha])
cap = Image.fromarray((rgba * 255).astype(np.uint8), "RGBA")

cw = 380
cap = cap.resize((cw, cw), Image.LANCZOS)
capx, capy = 150, (H - cw) // 2

# badge that matches the runtime capsule (dark rounded square + white glyph)
badge = Image.new("RGBA", (cw, cw), (0, 0, 0, 0))
bd = ImageDraw.Draw(badge)
bd.rounded_rectangle((0, 0, cw, cw), radius=int(cw * 0.30), fill=(25, 29, 54, 255),
                     outline=(255, 255, 255, 26), width=3)
glyph = cap.resize((int(cw * 0.74), int(cw * 0.74)), Image.LANCZOS)
badge.alpha_composite(glyph, ((cw - glyph.width) // 2, (cw - glyph.height) // 2))
cap = badge

halo = Image.new("RGBA", (cw + 220, cw + 220), (0, 0, 0, 0))
ImageDraw.Draw(halo).ellipse((110, 110, 110 + cw, 110 + cw), fill=(72, 120, 255, 70))
halo = halo.filter(ImageFilter.GaussianBlur(60))
base.alpha_composite(halo, (capx - 110, capy - 110))
base.alpha_composite(cap, (capx, capy))

# --- real panel screenshot with rounded mask + shadow
panel = Image.open(os.path.join(here, "..", "screenshots", "panel.png")).convert("RGBA")
pw = 640
ph = int(pw * panel.height / panel.width)
panel = panel.resize((pw, ph), Image.LANCZOS)
mask = Image.new("L", (pw, ph), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, pw, ph), radius=28, fill=255)

px, py = 1010, (H - ph) // 2 - 10
shadow = Image.new("RGBA", (pw + 160, ph + 160), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle((80, 80, 80 + pw, 80 + ph), radius=28, fill=(0, 0, 0, 180))
shadow = shadow.filter(ImageFilter.GaussianBlur(30))
base.alpha_composite(shadow, (px - 80 + 10, py - 80 + 24))

layer = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
layer.paste(panel, (0, 0), mask)
base.alpha_composite(layer, (px, py))

d = ImageDraw.Draw(base)
d.rounded_rectangle((px, py, px + pw, py + ph), radius=28, outline=(130, 160, 230, 110), width=2)

# --- connector: dashed line from icon to panel
y0 = capy + cw // 2
x0, x1 = capx + cw + 24, px - 34
x = x0
while x < x1:
    d.line([(x, y0), (min(x + 14, x1), y0)], fill=(120, 150, 220, 130), width=3)
    x += 28

base.convert("RGB").save(os.path.join(here, "img", "install-cover-real.jpg"), quality=93)
print("saved install-cover-real.jpg", base.size)
