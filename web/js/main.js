import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { StockingRig } from './stocking.js';
import { skinMaterial, stockingMaterial, outlineMaterial } from './toon.js';
import { Sfx } from './sound.js';
import { saveSlot, loadSlots, scaleFile, makeTexture } from './custom.js';

const $ = id => document.getElementById(id);
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const VFOV = 28;
const YMAX = 0.74;                         // nothing above mid-thigh is ever in frame
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(VFOV, 1, 0.05, 20);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 0.3;
controls.minPolarAngle = 1.1;
controls.maxPolarAngle = 1.62;

const state = {
  color: '#1b1b22', denier: 20, gloss: 0.35, pattern: 0, band: 2, top: 0.3,
  patternId: null,                         // with pattern 3: which generated mask (web/patterns/)
  tight: 0.5,                              // how hard the welt clings to the leg (rig.tight)
  bounce: 0.2,                             // how much a welt let go bounces off the leg: restitution 0.45 * bounce
  grad: 0, gradColor: '#6e1f2e', gradPos: 0.5, flip: 0,   // gradient: 0 off, 1 colour, 2 sheerness (see toon.js)
  strap: 0, strapColor: '#15151a',         // criss-cross ribbons: 0 off, 1 ankle, 2 calf, 3 up to the welt
  knee: 1, shine: 1,                       // leg details (toon.js): knee lines, shine strip
  customAround: 3,                         // a custom pattern image: repeats round the leg
  outline: 1,                              // 2 outline meshes, 1 soft edge in the shaders, 0 none
  focus: 0,                                // which leg is shown: 0 left (+x), 1 right
  shot: 0,                                 // camera framing, see SHOTS
  off: [false, false],
  anim: [null, null],                      // putting a stocking back on
  dirty: true,
};

// the model is Draco-compressed (tools/compress-model.sh); index.html has usually started downloading it
const gltfLoader = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath('vendor/three/jsm/libs/draco/gltf/'));
const modelBytes = window.__model || fetch('models/legs.glb').then(r => r.arrayBuffer());
const [gltf, info, patterns] = await Promise.all([
  modelBytes.then(buf => gltfLoader.parseAsync(buf, '')),
  fetch('models/legs.json').then(r => r.json()),
  fetch('patterns/patterns.json').then(r => r.ok ? r.json() : []).catch(() => []),   // tools/gen_patterns.py
]);
const legGeo = gltf.scene.getObjectByName('Legs').geometry;
const stockGeo = gltf.scene.getObjectByName('Stocking').geometry;
legGeo.setAttribute('aLegU', legGeo.attributes.uv1);       // u along the leg, under a name the shaders can declare
const skinRange = splitLegs(legGeo);
const rig = new StockingRig(stockGeo, info);
rig.resetRing(0, state.top);
rig.resetRing(1, state.top);
// out-of-sight fabric is only computed coarsely, so redo it when the camera moves
controls.addEventListener('change', () => { if (rig.coarse) state.dirty = true; });

const skin = skinMaterial();
const stock = stockingMaterial();
skin.uniforms.uKnee.value.set(info.l.knee, info.r.knee);
stock.uniforms.uKnee.value.set(info.l.knee, info.r.knee);
stock.uniforms.uToe.value.set(rig.uBall[0] - 0.035, rig.uBall[1] - 0.035);
const outlines = [outlineMaterial(1.6, '#3b2228', null, skin), outlineMaterial(1.8, '#141018', stock)];

const legs = new THREE.Mesh(legGeo, skin);
const stocking = new THREE.Mesh(rig.geometry, stock);
const stockingLine = new THREE.Mesh(rig.geometry, outlines[1]);
stocking.renderOrder = 2;
stocking.frustumCulled = stockingLine.frustumCulled = false;
const shadow = groundShadow();
const skinLine = new THREE.Mesh(legGeo, outlines[0]);
scene.add(legs, skinLine, stocking, stockingLine, shadow);

// ---------- camera: one leg, a few framings, never above mid-thigh ----------
// u: where along the leg to look; half / halfW: half the height / width to fit in frame (m);
// polar, az: camera elevation and how far round to the outer side
const SHOTS = [
  { u: 0.55, half: 0.43, halfW: 0.2, polar: 1.5, az: 0.55 },     // whole leg
  { u: 0.33, half: 0.17, halfW: 0.12, polar: 1.5, az: 0.55 },    // thigh
  { u: 0.62, half: 0.22, halfW: 0.13, polar: 1.5, az: 0.55 },    // calf
  { u: 0.87, half: 0.12, halfW: 0.17, polar: 1.25, az: 1.0 },    // foot, from the side and a little above
];
const view = { target: new THREE.Vector3(), pos: new THREE.Vector3(), moving: false };
const fitDistance = sh => {
  const t = Math.tan(THREE.MathUtils.degToRad(VFOV) / 2);
  return Math.max(sh.half / t, sh.halfW / (t * camera.aspect));
};

// lower target and camera together until the top edge of the frame is at or below YMAX
function guard(target, pos) {
  const off = pos.clone().sub(target), dist = off.length(), polar = Math.acos(off.y / dist);
  const elevTop = polar - Math.PI / 2 + THREE.MathUtils.degToRad(VFOV) / 2;
  const topY = pos.y + dist * Math.sin(polar) * Math.tan(elevTop);
  if (topY > YMAX) { target.y -= topY - YMAX; pos.y -= topY - YMAX; }
}

