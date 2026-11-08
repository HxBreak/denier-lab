// Custom images (web/js/custom.js), through the real file inputs: makes four test images in the browser
// (black stars on white, rainbow stripes, a transparent lace strip, a background), picks them for the
// pattern, welt, straps and background, switches 保留原色 / 只取形状 and 反相, reloads (they are kept in
// this browser), and clears them. Screenshots in shots/custom-*.png. Exits with 1 if a check fails.
//   node tools/custom-check.mjs [url]
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const url = process.argv[2] || 'http://127.0.0.1:8090/';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
page.setDefaultTimeout(300000);
await page.setViewport({ width: 1440, height: 1000 });
const errors = [], failures = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('dialog', d => { errors.push('dialog: ' + d.message()); d.dismiss(); });
const check = (ok, what) => { if (!ok) failures.push(what); };
const wait = ms => new Promise(r => setTimeout(r, ms));
const load = async () => {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction('document.body.classList.contains("ready")');
  await wait(800);
};
await load();
fs.mkdirSync('shots/custom-in', { recursive: true });
const images = await page.evaluate(() => {
  const make = (w, h, draw, alpha = false) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (!alpha) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }
    draw(g); return c.toDataURL('image/png');
  };
  const star = (g, x, y, r) => { g.beginPath(); for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 - Math.PI / 2, q = i % 2 ? r * 0.45 : r; g.lineTo(x + q * Math.cos(a), y + q * Math.sin(a)); } g.fill(); };
  return {
    stars: make(256, 256, g => { g.fillStyle = '#000'; for (const [x, y] of [[64, 64], [192, 192], [192, 64], [64, 192]]) star(g, x, y, 30); }),
    rainbow: make(256, 256, g => { const c = ['#e63c5a', '#faaa28', '#fae63c', '#46be78', '#3c8ce6', '#965ad2']; for (let i = -6; i < 12; i++) { g.fillStyle = c[(i + 12) % 6]; g.beginPath(); g.moveTo(i * 22, 0); g.lineTo(i * 22 + 22, 0); g.lineTo(i * 22 + 22 + 256, 256); g.lineTo(i * 22 + 256, 256); g.fill(); } }),
    lace: make(600, 100, g => { g.strokeStyle = '#fff'; g.lineWidth = 8; for (let i = 0; i < 6; i++) { g.beginPath(); g.arc(i * 100 + 50, 10, 40, 0, Math.PI); g.stroke(); } g.fillStyle = '#fff'; g.fillRect(0, 0, 600, 10); }, true),
    bg: make(400, 600, g => { const gr = g.createLinearGradient(0, 0, 0, 600); gr.addColorStop(0, '#78aae6'); gr.addColorStop(1, '#fae6be'); g.fillStyle = gr; g.fillRect(0, 0, 400, 600); }),
  };
});
for (const [k, v] of Object.entries(images)) fs.writeFileSync(`shots/custom-in/${k}.png`, Buffer.from(v.split(',')[1], 'base64'));
const pick = async (slot, f) => { await (await page.$(`.custom-row[data-slot="${slot}"] input[type=file]`)).uploadFile(`shots/custom-in/${f}.png`); await wait(1500); };
const click = async sel => { await page.click(sel); await wait(1200); };
const u = () => page.evaluate(() => { const x = __dl.stock.uniforms; return { pat: x.uPattern.value, patRGB: x.uPatRGB.value, band: x.uBand.value, bandRGB: x.uBandRGB.value, strap: x.uStrap.value, strapTex: x.uStrapTexMode.value, spec: document.getElementById('spec-name').textContent }; });
const shot = async n => (await page.$('#stage')).screenshot({ path: `shots/custom-${n}.png` });

await pick('pattern', 'stars'); let s = await u(); await shot('1-pattern');
check(s.pat === 3 && s.patRGB === 0 && /自定义/.test(s.spec), 'pattern image (shape) not applied');
await click('.custom-row[data-slot="pattern"] .invert'); await shot('2-inverted');
check(await page.$eval('.custom-row[data-slot="pattern"] .invert', e => e.classList.contains('on')), '反相 did not turn on');
await click('.custom-row[data-slot="pattern"] [data-cmode="color"]');
check(await page.$eval('.custom-row[data-slot="pattern"] .invert', e => e.hidden), '反相 still shown for 保留原色');
await pick('pattern', 'rainbow'); s = await u(); await shot('3-colour');
check(s.patRGB === 1, 'pattern image (colour) not applied');
await pick('band', 'lace'); s = await u(); await shot('4-welt');
check(s.band === 3, 'welt image not applied');
await pick('strap', 'rainbow'); s = await u(); await shot('5-straps');
check(s.strap > 0 && s.strapTex === 1, 'strap image not applied, or straps not turned on');
await pick('bg', 'bg'); await shot('6-background');
check(await page.$eval('#stage', e => e.style.backgroundImage.startsWith('url(')), 'background not applied');
await load(); await shot('7-reloaded');
const kept = await page.evaluate(() => ({ btn: !!document.querySelector('#patterns [data-key=custom]'), band: !document.querySelector('[data-band="3"]').hidden, bg: !!document.getElementById('stage').style.backgroundImage }));
check(kept.btn && kept.band && kept.bg, `images not kept after a reload: ${JSON.stringify(kept)}`);
for (const slot of ['pattern', 'band', 'strap', 'bg']) await click(`.custom-row[data-slot="${slot}"] .clear`);
await load();
const left = await page.evaluate(() => !!document.querySelector('#patterns [data-key=custom]') || !!document.getElementById('stage').style.backgroundImage);
check(!left, 'cleared images came back after a reload');
await browser.close();
failures.push(...errors.map(e => 'page error: ' + e));
console.log(failures.length ? 'FAILED:\n  ' + failures.join('\n  ') : 'all checks passed, no page errors');
process.exitCode = failures.length ? 1 : 0;
