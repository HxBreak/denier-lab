// Custom images for the stocking pattern, the welt, the straps and the stage background.
// Picked from this device and never uploaded: the image is read in the browser, scaled to at most
// 1024 px and kept in this browser's IndexedDB, so it is still there after a reload.
// Two ways to use an image (not for the background):
//   mask   only its shape: where the motif is, in the stocking's (or strap's) own colour. The motif is
//          the image's transparency if it has any, otherwise whichever of light and dark is the minority
//          (a dark motif on a light ground, or a light one on dark); invert swaps motif and ground
//   color  the image's own colours
import * as THREE from 'three';

const DB = 'denier-lab', STORE = 'custom', MAX = 1024;

function openDb() {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
function run(mode, fn) {
  return openDb().then(db => new Promise((ok, fail) => {
    const tx = db.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => ok(req && req.result);
    tx.onerror = () => fail(tx.error);
  }));
}
// rec: { blob (the scaled PNG), mode, invert, name } or null to forget the slot. Storage can be off (private
// windows): then the image simply lasts until the page is closed.
export async function saveSlot(slot, rec) {
  try { await run('readwrite', s => rec ? s.put(rec, slot) : s.delete(slot)); } catch { /* not kept */ }
}
export async function loadSlots() {
  const out = {};
  try {
    const keys = await run('readonly', s => s.getAllKeys());
    for (const k of keys || []) out[k] = await run('readonly', s => s.get(k));
  } catch { /* nothing kept */ }
  return out;
}

// a picked file -> a PNG blob at most 1024 px on its longer side
export async function scaleFile(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  return new Promise(ok => c.toBlob(ok, 'image/png'));
}

// a stored blob -> { texture, aspect (width / height), preview (object URL of what the texture shows) }
export async function makeTexture(blob, mode, renderer, invert = false) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  if (mode === 'mask') {
    const im = g.getImageData(0, 0, c.width, c.height), d = im.data, n = d.length / 4;
    let see = 0, lum = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 250) see++;
      lum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    }
    const useAlpha = see > n * 0.01, darkMotif = lum / n > 127;
    for (let i = 0; i < d.length; i += 4) {
      const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      let a = useAlpha ? d[i + 3] : (darkMotif ? 255 - L : L) * d[i + 3] / 255;
      if (invert) a = 255 - a;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = a;
    }
    g.putImageData(im, 0, 0);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = mode === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const preview = await new Promise(ok => c.toBlob(b => ok(URL.createObjectURL(b)), 'image/png'));
  return { texture: t, aspect: c.width / c.height, preview };
}