function frameShot(instant = false) {
  const sh = SHOTS[state.shot], s = state.focus;
  rig.center(s, sh.u, view.target);
  const az = s === 0 ? sh.az : -sh.az;
  const d = fitDistance(sh);
  view.pos.set(Math.sin(sh.polar) * Math.sin(az), Math.cos(sh.polar), Math.sin(sh.polar) * Math.cos(az)).multiplyScalar(d).add(view.target);
  guard(view.target, view.pos);
  controls.maxDistance = fitDistance(SHOTS[0]) * 1.1;
  view.moving = true;
  if (instant) arrive();
}
function arrive() {
  controls.target.copy(view.target);
  camera.position.copy(view.pos);
  view.moving = false;
}

// only the leg in view is drawn, picked and kept up to date: its skin, and its stocking from just
// above the welt down
function drawRanges() {
  legGeo.setDrawRange(...skinRange[state.focus]);
  rig.geometry.setDrawRange(...rig.indexRange(state.focus, state.top, rig.uEnd[state.focus] + 1));
}

function focusLeg(s) {
  cancelDrag();
  state.focus = s;
  rig.invalidate(s);
  state.dirty = true;
  drawRanges();
  skin.uniforms.uHide.value = 1 - s;
  for (let k = 0; k < 2; k++) setOff(k, state.off[k]);
  const foot = rig.center(s, 0.86);
  shadow.position.set(foot.x, 0.001, foot.z);
  document.querySelectorAll('[data-leg]').forEach(b => b.classList.toggle('on', +b.dataset.leg === s));
  frameShot();
  updateStatus();
  bandRepeat();
}
function setShot(i) {
  state.shot = i;
  document.querySelectorAll('[data-shot]').forEach(b => b.classList.toggle('on', +b.dataset.shot === i));
  frameShot();
}

// ---------- controls ----------
const COLOR_NAMES = Object.fromEntries([...document.querySelectorAll('[data-color]')].map(b => [b.dataset.color, b.title]));
const denierLabel = d => d < 20 ? '超薄透' : d < 40 ? '薄透' : d < 70 ? '半透' : d < 120 ? '微透' : '不透';
const glossLabel = g => g < 0.15 ? '哑光' : g < 0.55 ? '柔光' : '亮面';
const lengthLabel = t => t < 0.33 ? '大腿袜' : t < 0.45 ? '过膝袜' : '及膝袜';
const tightLabel = t => t < 0.3 ? '松' : t < 0.7 ? '适中' : t < 0.95 ? '紧' : '最紧';
const bounceLabel = b => b < 0.05 ? '不弹' : b < 0.35 ? '轻微' : b < 0.7 ? '有弹性' : '很弹';
const ranges = {
  denier: d => `${d}D · ${denierLabel(d)}`,
  gloss: glossLabel,
  top: lengthLabel,
  tight: tightLabel,
  bounce: bounceLabel,
  customAround: n => `${n} 次`,
  gradPos: p => p < 0.3 ? '靠上' : p < 0.7 ? '中间' : '靠下',
};
for (const [id, fmt] of Object.entries(ranges)) {
  const el = $(id), out = $(id + '-v');
  el.addEventListener('input', () => { state[id] = +el.value; out.textContent = fmt(+el.value); apply(); });
  out.textContent = fmt(+el.value);
}
function setRange(id, v) { $(id).value = v; $(id).dispatchEvent(new Event('input')); }

function setColor(hex) {
  state.color = hex;
  stock.uniforms.uColor.value.set(hex);
  $('color').value = hex;
  document.querySelectorAll('[data-color]').forEach(x => x.classList.toggle('on', x.dataset.color === hex));
  state.dirty = true;
  refreshInfo();
}
document.querySelectorAll('[data-color]').forEach(b => b.addEventListener('click', () => setColor(b.dataset.color)));
$('color').addEventListener('input', e => setColor(e.target.value));

const SEGS = { band: 'uBand', outline: null, grad: 'uGrad', flip: 'uGradFlip', strap: 'uStrap', knee: 'uKneeLines', shine: 'uShine' };
const BOTH = new Set(['uKneeLines', 'uShine']);   // on the skin as well as the stocking
function setSeg(name, v) {
  state[name] = v;
  if (SEGS[name]) { stock.uniforms[SEGS[name]].value = v; if (BOTH.has(SEGS[name])) skin.uniforms[SEGS[name]].value = v; }
  else setOutline(v);
  state.dirty = true;
  document.querySelectorAll(`[data-${name}]`).forEach(x => x.classList.toggle('on', +x.dataset[name] === v));
  if (name === 'grad') { $('grad-opts').hidden = !v; $('grad-color-row').hidden = v !== 1; }
  if (name === 'strap') $('strap-opts').hidden = !v;
  if (name === 'strap' || name === 'band') strapSpan();
  refreshInfo();
}
const GRAD_NAMES = Object.fromEntries([...document.querySelectorAll('[data-gcolor]')].map(b => [b.dataset.gcolor, b.title]));
function setGradColor(hex) {
  state.gradColor = hex;
  stock.uniforms.uGradColor.value.set(hex);
  $('gcolor').value = hex;
  document.querySelectorAll('[data-gcolor]').forEach(x => x.classList.toggle('on', x.dataset.gcolor === hex));
  state.dirty = true;
  refreshInfo();
}
document.querySelectorAll('[data-gcolor]').forEach(b => b.addEventListener('click', () => setGradColor(b.dataset.gcolor)));
const STRAP_NAMES = ['', '脚踝', '小腿', '整条'];
function setStrapColor(hex) {
  state.strapColor = hex;
  stock.uniforms.uStrapColor.value.set(hex);
  $('scolor').value = hex;
  document.querySelectorAll('[data-scolor]').forEach(x => x.classList.toggle('on', x.dataset.scolor === hex));
  state.dirty = true;
}
document.querySelectorAll('[data-scolor]').forEach(b => b.addEventListener('click', () => setStrapColor(b.dataset.scolor)));
$('scolor').addEventListener('input', e => setStrapColor(e.target.value));
// where the straps run (u): always ending just above the ankle; starting above it, below the knee, or
// under the welt, and never on the welt itself
function strapSpan() {
  const knee = (info.l.knee + info.r.knee) / 2, ankle = (info.l.ankle + info.r.ankle) / 2;
  const below = state.top + (state.band ? 0.075 : 0.02);
  const from = [0, ankle - 0.13, knee + 0.05, below][state.strap] || below;
  stock.uniforms.uStrapSpan.value.set(Math.min(Math.max(from, below), ankle - 0.05), ankle - 0.012);
}
$('gcolor').addEventListener('input', e => setGradColor(e.target.value));
for (const name of Object.keys(SEGS))
  document.querySelectorAll(`[data-${name}]`).forEach(b => b.addEventListener('click', () => setSeg(name, +b.dataset[name])));

