// Times StockingRig.update() (the per-frame CPU deformation) in a few states, the way a frame
// during a drag runs it (only the rings that can move), plus a full recompute for comparison.
//   node tools/perf.mjs [url]
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.setViewport({ width: 1440, height: 860 });
await page.goto(process.argv[2] || 'http://127.0.0.1:8090/', { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__dl');
await new Promise(r => setTimeout(r, 800));
const res = await page.evaluate(() => {
  const { rig, state, camera } = __dl, top = state.top, thick = 0.0015;
  const hook = (u, lift) => { const r = rig.sectionRadius(0, u, 1.6) + thick + lift; return { s: 0, u, F2: [r * Math.cos(1.6), r * Math.sin(1.6)] }; };
  const pullTo = u => { rig.resetRing(0, top); for (let l = top; l < u; l += 0.01) rig.pull(0, -0.9, l, top); };
  const time = (label, opts) => {
    const N = 40;
    rig.update(0, top, thick, opts.hook || null, opts.cam ? camera : null);
    const t0 = performance.now();
    let st = null;
    for (let i = 0; i < N; i++) {
      if (opts.full) rig.invalidate(0);
      rig.update(0, top, thick, opts.hook || null, opts.cam ? camera : null);
      st = rig.stats;
    }
    const dt = (performance.now() - t0) / N;
    return `${label.padEnd(34)} ${dt.toFixed(2).padStart(5)} ms  (${st.rows} rings, ${st.verts} exact + ${st.coarse} filled in)`;
  };
  const out = [`vertices ${rig.u.length} (both legs), triangles ${rig.geometry.index.count / 3}`];
  rig.resetRing(0, top); rig.invalidate(0);
  out.push(time('worn', {}));
  pullTo(0.55);
  out.push(time('pulled to 0.55, full recompute', { full: true }));
  out.push(time('pulled to 0.55', {}));
  out.push(time('pulled to 0.55, out of sight coarse', { cam: true }));
  out.push(time('pulled + hooked 5 cm, coarse', { cam: true, hook: hook(0.55, 0.05) }));
  pullTo(0.93);
  out.push(time('pulled to the toes, coarse', { cam: true }));
  rig.resetRing(0, top);
  return out;
});
console.log(res.join('\n'));
if (errors.length) console.log('page errors:', errors);
await browser.close();
