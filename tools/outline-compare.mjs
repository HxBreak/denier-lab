// Renders a few scenes with each way of drawing the silhouette (outline meshes, stocking outline only,
// none, soft edge in the shaders) side by side: shots/outline-compare.png, plus close-ups of the
// knee and the foot (shots/outline-zoom-*.png).
//   node tools/outline-compare.mjs [url]
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'child_process';
import fs from 'fs';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.setViewport({ width: 1440, height: 860, deviceScaleFactor: 1 });
await page.goto(process.argv[2] || 'http://127.0.0.1:8090/', { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__dl');
const wait = ms => new Promise(r => setTimeout(r, ms));
await wait(800);
const preset = i => `document.querySelectorAll('#presets button')[${i}].click()`;
const SCENES = [
  ['黑丝 20D', `${preset(0)}; __dl.setShot(0)`],
  ['拉到小腿', `(() => { const d = __dl; for (let l = d.state.top; l < 0.6; l += 0.01) d.rig.pull(0, -0.9, l, d.state.top); d.state.dirty = true; })()`],
  ['肉色 12D', `__dl.putOn(0); ${preset(1)}`],
  ['白色 80D', `${preset(2)}`],
  ['脚 · 黑丝', `${preset(0)}; __dl.setShot(3)`],
  ['光腿', `__dl.setShot(0); __dl.setOff(0, true)`],
];
// [name, skin outline, stocking outline, soft edge in the shaders]
const MODES = [['描边线（现在）', true, true, 0], ['只描丝袜', false, true, 0], ['不描', false, false, 0], ['柔和边缘', false, false, 1]];
fs.mkdirSync('shots/outline', { recursive: true });
const stage = await (await page.$('#stage')).boundingBox();
const files = [];
for (const [si, [name, js]] of SCENES.entries()) {
  await page.evaluate(js);
  await wait(si === 2 ? 3500 : 1500);
  const row = [];
  for (const [mi, [, skin, stock, edge]] of MODES.entries()) {
    await page.evaluate((a, b, e) => {
      const d = __dl;
      d.skinLine.visible = a; d.stockingLine.visible = b;
      d.skin.uniforms.uEdge.value = d.stock.uniforms.uEdge.value = e;
      d.state.dirty = true;
    }, skin, stock, edge);
    await wait(250);
    const f = `shots/outline/${si}-${mi}.png`;
    await page.screenshot({ path: f, clip: stage });
    row.push(f);
  }
  files.push([name, row]);
}
await page.evaluate(() => { const d = __dl; d.skinLine.visible = d.stockingLine.visible = true; d.skin.uniforms.uEdge.value = d.stock.uniforms.uEdge.value = 0; });
fs.writeFileSync('shots/outline/index.json', JSON.stringify({ scenes: files, modes: MODES.map(m => m[0]) }));
execFileSync('python3', ['tools/outline-grid.py'], { stdio: 'inherit' });
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
