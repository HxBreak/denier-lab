// Renders each sound effect offline (no speaker needed) and prints its peak and loudness, to check
// that everything is audible and nothing clips. Then, in a browser with the default autoplay policy,
// checks that no audio starts before a click and that it does start on the first click.
// Exits with code 1 if a check fails.
//   node tools/sound-check.mjs [url]
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
// the public site can be very slow in the evening (about 25 KB/s on 2026-11-08): allow 5 minutes to load
page.setDefaultTimeout(300000);
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.setViewport({ width: 1440, height: 860 });
// wait for load, not networkidle0: on the live site that never fired within 15 minutes on 2026-11-08
await page.goto(process.argv[2] || 'http://127.0.0.1:8090/', { waitUntil: 'load' });
await page.waitForFunction('window.__dl');
const res = await page.evaluate(async () => {
  const { Sfx } = await import('./js/sound.js');
  const render = async (name, secs, play) => {
    const ctx = new OfflineAudioContext(1, 44100 * secs, 44100), sfx = new Sfx();
    sfx.on = true;
    sfx.unlock(ctx);
    await sfx.loaded;                      // the recorded snap (web/sfx/snap.mp3)
    if (/snap/.test(name) && !sfx.slaps) throw new Error('snap.mp3 did not load');
    play(sfx);
    const d = (await ctx.startRendering()).getChannelData(0);
    let peak = 0, sum = 0;
    for (const v of d) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
    const db = x => (20 * Math.log10(x || 1e-9)).toFixed(1).padStart(6);
    return `peak ${db(peak)} dB  rms ${db(Math.sqrt(sum / d.length))} dB`;
  };
  return [
    ['grab', 0.2, s => s.grab()],
    ['snap (hard)', 0.3, s => s.snap(1)],
    ['snap (last bounce)', 0.3, s => s.snap(0.12)],
    ['off', 0.8, s => s.off()],
    ['putOn 1.5 s', 1.6, s => s.putOn(1.5)],
    ['rustle, fast drag', 1, s => s.update(0.3, 0, 0)],
    ['rustle, slow drag', 1, s => s.update(0.05, 0, 0)],
    ['stretch, pulling out', 1, s => s.update(0.1, 0.8, 1.5)],
    ['held still', 1, s => s.update(0, 0.8, 0)],
    ['silent (nothing moving)', 1, s => s.update(0, 0, 0)],
  ].reduce(async (acc, [name, secs, fn]) => [...await acc, `${name.padEnd(24)} ${await render(name, secs, fn)}`], []);
});
console.log(res.join('\n'));
// the real thing, under the default autoplay policy: nothing before a click, running after it
const failures = [];
const before = await page.evaluate(() => __dl.sfx.ctx ? __dl.sfx.ctx.state : 'none');
await page.mouse.click(700, 300);
await new Promise(r => setTimeout(r, 300));
const after = await page.evaluate(() => __dl.sfx.ctx && __dl.sfx.ctx.state);
console.log('audio before any click:', before, '| after a click:', after);
if (before !== 'none') failures.push(`audio was created before any click (${before})`);
if (after !== 'running') failures.push(`audio did not start on the first click (${after})`);
await page.click('#sound');
console.log('sound button -> on =', await page.evaluate(() => __dl.sfx.on), '| remembered:', await page.evaluate(() => localStorage.getItem('denier-lab.sound')));
await page.click('#sound');
// the volume slider: starts at half, sets the master gain, is remembered, and turns muted sound back on
const vol0 = await page.evaluate(() => [__dl.sfx.vol, document.getElementById('vol-v').textContent]);
await page.click('#sound');                                   // mute first
await page.$eval('#vol', el => { el.value = 0.2; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
await new Promise(r => setTimeout(r, 400));
const vol1 = await page.evaluate(() => ({ vol: __dl.sfx.vol, on: __dl.sfx.on, gain: +__dl.sfx.master.gain.value.toFixed(3),
  stored: localStorage.getItem('denier-lab.volume'), label: document.getElementById('vol-v').textContent }));
console.log('volume at start:', vol0.join(' '), '| after setting 20%:', JSON.stringify(vol1));
if (vol0[0] !== 0.5) failures.push(`volume should start at 0.5, got ${vol0[0]}`);
if (!vol1.on || vol1.vol !== 0.2 || Math.abs(vol1.gain - 0.2) > 0.01 || vol1.stored !== '0.2')
  failures.push('volume slider did not turn sound on, set the gain to 0.2 and remember it');
failures.push(...errors.map(e => 'page error: ' + e));
console.log(failures.length ? 'FAILED:\n  ' + failures.join('\n  ') : 'all checks passed, no page errors');
process.exitCode = failures.length ? 1 : 0;
await browser.close();
