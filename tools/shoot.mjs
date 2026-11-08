// Screenshot checks: node tools/shoot.mjs [url] -> shots/*.png
import puppeteer from 'puppeteer-core';
const url = process.argv[2] || 'http://127.0.0.1:8090/';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const open = async (w, h, mobile = false) => {
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(String(e)));
  await page.setViewport({ width: w, height: h, isMobile: mobile, hasTouch: mobile });
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.__dl', { timeout: 60000 });
  return page;
};
const shot = async (page, name, js, wait = 1500) => {
  if (js) await page.evaluate(js);
  await new Promise(r => setTimeout(r, wait));
  await page.screenshot({ path: `shots/${name}.png` });
};
// pull the welt down at angle th to u, in small steps like a drag would
const pull = (s, th, u) => `(() => { const d = __dl; for (let x = d.state.top; x <= ${u}; x += 0.01) d.rig.pull(${s}, ${th}, x, d.state.top); d.state.dirty = true; })()`;
// hook the welt at the leg's left or right silhouette on screen and pull it `cm` off the leg
// (held still for the screenshot)
const liftOff = (s, cm, dir = -1) => `(() => { const d = __dl, r = d.rig;
  let th = 0, best = Infinity;
  for (let a = -Math.PI; a < Math.PI; a += 0.02) {
    const u = Math.min(r.ringAt(${s}, a)[0], r.uEnd[${s}]), x = r.surfacePoint(${s}, u, a, 0).project(d.camera).x * ${-dir};
    if (x < best) { best = x; th = a; }
  }
  const u = Math.min(r.ringAt(${s}, th)[0], r.uEnd[${s}]), R = r.sectionRadius(${s}, u, th) + 0.0015 + ${cm} / 100;
  r.update(${s}, d.state.top, 0.0015, { s: ${s}, u, F2: [R * Math.cos(th), R * Math.sin(th)] }, d.camera);
  d.renderer.render(d.scene, d.camera); })()`;   // the page only redraws on its own changes

const desk = await open(1440, 860);
await shot(desk, '01-left');
await shot(desk, '02-pulled', pull(0, -0.5, 0.55));
await shot(desk, '03-lifted', liftOff(0, 8, -1), 300);
await shot(desk, '04-foot', `__dl.putOn(0); __dl.setShot(3)`, 3500);
await shot(desk, '05-right-thigh', `__dl.focusLeg(1); __dl.setShot(1)`);
await shot(desk, '06-right-lift-worn', liftOff(1, 8, 1), 300);
await shot(desk, '09-fishnet-foot', `__dl.focusLeg(0); __dl.setShot(3); document.querySelector('#patterns button[data-key="1"]').click()`);
await shot(desk, '10-plain-foot-front', `document.querySelector('#patterns button[data-key="0"]').click(); const c = __dl.controls, t = c.target; __dl.camera.position.set(t.x + 0.12, t.y + 0.2, t.z + 0.4); c.update()`);
const phone = await open(390, 844, true);
await shot(phone, '07-mobile');
await shot(phone, '08-mobile-scrolled', `window.scrollTo(0, 700)`);
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
