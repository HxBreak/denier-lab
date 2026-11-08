// Puts every pattern on the leg (black 20D, calf shot) and lays the shots out in one sheet:
// shots/patterns-on-leg.png. Also checks the back of the leg, where the angle wraps round.
//   node tools/pattern-shots.mjs [url]
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'child_process';
import fs from 'fs';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
await page.setViewport({ width: 1440, height: 860, deviceScaleFactor: 1 });
await page.goto(process.argv[2] || 'http://127.0.0.1:8090/', { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__dl');
const wait = ms => new Promise(r => setTimeout(r, ms));
const keys = await page.$$eval('#patterns button', bs => bs.map(b => [b.dataset.key, b.title]));
fs.mkdirSync('shots/patterns', { recursive: true });
await page.evaluate(() => __dl.setShot(2));
await wait(1500);
const stage = await (await page.$('#stage')).boundingBox();
const shots = [];
for (const [key, name] of keys) {
  await page.click(`#patterns button[data-key="${key}"]`);
  await wait(900);
  const f = `shots/patterns/${key}.png`;
  await page.screenshot({ path: f, clip: stage });
  shots.push([name, f]);
}
// the back of the calf with the last pattern, to look for a seam where the angle wraps
await page.evaluate(() => {
  const { camera, controls } = __dl, t = controls.target, d = camera.position.distanceTo(t);
  controls.enableDamping = false;
  camera.position.set(t.x, t.y, t.z - d);
  controls.update();
});
await wait(900);
await page.screenshot({ path: 'shots/patterns/back.png', clip: stage });
shots.push(['背面（接缝）', 'shots/patterns/back.png']);
// the panel with the swatches
const grid = await page.$('#patterns');
await grid.evaluate(el => el.scrollIntoView({ block: 'center' }));
await wait(300);
const box = await grid.boundingBox();
await page.screenshot({ path: 'shots/patterns-panel.png', clip: { x: box.x - 8, y: box.y - 36, width: box.width + 16, height: box.height + 44 }, captureBeyondViewport: false });
fs.writeFileSync('shots/patterns/index.json', JSON.stringify(shots));
execFileSync('python3', ['-c', `
import json
from PIL import Image, ImageDraw, ImageFont
shots = json.load(open('shots/patterns/index.json'))
font = ImageFont.truetype('/System/Library/Fonts/Hiragino Sans GB.ttc', 20)
W, cols = 240, 7
im0 = Image.open(shots[0][1]); H = round(im0.height * W / im0.width)
rows = (len(shots) + cols - 1) // cols
sheet = Image.new('RGB', (W * cols, (H + 30) * rows), 'white')
d = ImageDraw.Draw(sheet)
for i, (name, f) in enumerate(shots):
    x, y = (i % cols) * W, (i // cols) * (H + 30)
    sheet.paste(Image.open(f).convert('RGB').resize((W, H), Image.LANCZOS), (x, y + 30))
    d.text((x + W // 2, y + 15), name, fill='black', font=font, anchor='mm')
sheet.save('shots/patterns-on-leg.png')
`], { stdio: 'inherit' });
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
