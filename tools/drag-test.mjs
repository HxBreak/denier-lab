// With real mouse events: hook the left stocking's welt on one side and pull it away from the leg,
// sweep the finger across to the other side (the contact should follow it), let go (it should
// spring back), then pull the welt down past the toes in stages, taking a screenshot at each stage;
// then put it back on.
//   node tools/drag-test.mjs [url]  ->  shots/drag-*.png
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
// every check that fails is listed at the end and makes the script exit with code 1
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
await wait(800);
const TH = -0.9;                       // outer front of the left leg
const toScreen = (u, out = 0) => page.evaluate((u, th, out) => {
  const { rig, camera } = __dl;
  const p = rig.surfacePoint(0, u, th, 0.004 + out).project(camera);
  const r = document.getElementById('view').getBoundingClientRect();
  return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];
}, u, TH, out);
const liftCm = () => page.evaluate(() => __dl.hook ? +(__dl.hook.m * 100).toFixed(1) : 0);
const contact = () => page.evaluate(() => __dl.drag ? +__dl.drag.th.toFixed(2) : null);
const status = () => page.$eval('#status', e => e.textContent);
const ring = () => page.evaluate(() => {
  const R = __dl.rig.ring[0];
  return `line ${Math.min(...R.line).toFixed(2)}..${Math.max(...R.line).toFixed(2)}, curl ${Math.min(...R.curl).toFixed(2)}..${Math.max(...R.curl).toFixed(2)}`;
});

const top = await page.evaluate(() => __dl.state.top);
// the welt's left and right silhouette on screen, just below the top edge
const sil = await page.evaluate(u => {
  const { rig, camera } = __dl, r = document.getElementById('view').getBoundingClientRect();
  let L = null, R = null;
  for (let a = -Math.PI; a < Math.PI; a += 0.01) {
    const p = rig.surfacePoint(0, u, a, 0.002).project(camera);
    const x = r.left + (p.x + 1) / 2 * r.width, y = r.top + (1 - p.y) / 2 * r.height;
    if (!L || x < L.x) L = { x, y, a };
    if (!R || x > R.x) R = { x, y, a };
  }
  return { L, R };
}, top + 0.03);
await page.mouse.move(sil.R.x - 3, sil.R.y);
await page.mouse.down();
const hooked = await page.evaluate(() => !!__dl.drag), a0 = await contact();
console.log('hooked at the right silhouette:', hooked, '| contact angle', a0, '(silhouette', sil.R.a.toFixed(2) + ')');
check(hooked, 'pressing on the welt did not hook it');
await page.mouse.move(sil.R.x + 70, sil.R.y, { steps: 12 });
await wait(700);
const liftR = await liftCm(), aR = await contact();
console.log('pulled right: lift (cm)', liftR, '| contact angle:', aR);
check(liftR > 3, `pulling right lifted the welt only ${liftR} cm`);
check(aR !== null && aR < a0, 'the contact did not stay on the right side while pulling right');
await page.screenshot({ path: 'shots/drag-0-right.png' });
await page.mouse.move(sil.L.x - 70, sil.L.y, { steps: 30 });
await wait(700);
const liftL = await liftCm(), aL = await contact();
console.log('swept to the left: lift (cm)', liftL, '| contact angle:', aL, '(left silhouette', sil.L.a.toFixed(2) + ')');
check(liftL > 3 && aL !== null && aL > 0.3, 'the contact did not follow the finger to the left');
await page.screenshot({ path: 'shots/drag-0-left.png' });
await page.mouse.up();
await wait(120);
console.log('just let go (cm):', await liftCm());
await wait(1500);
const liftEnd = await liftCm(), active = await page.evaluate(() => !!__dl.hook);
console.log('1.5 s later (cm):', liftEnd, '| still active:', active);
check(liftEnd === 0 && !active, 'the welt did not spring back within 1.5 s');
// a second finger while dragging must not take the drag over; 重新穿上 or switching legs in the middle of
// a drag must end it cleanly (camera works again)
{
  const [x0, y0] = await toScreen(top + 0.02);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await wait(200);
  const id0 = await page.evaluate(() => __dl.drag && __dl.drag.id);
  const [x1, y1] = await toScreen(top + 0.03, 0);
  await page.evaluate((x, y) => document.getElementById('view').dispatchEvent(new PointerEvent('pointerdown',
    { pointerId: 99, pointerType: 'touch', isPrimary: false, clientX: x, clientY: y, bubbles: true })), x1 + 20, y1);
  const id1 = await page.evaluate(() => __dl.drag && __dl.drag.id);
  check(id0 !== null && id1 === id0, 'a second pointer took over the drag');
  await page.evaluate(() => __dl.putOn(0));          // as if a second finger tapped 重新穿上
  const mid = await page.evaluate(() => ({ drag: !!__dl.drag, cam: __dl.controls.enabled }));
  check(!mid.drag && mid.cam, '重新穿上 during a drag left the drag on or the camera off');
  await page.mouse.up();
  await wait(2500);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await wait(200);
  await page.evaluate(() => __dl.focusLeg(1));       // switching legs mid-drag
  const sw = await page.evaluate(() => ({ drag: !!__dl.drag, cam: __dl.controls.enabled }));
  check(!sw.drag && sw.cam, 'switching legs during a drag left the drag on or the camera off');
  await page.mouse.up();
  await page.evaluate(() => __dl.focusLeg(0));
  await wait(1500);
  console.log('second pointer / 重新穿上 / switching legs mid-drag:', failures.length ? 'see failures' : 'ok');
}