// ---------- patterns: the three drawn by the shader, then the generated masks ----------
const BUILTIN = [{ id: '0', name: '素面' }, { id: '1', name: '网袜' }, { id: '2', name: '条纹' }];
const PATTERNS = Object.fromEntries(patterns.map(p => [p.id, p]));
const texLoader = new THREE.TextureLoader(), textures = {};
// buttons and swatches use 128 px copies (tools/make_thumbs.py); the full mask loads when a pattern is picked
const thumb = p => p.file.replace('patterns/', 'patterns/thumbs/');
function patternTexture(p) {
  if (!textures[p.id]) {
    const t = textures[p.id] = texLoader.load(p.file, () => { state.dirty = true; });
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }
  return textures[p.id];
}
// key: '0' plain, '1' fishnet, '2' stripes, or a generated pattern's id
function setPattern(key) {
  const p = PATTERNS[key];
  state.pattern = p ? 3 : +key;
  state.patternId = p ? key : null;
  const u = stock.uniforms;
  u.uPattern.value = state.pattern;
  if (p) { u.uPatTex.value = patternTexture(p); u.uPatAround.value = p.custom ? state.customAround : p.around; u.uPatBase.value = p.base; }
  u.uPatRGB.value = p && p.custom && custom.pattern.mode === 'color' ? 1 : 0;
  document.querySelectorAll('#patterns button').forEach(b => b.classList.toggle('on', b.dataset.key === key));
  state.dirty = true;
  refreshInfo();
}
for (const p of [...BUILTIN, ...patterns]) {
  const b = document.createElement('button');
  b.dataset.key = p.id;
  b.title = p.name;
  b.innerHTML = `<i${PATTERNS[p.id] ? ` class="pat" style="--m:url(${thumb(p)})"` : ''}></i>${p.name}`;
  b.onclick = () => setPattern(p.id);
  $('patterns').appendChild(b);
}
document.querySelectorAll('[data-leg]').forEach(b => b.addEventListener('click', () => focusLeg(+b.dataset.leg)));
document.querySelectorAll('[data-shot]').forEach(b => b.addEventListener('click', () => setShot(+b.dataset.shot)));
$('put-on').onclick = () => putOn(state.focus);

