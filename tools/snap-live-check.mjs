// Pull the welt off the leg with real mouse events and let go, three times (small, medium, large pull),
// recording what the page actually plays: which snaps fire, at what strength, whether the recorded snap
// (web/sfx/snap.mp3) or the synthesised fallback played, and the audio itself (MediaRecorder on the
// sound's master bus). Writes shots/snap-live.webm and prints the level and brightness of every snap
// heard in it. Exits with 1 if a release made no snap or the recording was not used.
//   node tools/snap-live-check.mjs [url]        (ffmpeg needed for the analysis)
// SNAP_MODE=snap-only keeps only the snaps (the drag sounds are silenced), SNAP_MODE=no-snap the opposite,
// to tell which sound is which; the recording then goes to shots/snap-live-<mode>.webm.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import { execFileSync } from 'child_process';
const url = process.argv[2] || 'http://127.0.0.1:8090/';
const MODE = process.env.SNAP_MODE || 'all';
const OUT = MODE === 'all' ? 'shots/snap-live.webm' : `shots/snap-live-${MODE}.webm`;
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.setDefaultTimeout(300000);
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.setViewport({ width: 1440, height: 860 });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction('document.body.classList.contains("ready")');
await page.mouse.click(20, 20);                      // the first click unlocks audio
await page.evaluate(async mode => {
  const s = __dl.sfx;
  s.unlock(); await s.loaded;
  window.__snaps = [];
  const orig = s.snap.bind(s);
  s.snap = st => { if (st >= 0.04) __snaps.push({ t: performance.now(), s: +st.toFixed(2), recorded: !!s.slaps }); if (mode !== 'no-snap') orig(st); };
  if (mode === 'snap-only') { const up = s.update.bind(s); s.update = () => up(0, 0, 0); }
  const dest = s.ctx.createMediaStreamDestination();
  s.master.connect(dest);
  window.__chunks = [];
  const rec = window.__rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 192000 });
  rec.ondataavailable = e => __chunks.push(e.data);
  // times are measured from when the recorder really starts, so they line up with the recording
  await new Promise(ok => { rec.onstart = () => { window.__t0 = performance.now(); ok(); }; rec.start(); });
}, MODE);
const wait = ms => new Promise(r => setTimeout(r, ms));
const top = await page.evaluate(() => __dl.state.top);
const sil = await page.evaluate(u => {
  const { rig, camera } = __dl, r = document.getElementById('view').getBoundingClientRect();
  let R = null;
  for (let a = -Math.PI; a < Math.PI; a += 0.01) {
    const p = rig.surfacePoint(0, u, a, 0.002).project(camera);
    const x = r.left + (p.x + 1) / 2 * r.width, y = r.top + (1 - p.y) / 2 * r.height;
    if (!R || x > R.x) R = { x, y };
  }
  return R;
}, top + 0.03);
const pulls = [];
for (const px of [30, 70, 150]) {
  await page.mouse.move(sil.x - 3, sil.y);
  await page.mouse.down();
  await page.mouse.move(sil.x + px, sil.y, { steps: 10 });
  await wait(600);
  const lift = await page.evaluate(() => __dl.hook ? +(__dl.hook.m * 100).toFixed(1) : 0);
  const n0 = await page.evaluate(() => __snaps.length);
  await page.mouse.up();
  await wait(1600);
  const fired = await page.evaluate(n0 => __snaps.slice(n0).map(x => ({ ...x, t: +((x.t - __t0) / 1000).toFixed(2) })), n0);
  pulls.push({ px, lift, fired });
}
const b64 = await page.evaluate(() => new Promise(res => {
  __rec.onstop = async () => {
    const buf = await new Blob(__chunks, { type: 'audio/webm' }).arrayBuffer();
    let s = ''; const u = new Uint8Array(buf);
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    res(btoa(s));
  };
  __rec.stop();
}));
await browser.close();
fs.mkdirSync('shots', { recursive: true });
fs.writeFileSync(OUT, Buffer.from(b64, 'base64'));

const failures = [];
for (const p of pulls) {
  console.log(`pulled ${p.px}px out (welt lifted ${p.lift} cm), let go -> ${p.fired.length} snaps: ` +
    p.fired.map(f => `${f.t}s strength ${f.s}${f.recorded ? '' : ' (SYNTH)'}`).join(', '));
  if (!p.fired.length) failures.push(`no snap after letting go of a ${p.px}px pull`);
  if (p.fired.some(f => !f.recorded)) failures.push('a snap played the synthesised fallback, not the recording');
}
// the recording: level and brightness around each snap that fired
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', OUT, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
const d = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4), sr = 48000;
const offset = 0;                                   // __t0 is the recorder's start event
console.log(`recording: ${(d.length / sr).toFixed(1)} s, ${fs.statSync(OUT).size} bytes, shots/snap-live.webm`);
for (const f of pulls.flatMap(p => p.fired)) {
  const a = Math.max(0, Math.round((f.t + offset - 0.02) * sr)), b = Math.min(d.length, a + Math.round(0.2 * sr));
  let peak = 0, e = 0, ed = 0;
  for (let i = a + 1; i < b; i++) { peak = Math.max(peak, Math.abs(d[i])); e += d[i] ** 2; ed += (d[i] - d[i - 1]) ** 2; }
  console.log(`  snap at ${f.t}s strength ${f.s}: peak ${(20 * Math.log10(peak || 1e-9)).toFixed(1)} dB, brightness ${(ed / (e || 1e-12)).toFixed(2)}`);
  if (peak < 0.003) failures.push(`snap at ${f.t}s is silent in the recording`);
}
failures.push(...errors.map(e => 'page error: ' + e));
console.log(failures.length ? 'FAILED:\n  ' + failures.join('\n  ') : 'all checks passed, no page errors');
process.exitCode = failures.length ? 1 : 0;
