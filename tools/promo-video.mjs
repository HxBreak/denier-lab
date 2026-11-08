// Records a ~45 s vertical (1080×1920) promo video of the simulator: the page is reduced to the stage,
// captions are drawn on top of it in the page, a script drives the controls and the welt with real
// mouse events, and the page's own synthesised sound effects are recorded alongside.
//   node tools/promo-video.mjs [url] [out-dir]   ->  <out-dir>/denier-promo.mp4
// Needs ffmpeg and the page served (./serve.sh).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const url = process.argv[2] || 'http://127.0.0.1:8090/';
const out = path.resolve(process.argv[3] || 'shots/promo');
const framesDir = path.join(out, 'frames');
fs.rmSync(framesDir, { recursive: true, force: true });
fs.mkdirSync(framesDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.setViewport({ width: 540, height: 960, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__dl && document.body.classList.contains("ready")', { timeout: 60000 });
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- the page as a 9:16 stage with captions ----------
await page.addStyleTag({ content: `
  html, body { margin: 0; overflow: hidden; background: #fbf6f3; }
  .info, #panel, .stage-bar, #sound, #perf { display: none !important; }
  .layout { display: block !important; padding: 0 !important; height: 100vh; }
  .stage-wrap { position: fixed !important; inset: 0; padding: 0 !important; margin: 0 !important; }
  .stage { width: 100vw !important; height: 100vh !important; aspect-ratio: auto !important;
           border-radius: 0 !important; border: 0 !important; box-shadow: none !important; }
  #grip { width: 22px; height: 22px; left: -11px; top: -11px; }
  .pv { position: absolute; left: 0; right: 0; pointer-events: none; z-index: 5;
        font-family: "PingFang SC", "Hiragino Sans GB", sans-serif; color: #2a2230;
        transition: opacity .35s, transform .35s; }
  .pv.hide { opacity: 0; transform: translateY(8px); }
  #pv-top { top: 96px; text-align: center; padding: 0 24px; }
  #pv-tag { display: inline-block; font-size: 15px; font-weight: 600; letter-spacing: 1px; color: #fff;
            background: #c2577a; border-radius: 99px; padding: 5px 14px; margin-bottom: 12px; }
  #pv-title { font-size: 38px; font-weight: 800; line-height: 1.22; letter-spacing: 1px;
              text-shadow: 0 2px 0 #fff, 0 0 18px rgba(255,255,255,.9); white-space: pre-line; }
  #pv-bottom { bottom: 230px; display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 0 22px; }
  #pv-chip { font-size: 30px; font-weight: 800; color: #fff; background: rgba(42,34,48,.86);
             border-radius: 16px; padding: 8px 18px; font-variant-numeric: tabular-nums; }
  #pv-sub { font-size: 21px; font-weight: 600; line-height: 1.45; text-align: center; white-space: pre-line;
            background: rgba(255,255,255,.88); border-radius: 16px; padding: 10px 18px;
            box-shadow: 0 6px 20px rgba(60,40,80,.12); }
  #pv-finger { position: fixed; left: -26px; top: -26px; width: 52px; height: 52px; border-radius: 50%;
               background: rgba(194,87,122,.25); border: 3px solid #fff; outline: 2px solid rgba(42,34,48,.55);
               box-shadow: 0 2px 10px rgba(60,40,80,.35); z-index: 6; pointer-events: none;
               opacity: 0; transition: opacity .2s, scale .15s; }
  #pv-finger.on { opacity: 1; }
  #pv-finger.down { scale: .78; background: rgba(194,87,122,.35); }
` });
await page.evaluate(() => {
  const stage = document.getElementById('stage');
  stage.insertAdjacentHTML('beforeend', `
    <div class="pv hide" id="pv-top"><div id="pv-tag">AI打工日记</div><div id="pv-title"></div></div>
    <div class="pv hide" id="pv-bottom"><div id="pv-chip"></div><div id="pv-sub"></div></div>`);
  document.body.insertAdjacentHTML('beforeend', '<div id="pv-finger"></div>');
  const f = document.getElementById('pv-finger');
  addEventListener('mousemove', e => { f.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`; }, true);
  addEventListener('mousedown', () => f.classList.add('down'), true);
  addEventListener('mouseup', () => f.classList.remove('down'), true);
  // the chip can follow a live value (a function evaluated every frame)
  window.__pv = { chip: null };
  const chip = document.getElementById('pv-chip');
  (function tick() { if (window.__pv.chip) chip.textContent = window.__pv.chip(); requestAnimationFrame(tick); })();
  window.__set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input')); };
  // orbit the camera about the vertical through the target, eased, over ms
  window.__orbit = (dAz, ms) => new Promise(done => {
    const { camera, controls } = __dl, t0 = performance.now(), T = controls.target;
    const off0 = camera.position.clone().sub(T);
    (function step(now) {
      const k = Math.min(1, (now - t0) / ms), e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2, a = dAz * e;
      const x = off0.x * Math.cos(a) + off0.z * Math.sin(a), z = -off0.x * Math.sin(a) + off0.z * Math.cos(a);
      camera.position.set(T.x + x, T.y + off0.y, T.z + z);
      if (k < 1) requestAnimationFrame(step); else done();
    })(t0);
  });
});
const cap = (title, sub, chip, tag = true) => page.evaluate((title, sub, chip, tag) => {
  document.getElementById('pv-tag').style.display = tag ? '' : 'none';
  document.getElementById('pv-title').textContent = title || '';
  document.getElementById('pv-top').classList.toggle('hide', !title);
  document.getElementById('pv-sub').textContent = sub || '';
  document.getElementById('pv-sub').style.display = sub ? '' : 'none';
  window.__pv.chip = chip ? new Function('return ' + chip) : null;
  document.getElementById('pv-chip').style.display = chip ? '' : 'none';
  document.getElementById('pv-bottom').classList.toggle('hide', !sub && !chip);
}, title, sub, chip, tag);
const preset = name => page.evaluate(n => [...document.querySelectorAll('#presets button')].find(b => b.textContent === n).click(), name);
const shot = i => page.evaluate(i => __dl.setShot(i), i);
// UI sound effects laid over the page's own sounds when mixing (CC0 files in tools/promo-sfx/)
const SFX_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'promo-sfx');
const events = [];
const sfx = (name, vol = 1, rate = 1, later = 0) => events.push({ name, vol, rate, t: Date.now() / 1000 + later });
let lastTitle = '';
const capS = (title, ...rest) => {
  if (title && title !== lastTitle) { sfx(lastTitle ? 'maximize_004' : 'confirmation_003', lastTitle ? 0.5 : 0.7); lastTitle = title; }
  return cap(title, ...rest);
};
const down = () => { sfx('mouseclick1', 0.55); return page.mouse.down(); };
const up = () => { sfx('mouserelease1', 0.45); return page.mouse.up(); };
const finger = on => page.evaluate(on => document.getElementById('pv-finger').classList.toggle('on', on), on);

// a smooth mouse move (about 60 steps a second)
let mouse = [270, 480];
async function glide(x, y, ms) {
  const [x0, y0] = mouse, n = Math.max(1, Math.round(ms / 16));
  for (let i = 1; i <= n; i++) {
    const k = i / n, e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    await page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e);
    await wait(16);
  }
  mouse = [x, y];
}
// the welt's left and right silhouette on screen at u
const silhouette = u => page.evaluate(u => {
  const { rig, camera } = __dl, r = document.getElementById('view').getBoundingClientRect();
  let L = null, R = null;
  for (let a = -Math.PI; a < Math.PI; a += 0.01) {
    const p = rig.surfacePoint(0, u, a, 0.002).project(camera);
    const x = r.left + (p.x + 1) / 2 * r.width, y = r.top + (1 - p.y) / 2 * r.height;
    if (!L || x < L.x) L = { x, y };
    if (!R || x > R.x) R = { x, y };
  }
  return { L, R };
}, u);
const toScreen = (u, th) => page.evaluate((u, th) => {
  const p = __dl.rig.surfacePoint(0, u, th, 0.004).project(__dl.camera), r = document.getElementById('view').getBoundingClientRect();
  return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];
}, u, th);

// ---------- start state ----------
await preset('经典黑丝');
await shot(0);
await page.evaluate(() => { __dl.sfx.on = true; __dl.sfx.unlock(); __dl.sfx.master.gain.value = 0.9; });
await wait(2500);

// ---------- recording: screencast frames + the sound effects ----------
const cdp = await page.createCDPSession();
const frames = [];
cdp.on('Page.screencastFrame', async f => {
  const file = path.join(framesDir, `${String(frames.length).padStart(5, '0')}.jpg`);
  frames.push({ file, t: f.metadata.timestamp });
  fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
  cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
await page.evaluate(() => {
  const s = __dl.sfx, dest = s.ctx.createMediaStreamDestination();
  s.master.connect(dest);
  const rec = window.__rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 192000 });
  window.__chunks = [];
  rec.ondataavailable = e => window.__chunks.push(e.data);
  rec.start();
  window.__aT0 = Date.now() / 1000;
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1080, maxHeight: 1920, everyNthFrame: 1 });
const tStart = Date.now() / 1000;

// S0 hook
await capS('我让 Claude 写了个\n丝袜模拟器', '在线网站 · 手机电脑打开就能玩');
await page.evaluate(() => { __orbit(0.7, 3800); });
await wait(3900);

// S1 denier
await shot(2);
await capS('厚度：5D → 200D', '透肤度按 D 数实时算\n越厚越不透', '`${__dl.state.denier}D · 透肤 ${document.getElementById("spec-sheer").textContent}`');
await page.evaluate(() => __set('denier', 5));
await wait(900);
const sweep = page.evaluate(() => new Promise(done => {
  const t0 = performance.now();
  (function step(now) {
    const k = Math.min(1, (now - t0) / 4800), d = Math.round(5 * Math.pow(40, k));
    __set('denier', d);
    if (k < 1) requestAnimationFrame(step); else done();
  })(t0);
}));
for (let i = 0; i < 22; i++) { sfx('tick_004', 0.4, 1 + i * 0.035); await wait(218); }   // a knob turning, pitch rising
await sweep;
await wait(700);
await page.evaluate(() => __set('denier', 20));
await wait(300);

// S2 colours + gloss
await capS('颜色 × 光泽', '从哑光扫到亮面\n高光跟着视角走', 'document.getElementById("spec-name").textContent');
await page.evaluate(() => __set('gloss', 0));
const colors = await page.$$eval('.swatches [data-color]', bs => bs.map(b => b.dataset.color));
const glossSweep = page.evaluate(n => new Promise(done => {
  const t0 = performance.now();
  (function step(now) { const k = Math.min(1, (now - t0) / n); __set('gloss', +k.toFixed(2)); if (k < 1) requestAnimationFrame(step); else done(); })(t0);
}), colors.length * 750);
const orbit2 = page.evaluate(() => __orbit(-0.6, 4500));
for (const [i, c] of colors.entries()) { sfx(i % 2 ? 'select_002' : 'select_001', 0.6); await page.$eval(`.swatches [data-color="${c}"]`, b => b.click()); await wait(750); }
await glossSweep; sfx('glass_004', 0.45); await orbit2;
await preset('经典黑丝');
await wait(300);

// S3 patterns
const keys = await page.$$eval('#patterns button', bs => bs.map(b => b.dataset.key));
await capS(`${keys.length} 款花纹`, '一键切换，贴着腿的曲面走', 'document.querySelector("#patterns button.on").title');
const orbit3 = page.evaluate(ms => __orbit(0.5, ms), keys.length * 720);
for (const [i, k] of keys.entries()) { sfx(`toggle_00${i % 3 + 1}`, 0.32); await page.$eval(`#patterns button[data-key="${k}"]`, b => b.click()); await wait(720); }
await orbit3;
await preset('经典黑丝');

// S4 the welt: hook, pull off the leg, sweep, let go
await shot(1);
await capS('袜口是一圈有弹性的边', '用手指勾住往外拉…');
await wait(1000);
const top = await page.evaluate(() => __dl.state.top);
const sil = await silhouette(top + 0.03);
mouse = [sil.R.x + 60, sil.R.y + 40];
await page.mouse.move(...mouse);
await finger(true);
await glide(sil.R.x - 3, sil.R.y, 500);
await down();
await glide(sil.R.x + 80, sil.R.y - 4, 800);
await wait(400);
await capS('袜口是一圈有弹性的边', '接触点跟着手指滑');
await glide(sil.L.x - 80, sil.L.y - 4, 1700);
await wait(300);
await capS('袜口是一圈有弹性的边', '松手——啪！弹回来');
await up();
await wait(1500);
// a second, quicker tug
await glide(sil.R.x - 3, sil.R.y, 400);
await down();
await glide(sil.R.x + 95, sil.R.y + 6, 450);
await wait(150);
await up();
await wait(1300);

// S5 pull down a little: the near side slides, the far side lags and curls
await capS('往下拉一点', '手指这边先滑下\n另一边被带着，卷起来');
const [px, py] = await toScreen(top + 0.02, -0.9);
await glide(px, py, 500);
await down();
const [qx, qy] = await toScreen(top + 0.13, -0.9);
await glide(qx, qy, 2200);
await wait(500);
await up();
await glide(mouse[0] + 90, mouse[1] + 60, 400);
await finger(false);
await wait(700);
await capS('往下拉一点', '一键穿回去');
await page.evaluate(() => __dl.putOn(0));
await wait(2200);

// S6 the toe
await shot(3);
await capS('脚尖是一整个光滑袜头', '不分脚趾 · 花纹不乱');
await wait(1300);
sfx('toggle_002', 0.5); await page.$eval('#patterns button[data-key="1"]', b => b.click());
await page.evaluate(() => { __orbit(-0.35, 2600); });
await wait(2700);

// S7 outro
await preset('玫瑰蕾丝');
await shot(0);
sfx('confirmation_002', 0.6, 1, 0.15); sfx('pluck_001', 0.5, 1, 0.9);
await capS('在线网站，欢迎来玩', '点赞 + 私信，发你链接', '"Denier Lab · 丝袜模拟器"');
await page.evaluate(() => { __orbit(0.6, 4800); });
await wait(5200);

// ---------- stop and save ----------
await cdp.send('Page.stopScreencast');
const tEnd = Date.now() / 1000;
const audio = await page.evaluate(() => new Promise(done => {
  window.__rec.onstop = async () => {
    const b = new Blob(window.__chunks, { type: 'audio/webm' }), r = new FileReader();
    r.onload = () => done({ data: r.result.split(',')[1], t0: window.__aT0 });
    r.readAsDataURL(b);
  };
  window.__rec.stop();
}));
await browser.close();
fs.writeFileSync(path.join(out, 'sfx.webm'), Buffer.from(audio.data, 'base64'));

// frames -> constant 30 fps via concat durations; the audio lines up on wall-clock time
const t0 = frames[0].t;
let list = '';
for (let i = 0; i < frames.length; i++) {
  const next = i + 1 < frames.length ? frames[i + 1].t : tEnd;
  list += `file '${frames[i].file}'\nduration ${Math.max(0.001, next - frames[i].t).toFixed(4)}\n`;
}
list += `file '${frames.at(-1).file}'\n`;
fs.writeFileSync(path.join(out, 'frames.txt'), list);
const delay = Math.round((audio.t0 - t0) * 1000);
const mp4 = path.join(out, 'denier-promo.mp4');
// the page's sounds, then every UI effect at its time (pitched by resampling), mixed and normalised
const inputs = ['-f', 'concat', '-safe', '0', '-i', path.join(out, 'frames.txt'), '-i', path.join(out, 'sfx.webm')];
const chains = [`[1:a]${delay >= 0 ? `adelay=${delay}:all=1` : `atrim=start=${-delay / 1000},asetpts=PTS-STARTPTS`},apad[site]`];
const rates = {};
events.forEach((e, i) => {
  const file = path.join(SFX_DIR, e.name + '.ogg');
  rates[file] ??= +execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', file]).toString().trim();
  inputs.push('-i', file);
  const ms = Math.max(0, Math.round((e.t - t0) * 1000));
  chains.push(`[${i + 2}:a]aformat=channel_layouts=mono,asetrate=${Math.round(rates[file] * e.rate)},aresample=48000,volume=${e.vol * 0.3},adelay=${ms}:all=1[e${i}]`);
});
const mix = `[site]${events.map((_, i) => `[e${i}]`).join('')}amix=inputs=${events.length + 1}:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.84:level=false[a]`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs,
  '-filter_complex', [`[0:v]fps=30,scale=1080:1920:flags=lanczos,format=yuv420p[v]`, ...chains, mix].join(';'),
  '-map', '[v]', '-map', '[a]', '-shortest', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', mp4], { stdio: 'inherit' });
console.log(`${events.length} UI sound effects mixed in`);
console.log(`${frames.length} frames over ${(tEnd - t0).toFixed(1)} s (${(frames.length / (tEnd - t0)).toFixed(1)} fps captured), audio offset ${delay} ms`);
console.log(errors.length ? 'page errors:\n' + errors.join('\n') : 'no page errors');
console.log(mp4);