// ---------- custom images (js/custom.js): pattern, welt, straps, stage background ----------
// Read and kept only in this browser. Each slot: { blob, mode: 'mask' | 'color', name, tex, aspect, preview }
const custom = { pattern: null, band: null, strap: null, bg: null };
const rowOf = slot => document.querySelector(`.custom-row[data-slot="${slot}"]`);
// the custom welt image repeats a whole number of times round the leg, each tile 6 cm high
function bandRepeat() {
  if (!custom.band) return;
  const L = rig.legs[state.focus], r = L.meanR[Math.min(L.rows - 2, Math.max(0, Math.round(rig._row(L, state.top))))];
  stock.uniforms.uBandRepeat.value = Math.max(1, Math.round(2 * Math.PI * r / (0.06 * custom.band.aspect)));
  state.dirty = true;
}
function customPatternButton(rec) {
  let b = document.querySelector('#patterns button[data-key="custom"]');
  if (!rec) { if (b) b.remove(); return; }
  if (!b) {
    b = document.createElement('button');
    b.dataset.key = 'custom';
    b.title = b.textContent = '自定义';
    b.onclick = () => setPattern('custom');
    $('patterns').appendChild(b);
  }
  // shape only: drawn like the generated patterns, in the stocking's colour; colour: the image itself
  b.innerHTML = rec.mode === 'color' ? `<i data-img="1" style="background:url(${rec.preview}) center / cover"></i>自定义`
    : `<i class="pat" style="--m:url(${rec.preview})"></i>自定义`;
}
async function applySlot(slot, rec, use) {
  const old = custom[slot], u = stock.uniforms, row = rowOf(slot);
  if (old) { old.tex && old.tex.dispose(); URL.revokeObjectURL(old.preview); }
  custom[slot] = null;
  if (rec) {
    if (slot === 'bg') rec = { ...rec, preview: URL.createObjectURL(rec.blob) };
    else { const t = await makeTexture(rec.blob, rec.mode, renderer); rec = { ...rec, tex: t.texture, aspect: t.aspect, preview: t.preview }; }
    custom[slot] = rec;
  }
  if (slot === 'pattern') {
    if (rec) { PATTERNS.custom = { id: 'custom', name: '自定义花纹', file: rec.preview, around: state.customAround, base: 1, custom: true }; textures.custom = rec.tex; }
    else { delete PATTERNS.custom; delete textures.custom; }
    customPatternButton(rec);
    if (rec && (use || state.patternId === 'custom')) setPattern('custom');
    else if (!rec && state.patternId === 'custom') setPattern('0');
  } else if (slot === 'band') {
    u.uBandTex.value = rec ? rec.tex : null;
    u.uBandRGB.value = rec && rec.mode === 'color' ? 1 : 0;
    document.querySelector('[data-band="3"]').hidden = !rec;
    bandRepeat();
    if (rec && use) setSeg('band', 3);
    else if (!rec && state.band === 3) setSeg('band', 2);
  } else if (slot === 'strap') {
    u.uStrapTex.value = rec ? rec.tex : null;
    u.uStrapTexMode.value = rec ? (rec.mode === 'color' ? 2 : 1) : 0;
    u.uStrapAspect.value = rec ? rec.aspect : 1;
    if (rec && use && !state.strap) setSeg('strap', 2);
  } else if (slot === 'bg') {
    const st = $('stage').style;
    st.backgroundImage = rec ? `url(${rec.preview})` : '';
    st.backgroundSize = rec ? 'cover' : '';
    st.backgroundPosition = rec ? 'center' : '';
  }
  // the row: thumbnail, clear button, chosen mode
  row.querySelector('.cthumb').style.backgroundImage = rec ? `url(${rec.preview})` : '';
  row.querySelector('.cthumb').style.backgroundColor = rec && rec.mode === 'mask' ? '#3b3344' : '';   // white shape: show it on dark
  row.querySelector('.clear').hidden = !rec;
  if (rec) row.querySelectorAll('[data-cmode]').forEach(x => x.classList.toggle('on', x.dataset.cmode === rec.mode));
  state.dirty = true;
  refreshInfo();
}
for (const slot of Object.keys(custom)) {
  const row = rowOf(slot), input = row.querySelector('input[type=file]');
  const modeNow = () => (row.querySelector('[data-cmode].on') || {}).dataset?.cmode || 'mask';
  row.querySelector('.pick').onclick = () => input.click();
  input.onchange = async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const rec = { blob: await scaleFile(file), mode: modeNow(), name: file.name };
      await applySlot(slot, rec, true);
      saveSlot(slot, { blob: rec.blob, mode: rec.mode, name: rec.name });
    } catch (e) { alert('这张图片读不出来，换一张试试'); }
  };
  row.querySelector('.clear').onclick = () => { applySlot(slot, null); saveSlot(slot, null); };
  row.querySelectorAll('[data-cmode]').forEach(b => b.onclick = () => {
    row.querySelectorAll('[data-cmode]').forEach(x => x.classList.toggle('on', x === b));
    const cur = custom[slot];
    if (!cur || cur.mode === b.dataset.cmode) return;
    const rec = { blob: cur.blob, mode: b.dataset.cmode, name: cur.name };
    applySlot(slot, rec, false);
    saveSlot(slot, rec);
  });
}
// images kept from an earlier visit: available again (the background shows straight away)
loadSlots().then(recs => { for (const [slot, rec] of Object.entries(recs)) if (rec && slot in custom) applySlot(slot, rec, slot === 'bg'); });

