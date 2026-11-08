// Renders the same half-removed, hooked stocking with and without the coarse out-of-sight fabric,
// from a few angles, and reports how many pixels differ.
//   node tools/lod-check.mjs [url]  ->  shots/lod-*.png
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.setViewport({ width: 1440, height: 860 });
await page.goto(process.argv[2] || 'http://127.0.0.1:8090/', { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__dl');
const wait = ms => new Promise(r => setTimeout(r, ms));
await wait(800);
for (const [i, az] of [0.55, 2.0, -1.2].entries()) {
  const shots = [];
  for (const lod of [false, true]) {
    shots.push(await page.evaluate(async (az, lod) => {
      const { rig, state, camera, controls } = __dl, top = state.top;
      controls.enableDamping = false;
      rig.lod = lod;
      rig.resetRing(0, top);
      for (let l = top; l < 0.6; l += 0.01) rig.pull(0, -0.9, l, top);
      const t = controls.target, d = camera.position.distanceTo(t);
      camera.position.set(t.x + d * Math.sin(az), t.y, t.z + d * Math.cos(az));
      controls.update();
      rig.invalidate(0);
      state.dirty = true;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      state.dirty = true;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      // the page only draws when something changes, so draw now and read the canvas straight away
      __dl.renderer.render(__dl.scene, camera);
      return [document.getElementById('view').toDataURL(), rig.stats.coarse];
    }, az, lod));
  }
  const diff = await page.evaluate(async (a, b) => {
    const load = src => new Promise(r => { const im = new Image(); im.onload = () => r(im); im.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height;
    const x = c.getContext('2d');
    x.drawImage(ia, 0, 0); const da = x.getImageData(0, 0, c.width, c.height).data;
    x.clearRect(0, 0, c.width, c.height);
    x.drawImage(ib, 0, 0); const db = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0, big = 0, fg = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let p = 0; p < da.length; p += 4) {
      const d = Math.max(...[0, 1, 2, 3].map(k => Math.abs(da[p + k] - db[p + k])));
      if (da[p + 3] > 0) fg++;
      if (d > 8) n++;
      if (d > 40) {
        big++;
        const px = (p / 4) % c.width, py = (p / 4) / c.width | 0;
        x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
      }
    }
    return { n, big, fg, box: big ? [x0, y0, x1, y1] : null };
  }, shots[0][0], shots[1][0]);
  console.log(`camera ${az}: ${shots[1][1]} vertices filled in | pixels differing >8: ${diff.n}, >40: ${diff.big} (of ${diff.fg} drawn)${diff.box ? ' in box ' + diff.box.join(',') : ''}`);
  if (diff.box) {
    // the differing area, both ways, 4x: exact on the left, coarse on the right
    const crop = await page.evaluate(async (a, b, box) => {
      const load = src => new Promise(r => { const im = new Image(); im.onload = () => r(im); im.src = src; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const [x0, y0, x1, y1] = box, w = x1 - x0 + 21, h = y1 - y0 + 21, c = document.createElement('canvas');
      c.width = w * 8 + 8; c.height = h * 4;
      const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      x.imageSmoothingEnabled = false;
      x.drawImage(ia, x0 - 10, y0 - 10, w, h, 0, 0, w * 4, h * 4);
      x.drawImage(ib, x0 - 10, y0 - 10, w, h, w * 4 + 8, 0, w * 4, h * 4);
      return c.toDataURL();
    }, shots[0][0], shots[1][0], diff.box);
    const fs = await import('fs');
    fs.writeFileSync(`shots/lod-${i}.png`, Buffer.from(crop.split(',')[1], 'base64'));
  }
}
// incremental updates must give the same result as recomputing the whole leg, coarse fabric included:
// replay a pull down, a hook and a pull back up, and after each step compare against a full recompute
const mismatch = await page.evaluate(() => {
  const { rig, state, camera } = __dl, top = state.top, thick = 0.0015, g = rig.geometry;
  const P = g.attributes.position.array, N = g.attributes.normal.array;
  const n0 = rig.base[0] * 3, n1 = rig.base[1] * 3;
  rig.lod = true;
  rig.resetRing(0, top); rig.invalidate(0); rig.update(0, top, thick, null, camera);
  let worstP = 0, worstN = 0, steps = 0, hand = top;
  const hookAt = u => { const r = rig.sectionRadius(0, u, 1.6) + thick + 0.04; return { s: 0, u, F2: [r * Math.cos(1.6), r * Math.sin(1.6)] }; };
  const plan = [...Array(40).fill(0.01), ...Array(30).fill(-0.01)];
  for (const [i, d] of plan.entries()) {
    hand += d;
    rig.pull(0, -0.9, hand, top);
    const hk = i > 20 && i < 50 ? hookAt(Math.max(top, hand)) : null;
    rig.update(0, top, thick, hk, camera);
    const p = P.slice(n0, n1), nn = N.slice(n0, n1);
    rig.invalidate(0);
    rig.update(0, top, thick, hk, camera);
    // only what can be seen: the shader cuts away everything above the top, but the ring just above
    // it still shades the visible part of the triangles that cross the cut
    for (let j = 0; j < p.length; j++) {
      if (rig.u[(n0 + j) / 3 | 0] < top - 0.0045) continue;
      worstP = Math.max(worstP, Math.abs(p[j] - P[n0 + j]));
      worstN = Math.max(worstN, Math.abs(nn[j] - N[n0 + j]));
    }
    steps++;
  }
  rig.resetRing(0, top); state.dirty = true;
  return { steps, worstP, worstN };
});
console.log(`incremental vs full recompute over ${mismatch.steps} steps: max position difference ${mismatch.worstP.toExponential(1)} m, max normal difference ${mismatch.worstN.toExponential(1)}`);
if (mismatch.worstP > 1e-6 || mismatch.worstN > 1e-4) errors.push('incremental update differs from a full recompute');
console.log(errors.length ? errors.join('\n') : 'no page errors');
process.exitCode = errors.length ? 1 : 0;
await browser.close();
