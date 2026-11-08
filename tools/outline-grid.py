# Lays out the shots from outline-compare.mjs: one row per scene, one column per outline mode.
import json
from PIL import Image, ImageDraw, ImageFont

idx = json.load(open('shots/outline/index.json'))
font = ImageFont.truetype('/System/Library/Fonts/Hiragino Sans GB.ttc', 22)
W = 300
first = Image.open(idx['scenes'][0][1][0])
H = round(first.height * W / first.width)
LW, TH = 120, 40
grid = Image.new('RGB', (LW + W * len(idx['modes']), TH + H * len(idx['scenes'])), 'white')
d = ImageDraw.Draw(grid)
for c, m in enumerate(idx['modes']):
    d.text((LW + c * W + W // 2, TH // 2), m, fill='black', font=font, anchor='mm')
for r, (name, row) in enumerate(idx['scenes']):
    d.text((LW // 2, TH + r * H + H // 2), name, fill='black', font=font, anchor='mm')
    for c, f in enumerate(row):
        grid.paste(Image.open(f).convert('RGB').resize((W, H), Image.LANCZOS), (LW + c * W, TH + r * H))
grid.save('shots/outline-compare.png')

# the knee of the pulled-down scene and the foot, full size, all four modes side by side
for name, (r, box) in {'zoom-knee': (1, (0.25, 0.25, 0.75, 0.55)), 'zoom-foot': (4, (0.1, 0.35, 0.9, 0.75))}.items():
    row = idx['scenes'][r][1]
    ims = []
    for f in row:
        im = Image.open(f).convert('RGB')
        w, h = im.size
        ims.append(im.crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h))))
    cw, ch = ims[0].size
    out = Image.new('RGB', (cw * len(ims) + 10 * (len(ims) - 1), ch + TH), 'white')
    dd = ImageDraw.Draw(out)
    for c, im in enumerate(ims):
        out.paste(im, (c * (cw + 10), TH))
        dd.text((c * (cw + 10) + cw // 2, TH // 2), idx['modes'][c], fill='black', font=font, anchor='mm')
    out.save(f'shots/outline-{name}.png')