// ---------- sound: starts with the first click or touch (browsers require one) ----------
const sfx = new Sfx();
for (const type of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(type, () => sfx.unlock(), { capture: true });
const soundBtn = $('sound');
const showSound = () => { soundBtn.classList.toggle('off', !sfx.on); soundBtn.title = sfx.on ? '关闭音效' : '打开音效'; };
const volEl = $('vol'), volOut = $('vol-v');
const showVol = () => { volEl.value = sfx.vol; volOut.textContent = sfx.vol ? `${Math.round(sfx.vol * 100)}%` : '静音'; };
soundBtn.onclick = () => { sfx.setOn(!sfx.on); showSound(); };
// moving the volume slider also turns sound on; letting go plays one snap to hear the level
volEl.addEventListener('input', () => {
  sfx.setVolume(+volEl.value);
  if (!sfx.on && sfx.vol > 0) { sfx.setOn(true); showSound(); }
  showVol();
});
volEl.addEventListener('change', () => sfx.snap(0.8));
showSound();
showVol();

// ---------- ?perf: how much of the stocking each frame recomputes, and how long it takes ----------
const perf = new URLSearchParams(location.search).has('perf') ? perfMeter($('perf')) : null;

// 2: inverted-hull outline meshes; 1: no extra meshes, the shaders darken the silhouette; 0: neither
function setOutline(mode) {
  skinLine.visible = stockingLine.visible = mode === 2;
  skin.uniforms.uEdge.value = stock.uniforms.uEdge.value = mode === 1 ? 1 : 0;
}

let prevTop = state.top;
function apply() {
  rig.tight = state.tight;
  const u = stock.uniforms;
  u.uDenier.value = state.denier;
  u.uGloss.value = state.gloss;
  u.uTop.value = state.top;
  if (state.patternId === 'custom') u.uPatAround.value = state.customAround;
  bandRepeat();
  // the gradient's middle sits between the welt and the toes; it fades over 40% of that length
  const toe = (rig.uEnd[0] + rig.uEnd[1]) / 2;
  u.uGradMid.value = state.top + state.gradPos * (toe - state.top);
  u.uGradW.value = 0.4 * (toe - state.top);
  strapSpan();
  // a stocking that is still on moves with the length slider; a half-removed one keeps its welt
  for (let s = 0; s < 2; s++) {
    if (state.off[s] || state.anim[s]) continue;
    const R = rig.ring[s];
    if (rig.isWorn(s, prevTop)) R.line.fill(state.top);
    else for (let k = 0; k < R.line.length; k++) R.line[k] = Math.max(R.line[k], state.top);
  }
  prevTop = state.top;
  drawRanges();
  state.dirty = true;
  refreshInfo();
  updateStatus();
}

// ---------- info column: spec card, denier strip, presets ----------
const SKIN = '#ffe1d0';
const STRIP = [10, 20, 30, 50, 80, 120];
const PRESETS = [
  { name: '经典黑丝', color: '#1b1b22', denier: 20, gloss: 0.35, pattern: 0, band: 2, top: 0.3 },
  { name: '肉色薄丝', color: '#d9b49a', denier: 12, gloss: 0.5, pattern: 0, band: 1, top: 0.3 },
  { name: '白色过膝', color: '#f2efea', denier: 80, gloss: 0.1, pattern: 0, band: 1, top: 0.4 },
  { name: '酒红网袜', color: '#6e1f2e', denier: 40, gloss: 0.2, pattern: 1, band: 2, top: 0.3 },
  { name: '藏青条纹', color: '#24325e', denier: 100, gloss: 0.1, pattern: 2, band: 1, top: 0.5 },
  { name: '灰色哑光', color: '#7d7f88', denier: 60, gloss: 0, pattern: 0, band: 0, top: 0.34 },
  { name: '玫瑰蕾丝', color: '#1b1b22', denier: 15, gloss: 0.3, pattern: 'rose_lace', band: 2, top: 0.3 },
  { name: '焦糖豹纹', color: '#4a2c1c', denier: 25, gloss: 0.3, pattern: 'leopard', band: 1, top: 0.3 },
  { name: '黑红渐变', color: '#1b1b22', denier: 40, gloss: 0.3, pattern: 0, band: 1, top: 0.3, grad: 1, gradColor: '#6e1f2e', gradPos: 0.55 },
  { name: '渐变透肤', color: '#1b1b22', denier: 90, gloss: 0.25, pattern: 0, band: 2, top: 0.3, grad: 2, gradPos: 0.45 },
  { name: '白丝黑绑带', color: '#f2efea', denier: 30, gloss: 0.3, pattern: 0, band: 1, top: 0.4, strap: 2, strapColor: '#15151a' },
  { name: '黑丝酒红绑带', color: '#1b1b22', denier: 20, gloss: 0.35, pattern: 0, band: 2, top: 0.3, strap: 3, strapColor: '#7a1f33' },
].filter(p => typeof p.pattern === 'number' || PATTERNS[p.pattern]);
const coverage = d => 1 - Math.exp(-d / 55);
const mixHex = (a, b, t) => '#' + [0, 2, 4].map(i => Math.round(parseInt(a.substr(1 + i, 2), 16) * (1 - t) + parseInt(b.substr(1 + i, 2), 16) * t).toString(16).padStart(2, '0')).join('');
// a little leg-shaped swatch: sheer in the middle, darker towards the edges, like the shader
const swatch = (color, d, pattern = 0) => {
  if (pattern === 1) return `repeating-linear-gradient(45deg, ${color} 0 1.5px, transparent 1.5px 6px), repeating-linear-gradient(-45deg, ${color} 0 1.5px, ${SKIN} 1.5px 6px)`;
  if (pattern === 2) return `repeating-linear-gradient(180deg, ${color} 0 6px, #f4f1ec 6px 12px)`;
  const a0 = coverage(d), edge = 1 - Math.pow(1 - a0, 1 / Math.pow(0.3, 0.7));
  const c = mixHex(SKIN, color, a0), e = mixHex(SKIN, color, edge);
  return `linear-gradient(90deg, ${e}, ${c} 35%, ${c} 65%, ${e})`;
};
const strip = $('denier-strip');
for (const d of STRIP) {
  const b = document.createElement('button');
  b.dataset.d = d;
  b.innerHTML = `<i></i>${d}D`;
  b.onclick = () => setRange('denier', d);
  strip.appendChild(b);
}
for (const p of PRESETS) {
  const b = document.createElement('button'), gen = PATTERNS[p.pattern];
  const flat = (c, d) => mixHex(SKIN, c, coverage(d));
  const look = gen ? ` class="pat" style="--c:${p.color};--m:url(${thumb(gen)});background:${swatch(p.color, p.denier * gen.base)}"`
    : p.strap ? ` style="background:repeating-linear-gradient(30deg, transparent 0 7px, ${p.strapColor} 7px 9px), repeating-linear-gradient(-30deg, transparent 0 7px, ${p.strapColor} 7px 9px), ${swatch(p.color, p.denier)}"`
    : p.grad === 1 ? ` style="background:linear-gradient(180deg, ${flat(p.color, p.denier)} 30%, ${flat(p.gradColor, p.denier)} 75%)"`
    : p.grad === 2 ? ` style="background:linear-gradient(180deg, ${flat(p.color, p.denier)} 25%, ${flat(p.color, p.denier * 0.18)} 70%)"`
    : ` style="background:${swatch(p.color, p.denier, p.pattern)}"`;
  b.innerHTML = `<i${look}></i><span>${p.name}</span>`;
  b.onclick = () => {
    setColor(p.color); setPattern(String(p.pattern)); setSeg('band', p.band);
    setSeg('grad', p.grad || 0); setSeg('flip', 0); setRange('gradPos', p.gradPos ?? 0.5);
    if (p.gradColor) setGradColor(p.gradColor);
    setSeg('strap', p.strap || 0);
    if (p.strapColor) setStrapColor(p.strapColor);
    setRange('denier', p.denier); setRange('gloss', p.gloss); setRange('top', p.top);
  };
  $('presets').appendChild(b);
}
function refreshInfo() {
  const name = COLOR_NAMES[state.color] || '自定义色';
  const gen = PATTERNS[state.patternId];
  const kind = state.pattern === 1 ? '网眼' : state.pattern === 2 ? '条纹' : gen ? gen.name : '';
  const band = state.band === 2 ? '蕾丝边' : state.band === 3 ? '自定义袜口' : '';
  const grad = state.grad === 1 ? `→${GRAD_NAMES[state.gradColor] || '自定义色'}渐变` : state.grad === 2 ? '渐变透' : '';
  const strap = state.strap ? `${STRAP_NAMES[state.strap]}绑带` : '';
  $('spec-name').textContent = `${state.denier}D ${name}${grad}${band}${kind}${strap}${lengthLabel(state.top)}`;
  $('spec-denier').textContent = `${state.denier}D · ${denierLabel(state.denier)}`;
  const sheer = state.pattern === 1 ? 85 : Math.round((1 - coverage(state.denier * (gen ? gen.base : 1))) * (gen ? 75 : 100));
  $('spec-sheer').textContent = `${sheer}%`;
  $('spec-sheer-bar').style.width = `${sheer}%`;
  $('spec-gloss').textContent = glossLabel(state.gloss);
  $('spec-length').textContent = lengthLabel(state.top);
  strip.querySelectorAll('button').forEach(b => {
    b.querySelector('i').style.background = swatch(state.color, +b.dataset.d);
    b.classList.toggle('on', +b.dataset.d === state.denier);
  });
  document.querySelectorAll('#patterns i').forEach((el, i) => {
    if (el.dataset.img) return;                     // a custom colour image shows itself
    const p = PATTERNS[el.parentNode.dataset.key];
    el.style.setProperty('--c', state.color);
    el.style.background = p ? swatch(state.color, state.denier * p.base) : swatch(state.color, state.denier, i);
  });
}

// ---------- taking off and putting on ----------
function setOff(s, off) {
  state.off[s] = off;
  stock.uniforms.uOff.value.setComponent(s, off || s !== state.focus ? 1 : 0);   // hidden leg: no stocking either
}

// putting it back on: rolled up at the toes, then unrolled up the leg
function putOn(s) {
  cancelDrag();
  hook = null;
  if (state.off[s]) { setOff(s, false); rig.resetRing(s, rig.uEnd[s], 0.8); }
  const from = Math.max(...rig.ring[s].line);
  state.anim[s] = { from: Math.min(from, rig.uEnd[s]), t0: performance.now(), dur: 600 + 1600 * (from - state.top) };
  rig.ring[s].curl.fill(0.8);
  sfx.putOn(state.anim[s].dur / 1000);
}

function updateStatus() {
  const s = state.focus, name = s === 0 ? '左腿' : '右腿';
  const k = state.off[s] ? 1 : rig.progress(s, state.top);
  const txt = state.off[s] ? `${name}：已脱下` : k < 0.005 ? `${name}：穿着` : `${name}：已褪下 ${Math.round(k * 100)}%`;
  $('status').textContent = txt;
  $('progress-title').textContent = txt;
  $('ring').style.setProperty('--p', Math.round(k * 100));
  $('ring-v').textContent = `${Math.round(k * 100)}%`;
  $('put-on').disabled = !state.off[s] && rig.isWorn(s, state.top);
}

// ---------- a finger hooked under the welt ----------
// drag: the finger on the leg. It pushes the welt down the leg and, once it is past the leg's
// outline, pulls the welt away from the leg. The contact is wherever the finger is, so it slides
// round the welt as the finger moves (it is hooked under the welt, not pinching one spot).
// hook: how far the welt is pulled off the leg at the contact; it follows the finger while held and
// springs back onto the leg when let go.
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const grip = $('grip');
let drag = null, hook = null;

function pointerNdc(e) {
  const rect = canvas.getBoundingClientRect();
  ndc.set((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1);
  return rect;
}

// what the pointer is on: the welt, the fold/roll, or the fabric just below it
function pick(e) {
  pointerNdc(e);
  ray.setFromCamera(ndc, camera);
  const s = state.focus;
  if (state.off[s] || state.anim[s]) return null;
  const fab = rig.geometry.attributes.aFab, side = rig.geometry.attributes.aSide, rolled = rig.geometry.attributes.aRolled;
  // only the stretch that can be grabbed: from the welt to a little below the lowest fold line
  const range = rig.geometry.drawRange, shown = [range.start, range.count];
  const lowest = Math.min(Math.max(...rig.ring[s].line), rig.uEnd[s]);
  [range.start, range.count] = rig.indexRange(s, state.top, lowest + 0.08);
  const hits = ray.intersectObjects([stocking, legs], false);
  [range.start, range.count] = shown;
  for (const h of hits) {
    if (h.object === legs) {
      if ((h.point.x > 0 ? 0 : 1) !== s) continue;    // the hidden leg
      return null;                                     // bare skin in front: nothing to grab
    }
    const i = h.face.a, u = fab.getX(i);
    if (side.getX(i) !== s) continue;
    if (u < state.top - 0.002) continue;               // cut-away fabric above the welt
    const th = Math.atan2(fab.getZ(i), fab.getY(i));
    const line = Math.min(rig.ringAt(s, th)[0], rig.uEnd[s]);
    const ok = rolled.getX(i) > 0 || u < state.top + 0.08 || u < line + 0.06;
    return ok ? { s, th, point: h.point } : null;
  }
  return null;
}

// where the finger is: just off the skin under the pointer, or, off the leg, on a camera-facing
// plane through the leg's axis at the welt
const plane = new THREE.Plane(), camDir = new THREE.Vector3(), tmp = new THREE.Vector3();
function fingerPoint(e, s, u) {
  pointerNdc(e);
  ray.setFromCamera(ndc, camera);
  for (const h of ray.intersectObject(legs, false)) {
    if ((h.point.x > 0 ? 0 : 1) !== s) continue;
    return h.point.clone().addScaledVector(h.face.normal, 0.004);
  }
  camera.getWorldDirection(camDir);
  plane.setFromNormalAndCoplanarPoint(camDir, rig.center(s, Math.min(u, rig.uEnd[s]), tmp));
  return ray.ray.intersectPlane(plane, new THREE.Vector3());
}

canvas.addEventListener('pointerdown', e => {
  if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;   // one finger at a time, left button
  const h = pick(e);
  if (!h) return;
  const hand = Math.min(rig.ringAt(h.s, h.th)[0], rig.uEnd[h.s]);      // the fold line at the finger
  const F = h.point.clone();
  drag = { s: h.s, id: e.pointerId, hand, target: hand, th: h.th, F, offset: hand - rig.nearestU(h.s, F, hand) };
  hook = { s: h.s, th: h.th, u: hand, m: 0, vel: 0, held: true };
  sfx.grab();
  controls.enabled = false;
  canvas.setPointerCapture(e.pointerId);
  document.body.classList.add('grabbing');
});
canvas.addEventListener('pointermove', e => {
  if (drag && e.pointerId === drag.id) {
    const F = fingerPoint(e, drag.s, drag.hand);
    if (F) {
      drag.F = F;
      drag.target = Math.max(state.top, rig.nearestU(drag.s, F, drag.hand) + drag.offset);
    }
    return;
  }
  if (e.pointerType === 'mouse' && !drag) document.body.classList.toggle('grab', !!pick(e));
});
const endDrag = e => {
  if (drag && e.pointerId === drag.id) cancelDrag();
};
// let go of the stocking, whatever the reason (finger up, leg switched, put back on, taken off):
// the welt springs back and the camera works again
function cancelDrag() {
  if (!drag) return;
  if (canvas.hasPointerCapture(drag.id)) canvas.releasePointerCapture(drag.id);
  drag = null;
  if (hook) { hook.held = false; hook.vel = 0; }
  controls.enabled = true;
  document.body.classList.remove('grabbing');
  state.dirty = true;
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// what the sound follows: how fast the fabric moves (m/s), how far the welt is pulled off the leg
// (0..1) and how fast that changes (1/s)
const motion = { speed: 0, tension: 0, rate: 0 };

function stepFinger(thick, dt) {
  motion.speed = motion.tension = motion.rate = 0;
  if (!drag) return;
  const s = drag.s, th0 = drag.th, m0 = hook.m;
  // the contact is the welt point in the finger's direction; how far the finger is past the leg there
  const loc = rig.toLocal(s, drag.hand, drag.F);
  drag.th = Math.atan2(loc.y, loc.x);
  const R = rig.sectionRadius(s, drag.hand, drag.th) + thick, out = Math.hypot(loc.x, loc.y) - R;
  hook.th = drag.th;
  hook.u = drag.hand;
  hook.m += (Math.min(0.15, Math.max(0, out)) - hook.m) * 0.35;
  // and along the leg, with a little lag and a top speed, so taking it off is gradual
  const step = Math.max(-0.01, Math.min(0.01, (drag.target - drag.hand) * 0.3));
  // the welt rubbing along the leg, the finger sliding round it, the fabric lifting off
  const slide = Math.abs(Math.atan2(Math.sin(drag.th - th0), Math.cos(drag.th - th0))) * R;
  motion.speed = (Math.abs(step) + slide * 0.5 + Math.abs(hook.m - m0) * 0.5) / dt;
  motion.tension = Math.min(1, hook.m / 0.08);
  motion.rate = (hook.m - m0) / 0.08 / dt;
  if (Math.abs(step) > 1e-5) {
    drag.hand += step;
    rig.pull(s, drag.th, drag.hand, state.top);
    if (rig.isOff(s)) {
      setOff(s, true);
      cancelDrag();
      hook = null;
      sfx.off();
    }
    updateStatus();
  }
  state.dirty = true;
}

function stepHook(dt) {
  if (!hook || hook.held) return;
  // a spring back onto the leg; the leg stops it and it bounces off with restitution 0.45 * state.bounce
  // (default 0.09: real fabric settles on the skin almost at once; it used to be a fixed 0.35, which
  // bounced two or three times)
  hook.vel += (-260 * hook.m - 9 * hook.vel) * dt;
  hook.m += hook.vel * dt;
  if (hook.m < 0) {
    sfx.snap(-hook.vel / 1.2);
    hook.m = 0;
    hook.vel = -hook.vel * 0.45 * state.bounce;
  }
  if (hook.m < 2e-4 && Math.abs(hook.vel) < 0.02) hook = null;
  state.dirty = true;
}

function hookArg(thick) {
  if (!hook || hook.m < 1e-4 || hook.u >= rig.uEnd[hook.s]) return null;
  const r = rig.sectionRadius(hook.s, hook.u, hook.th) + thick + hook.m;
  return { s: hook.s, u: hook.u, F2: [r * Math.cos(hook.th), r * Math.sin(hook.th)] };
}

// ---------- loop ----------
let lastW = 0, lastH = 0;
function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w === lastW && h === lastH) return false;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  outlines.forEach(m => m.uniforms.uRes.value.set(w, h));
  lastW = w; lastH = h;
  if (!drag) frameShot(true);
  return true;
}

let lastThick = -1, lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.033, (now - lastT) / 1000);
  lastT = now;
  const resized = resize();
  if (view.moving) {
    controls.target.lerp(view.target, 0.12);
    camera.position.lerp(view.pos, 0.12);
    if (camera.position.distanceTo(view.pos) < 0.002) arrive();
  }
  for (let s = 0; s < 2; s++) {
    const a = state.anim[s];
    if (!a) continue;
    const k = Math.min(1, (now - a.t0) / a.dur), e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    rig.ring[s].line.fill(a.from + (state.top - a.from) * e);
    if (k >= 1) { state.anim[s] = null; rig.resetRing(s, state.top); }
    state.dirty = true;
    updateStatus();
  }
  const thick = 0.0013 + state.denier / 200 * 0.0012;
  stepFinger(thick, Math.max(dt, 0.004));
  stepHook(dt);
  sfx.update(motion.speed, motion.tension, motion.rate);
  // draw only when something changed: the stocking, the camera, a setting (all set state.dirty)
  let redraw = state.dirty || thick !== lastThick || view.moving || resized;
  if (state.dirty || thick !== lastThick) {
    // the skin outline stops where the stocking covers the skin at each angle, except under a fishnet
    // or open lace (all holes, and the stocking itself has no outline there)
    const s = state.focus, open = state.pattern === 1 || (state.pattern === 3 && PATTERNS[state.patternId].base < 0.5);
    const cover = outlines[0].uniforms.uRing.value, line = rig.ring[s].line;
    for (let k = 0; k < cover.length; k++) cover[k] = state.off[s] || open ? 10 : Math.min(line[k], rig.uEnd[s]);
    rig.update(s, state.top, thick, hookArg(thick), camera);
    if (perf) perf.add(rig.stats);
    state.dirty = false;
    lastThick = thick;
  }
  if (drag) {
    rig.surfacePoint(drag.s, Math.min(drag.hand, rig.uEnd[drag.s] + 0.05), drag.th, thick + (hook ? hook.m : 0) + 0.004, tmp).project(camera);
    grip.style.transform = `translate(${(tmp.x + 1) / 2 * canvas.clientWidth}px, ${(1 - tmp.y) / 2 * canvas.clientHeight}px)`;
  }
  if (controls.update()) redraw = true;          // true while the camera moves (dragging, damping)
  if (!view.moving) guard(controls.target, camera.position);
  if (redraw) renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