await page.click('#put-on');
await wait(2500);

// pull part way down (the far side lags and curls), then back up: the curled far side should come
// up with the finger straight away, and be back at the top when the finger is
const sides = () => page.evaluate(th => {
  const R = __dl.rig.ring[0], k = a => ((Math.round((a + Math.PI) / (Math.PI * 2) * 48) % 48) + 48) % 48;
  const f = k(th), o = k(th + Math.PI), q = k(th + Math.PI / 2);
  return `finger ${R.line[f].toFixed(3)} | side ${R.line[q].toFixed(3)} curl ${R.curl[q].toFixed(2)} | far ${R.line[o].toFixed(3)} curl ${R.curl[o].toFixed(2)}`;
}, TH);
{
  const [xa, ya] = await toScreen(top + 0.02);
  await page.mouse.move(xa, ya);
  await page.mouse.down();
  const [xb, yb] = await toScreen(0.66);
  await page.mouse.move(xb, yb, { steps: 15 });
  await wait(1500);
  console.log('down to 0.66:', await sides());
  await page.screenshot({ path: 'shots/drag-up-0.png' });
  let i = 0;
  for (const u of [0.6, 0.5, 0.4, top - 0.05]) {
    const [x, y] = await toScreen(u);
    await page.mouse.move(x, y, { steps: 8 });
    await wait(900);
    console.log(`back up to ${u.toFixed(2)}:`, await sides());
    if (++i === 2) await page.screenshot({ path: 'shots/drag-up-1.png' });
  }
  await page.mouse.up();
  const st = await status();
  console.log('let go:', st);
  check(st.endsWith('穿着'), `after pulling back up to the top the status is "${st}", not worn`);
}

const [x1, y1] = await toScreen(top + 0.02);
await page.mouse.move(x1, y1);
await page.mouse.down();
let n = 0;
for (const u of [0.42, 0.55, 0.7, 0.85, 0.95]) {
  const [x, y] = await toScreen(u);
  await page.mouse.move(x, y, { steps: 12 });
  await wait(1200);
  console.log(`pulled to ${u}:`, await status(), '|', await ring());
  await page.screenshot({ path: `shots/drag-${++n}.png` });
}
for (const u of [1.1, 1.25, 1.38]) {
  const [x, y] = await toScreen(u);
  await page.mouse.move(x, y, { steps: 12 });
  await wait(1200);
  console.log(`past toes ${u}:`, await status(), '|', await ring());
}
check((await status()).endsWith('已脱下'), 'pulling past the toes did not take the stocking off');
await page.mouse.up();
await page.screenshot({ path: `shots/drag-${++n}.png` });
await page.click('#put-on');
await wait(3500);
const back = await status();
console.log('after 重新穿上:', back);
check(back.endsWith('穿着'), `after 重新穿上 the status is "${back}"`);
// the camera must work again after a drag ends in every way (finger up, 重新穿上, switching legs)
check(await page.evaluate(() => __dl.controls.enabled), 'the camera controls were left disabled');
await page.click('[data-leg="1"]');
await wait(1500);
await page.screenshot({ path: `shots/drag-${++n}-right.png` });
failures.push(...errors.map(e => 'page error: ' + e));
console.log(failures.length ? 'FAILED:\n  ' + failures.join('\n  ') : 'all checks passed, no page errors');
process.exitCode = failures.length ? 1 : 0;
await browser.close();
