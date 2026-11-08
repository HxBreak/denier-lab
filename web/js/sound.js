// Sound effects, synthesised with Web Audio (no sound files):
//   rustle   nylon sliding over skin while the welt moves: airy noise plus tiny fibre crackles,
//            louder and brighter the faster the fabric moves
//   stretch  the welt being pulled off the leg: a rising hiss and a rubbery creak while the pull changes
//   snap     the welt slapping back onto the leg when let go, once per bounce
//   grab, off (slides off the toes), on (slides back up the leg)
// Browsers only allow audio after a click or touch, so nothing plays before the first one.
const PREF = 'denier-lab.sound';

export class Sfx {
  constructor() {
    this.ctx = null;
    this.on = true;
    try { this.on = localStorage.getItem(PREF) !== 'off'; } catch { /* no storage: sound stays on */ }
  }

  // call from a click or touch: creates (or wakes) the audio graph
  // (tools/sound-check.mjs passes an OfflineAudioContext to render the sounds without a speaker)
  unlock(offline = null) {
    if (this.ctx) { if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC && !offline) return;
    const ctx = this.ctx = offline || new AC();
    this.live = !offline;
    const comp = ctx.createDynamicsCompressor();
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.on ? 0.9 : 0;
    this.master.connect(comp);

    // two seconds of white noise: the raw material for everything
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;

    this.rustle = this._bed([['highpass', 1500, 0.7], ['bandpass', 3500, 0.6]]);
    this.hiss = this._bed([['bandpass', 1800, 2.5]]);
    // creak: a slow sawtooth (the welt sticking and slipping) through a narrow band
    this.creak = this._chain([['bandpass', 800, 5]]);
    this.creakOsc = ctx.createOscillator();
    this.creakOsc.type = 'sawtooth';
    this.creakOsc.frequency.value = 40;
    this.creakOsc.connect(this.creak.input);
    this.creakOsc.start();

    if (!offline) document.addEventListener('visibilitychange', () => {
      if (document.hidden) ctx.suspend(); else ctx.resume();
    });
  }

  setOn(on) {
    this.on = on;
    try { localStorage.setItem(PREF, on ? 'on' : 'off'); } catch { /* not remembered */ }
    if (this.ctx) this.master.gain.setTargetAtTime(on ? 0.9 : 0, this.ctx.currentTime, 0.05);
  }

  // every frame. speed: how fast the fabric moves (m/s); tension: how far the welt is pulled off
  // the leg (0..1); rate: how fast that changes (1/s)
  update(speed, tension, rate) {
    const ctx = this.ctx;
    if (!ctx) return;
    // muted, or nothing moving and nothing playing: no need to schedule anything every frame
    const quiet = !this.on || (speed === 0 && tension === 0);
    if (quiet && this._quiet) return;
    this._quiet = quiet;
    const t = ctx.currentTime;
    if (quiet) speed = tension = rate = 0;    // one last update fades the beds out
    const v = Math.min(1, speed / 0.25);
    this.rustle.gain.gain.setTargetAtTime(0.2 * v, t, 0.04);
    this.rustle.filters[1].frequency.setTargetAtTime(2600 + 3200 * v, t, 0.05);
    // fibres catching on each other: more crackles the faster it goes
    if (this.on && Math.random() < v * 0.5) this._grain(0.04 + 0.08 * v);

    const pulling = tension * Math.min(1, Math.abs(rate) / 0.6);
    this.hiss.gain.gain.setTargetAtTime(0.18 * pulling + 0.03 * tension, t, 0.05);
    this.hiss.filters[0].frequency.setTargetAtTime(1200 + 2400 * tension, t, 0.05);
    this.creak.gain.gain.setTargetAtTime(0.12 * pulling, t, 0.04);
    this.creak.filters[0].frequency.setTargetAtTime(600 + 900 * tension, t, 0.05);
    this.creakOsc.frequency.setTargetAtTime(28 + 70 * tension + 10 * Math.random(), t, 0.03);
  }

  // the welt slapping back onto the skin (strength 0..1)
  snap(strength) {
    if (!this._ready() || strength < 0.04) return;
    const ctx = this.ctx, t = ctx.currentTime, s = Math.min(1, strength);
    const slap = this._burst(0.12, [['lowpass', 1600 + 3000 * s, 0.8]]);
    slap.gain.setValueAtTime(0, t);
    slap.gain.linearRampToValueAtTime(1.1 * s, t + 0.003);
    slap.gain.exponentialRampToValueAtTime(0.001, t + 0.07 + 0.05 * s);
    // and the thump of the leg under it
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.12);
    g.gain.setValueAtTime(0.6 * s, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.16);
  }

  // a finger hooking under the welt
  grab() {
    if (!this._ready()) return;
    const t = this.ctx.currentTime, g = this._burst(0.05, [['bandpass', 2600, 1.6]]);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
  }

  // the stocking slides off the toes
  off() {
    if (!this._ready()) return;
    this._whoosh(0.5, 2600, 500, 0.3);
    const ctx = this.ctx, t = ctx.currentTime + 0.32, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(620, t);
    o.frequency.exponentialRampToValueAtTime(240, t + 0.08);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.25, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.12);
  }

  // the stocking slides back up the leg over `dur` seconds
  putOn(dur) {
    if (!this._ready()) return;
    this._whoosh(dur, 500, 3000, 0.22);
  }

  _ready() {
    if (!this.ctx || !this.on) return false;
    if (this.live && this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    return true;
  }

  // filters in a row into a gain into the master; returns { input, filters, gain }
  _chain(spec) {
    const ctx = this.ctx, filters = spec.map(([type, f, q]) => {
      const b = ctx.createBiquadFilter();
      b.type = type; b.frequency.value = f; b.Q.value = q;
      return b;
    });
    const gain = ctx.createGain();
    gain.gain.value = 0;
    filters.reduce((a, b) => a.connect(b)).connect(gain).connect(this.master);
    return { input: filters[0], filters, gain };
  }

  // a looping noise bed through filters, silent until update() turns it up
  _bed(spec) {
    const ch = this._chain(spec), src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.connect(ch.input);
    src.start(0, Math.random() * 2);
    return ch;
  }

  // a one-off noise burst through filters; returns its gain to shape
  _burst(dur, spec) {
    const ch = this._chain(spec), src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.connect(ch.input);
    src.start(this.ctx.currentTime, Math.random() * 1.5, dur + 0.02);
    return ch.gain;
  }

  // one fibre crackle: a few ms of high noise
  _grain(level) {
    const t = this.ctx.currentTime, dur = 0.006 + Math.random() * 0.012;
    const g = this._burst(dur, [['bandpass', 3000 + Math.random() * 5000, 4]]).gain;
    g.setValueAtTime(level, t);
    g.exponentialRampToValueAtTime(0.001, t + dur);
  }

  // noise swept from f0 to f1 Hz, swelling and fading over dur seconds
  _whoosh(dur, f0, f1, level) {
    const ch = this._chain([['bandpass', f0, 1.4]]), src = this.ctx.createBufferSource(), t = this.ctx.currentTime;
    src.buffer = this.noise;
    src.loop = true;
    src.connect(ch.input);
    ch.filters[0].frequency.setValueAtTime(f0, t);
    ch.filters[0].frequency.exponentialRampToValueAtTime(f1, t + dur);
    ch.gain.gain.setValueAtTime(0, t);
    ch.gain.gain.linearRampToValueAtTime(level, t + dur * 0.3);
    ch.gain.gain.linearRampToValueAtTime(0, t + dur);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }
}