resize();
// every material setting from state, so the first frame shows what the panel says
setColor(state.color);
setSeg('band', state.band);
setSeg('outline', state.outline);
setPattern('0');
apply();
focusLeg(0);
arrive();
refreshInfo();
requestAnimationFrame(frame);
document.body.classList.add('ready');
window.__dl = { state, rig, camera, controls, renderer, scene, sfx, skin, stock, skinLine, stockingLine, setOff, focusLeg, setShot, putOn, get drag() { return drag; }, get hook() { return hook; } };

// skin triangles in the order left leg, across the middle, right leg, so either leg is one draw range
function splitLegs(geo) {
  const idx = geo.index.array, x = geo.attributes.position.array, groups = [[], [], []];
  for (let t = 0; t < idx.length; t += 3) {
    let left = 0;
    for (let i = 0; i < 3; i++) if (x[idx[t + i] * 3] > 0) left++;
    groups[left === 3 ? 0 : left === 0 ? 2 : 1].push(idx[t], idx[t + 1], idx[t + 2]);
  }
  const sorted = new idx.constructor(idx.length);
  sorted.set(groups[0]); sorted.set(groups[1], groups[0].length); sorted.set(groups[2], groups[0].length + groups[1].length);
  geo.setIndex(new THREE.BufferAttribute(sorted, 1));
  const [a, b, c] = groups.map(g => g.length);
  return [[0, a + b], [a, b + c]];
}

function groundShadow() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d'), gr = x.createRadialGradient(64, 64, 4, 64, 64, 62);
  gr.addColorStop(0, 'rgba(40,30,60,0.35)');
  gr.addColorStop(1, 'rgba(40,30,60,0)');
  x.fillStyle = gr;
  x.fillRect(0, 0, 128, 128);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.42), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  return m;
}

function perfMeter(el) {
  el.hidden = false;
  let n = 0, ms = 0, verts = 0, coarse = 0, rows = 0, t0 = performance.now();
  return {
    add(st) {
      n++; ms += st.ms; verts += st.verts; coarse += st.coarse; rows += st.rows;
      const now = performance.now();
      if (now - t0 < 500) return;
      const k = 1 / n, total = rig.u.length;
      el.textContent = `形变 ${(ms * k).toFixed(2)} ms/帧 · ${rows * k | 0} 圈\n精算 ${verts * k | 0} 点 · 插值 ${coarse * k | 0} 点 · 全部 ${total}`;
      n = ms = verts = coarse = rows = 0;
      t0 = now;
    },
  };
}
