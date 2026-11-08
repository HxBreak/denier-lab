"""Small copies of the pattern masks (web/patterns/*.png -> web/patterns/thumbs/, 128 px) for the
pattern buttons and preset swatches, so the page does not download every 1024 px mask (2.1 MB) at
start-up; the full mask loads only when a pattern is picked. Run after tools/gen_patterns.py.
Needs Pillow."""
import os
from PIL import Image

root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "patterns")
out = os.path.join(root, "thumbs")
os.makedirs(out, exist_ok=True)
total = 0
for name in sorted(os.listdir(root)):
    if not name.endswith(".png"):
        continue
    im = Image.open(os.path.join(root, name)).convert("RGBA").resize((128, 128), Image.LANCZOS)
    # the mask is white with alpha: keep only the alpha in a grey + alpha image, which compresses best
    im = Image.merge("LA", (Image.new("L", im.size, 255), im.getchannel("A")))
    path = os.path.join(out, name)
    im.save(path, optimize=True)
    total += os.path.getsize(path)
    print(f"{name:20s} {os.path.getsize(path):6d} B")
print(f"total {total} B")
