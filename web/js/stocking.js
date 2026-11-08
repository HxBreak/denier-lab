// The stocking and how it moves while it is taken off.
//
// The stocking is a tube built in Blender (see blender/build_legs.py): one ring every few mm along
// each leg's centre line and a dome over the toe tip, `cols` points per ring, each point on the
// outermost skin in its direction (convex hull over the toes, so it wraps them like a sock). Every
// vertex has u (distance along the centre line) and theta (angle round the leg, 0 at the front).
// The vertices are stored ring by ring: leg s, ring r, column k is vertex base[s] + r * cols + k, and
// the last ring is the toe tip, a single vertex. So a stretch of the leg is one block of vertices.
//
// It covers u >= top. Taking it off moves the welt down the leg: the fabric it passes either bunches
// up above the fold line or rolls into a tube (pull()). A finger hooked under the welt can also pull
// it away from the leg (update(), `hook`).
//
// update() only does the leg in view, and only the rings that can be off the skin now or were last
// time; the rest of the stocking lies on the skin and does not change. Where that fabric is out of
// sight (behind the leg, or above or below the frame) it computes every other ring and column and
// fills in the rest from their neighbours.
import * as THREE from 'three';

const K = 48;             // nodes on the welt ring
export const SIDES = 2;   // 0 = left leg (+x), 1 = right leg (-x)
const BACK = -0.35;       // fabric turned further than this from the camera is behind the leg

export class StockingRig {
  constructor(stockGeo, info) {
    const sides = [info.l, info.r];
    this.uEnd = sides.map(x => x.end);
    this.uBall = sides.map(x => x.ball);
    this.uAnkle = sides.map(x => x.ankle);
    this.legs = sides.map(x => {
      const rows = x.rows, cols = x.cols;
      const C = Float64Array.from(x.C.flat()), T = Float64Array.from(x.T.flat()), N = Float64Array.from(x.N.flat());
      const B = new Float64Array(rows * 3);
      for (let r = 0; r < rows; r++) {
        const o = r * 3;
        B[o] = T[o + 1] * N[o + 2] - T[o + 2] * N[o + 1];
        B[o + 1] = T[o + 2] * N[o] - T[o] * N[o + 2];
        B[o + 2] = T[o] * N[o + 1] - T[o + 1] * N[o];
      }
      const us = Float64Array.from(x.u);
      return { us, du: us[1] - us[0], rows, cols, C, T, N, B, R: new Float64Array(rows * cols) };
    });
    this.base = [0];
    for (const L of this.legs) this.base.push(this.base[this.base.length - 1] + (L.rows - 1) * L.cols + 1);

    // weld the vertices glTF split along the theta seam and at the toe tip
    const pos = stockGeo.attributes.position.array, uv = stockGeo.attributes.uv.array;
    const n = stockGeo.attributes.position.count, weld = new Map(), map = new Int32Array(n);
    const P = [], U = [], TH = [], S = [];
    for (let i = 0; i < n; i++) {
      const key = `${pos[i * 3].toFixed(5)},${pos[i * 3 + 1].toFixed(5)},${pos[i * 3 + 2].toFixed(5)}`;
      if (weld.has(key)) { map[i] = weld.get(key); continue; }
      weld.set(key, U.length);
      map[i] = U.length;
      P.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      U.push(uv[i * 2]);
      TH.push((1 - uv[i * 2 + 1]) * Math.PI * 2 - Math.PI);   // glTF stores 1 - v
      S.push(pos[i * 3] > 0 ? 0 : 1);
    }

    // and put them in ring order
    const m = this.base[SIDES];
    if (U.length !== m) throw new Error(`stocking: ${U.length} vertices, expected ${m} (rings x columns + toe tip)`);
    const order = new Int32Array(m), taken = new Uint8Array(m);
    this.tipK = [0, 0];
    for (let j = 0; j < m; j++) {
      const s = S[j], L = this.legs[s], r = Math.round(this._row(L, U[j])), k = column(TH[j], L.cols);
      const tip = r === L.rows - 1, g = this.base[s] + r * L.cols + (tip ? 0 : k);
      if (taken[g]) throw new Error('stocking: two vertices on one ring point');
      if (tip) this.tipK[s] = k;
      taken[g] = 1;
      order[j] = g;
    }
    this.u = new Float32Array(m);
    this.theta = new Float32Array(m);
    this.side = new Uint8Array(m);
    this.basePos = new Float32Array(m * 3);
    for (let j = 0; j < m; j++) {
      const g = order[j];
      this.u[g] = U[j]; this.theta[g] = TH[j]; this.side[g] = S[j];
      this.basePos.set(P.slice(j * 3, j * 3 + 3), g * 3);
    }

    // triangles sorted by their highest ring, so each stretch of the leg is one run of the index
    // (triRow[s][r]: first triangle of leg s that reaches no higher than ring r)
    const tri = [], index = stockGeo.index.array;
    for (let t = 0; t < index.length; t += 3) {
      const a = order[map[index[t]]], b = order[map[index[t + 1]]], c = order[map[index[t + 2]]];
      if (a !== b && b !== c && a !== c) tri.push([Math.min(a, b, c), a, b, c]);
    }
    tri.sort((x, y) => x[0] - y[0]);
    const tris = new Uint32Array(tri.length * 3);
    tri.forEach((t, i) => { tris[i * 3] = t[1]; tris[i * 3 + 1] = t[2]; tris[i * 3 + 2] = t[3]; });
    this.triRow = this.legs.map((L, s) => {
      const rowStart = new Int32Array(L.rows + 1);
      let t = 0;
      for (let r = 0; r <= L.rows; r++) {
        const first = r >= L.rows ? this.base[s + 1] : this.base[s] + r * L.cols;
        while (t < tri.length && tri[t][0] < first) t++;
        rowStart[r] = t;
      }
      return rowStart;
    });

    // ring radii from the tube itself, then circumference and stretch per ring
    const bp = this.basePos;
    this.radial = new Float32Array(m * 3);
    for (const [s, L] of this.legs.entries()) {
      for (let r = 0; r < L.rows; r++) {
        const o = r * 3, tip = r === L.rows - 1;
        for (let k = 0; k < L.cols; k++) {
          const j = this.base[s] + r * L.cols + (tip ? 0 : k);
          const dx = bp[j * 3] - L.C[o], dy = bp[j * 3 + 1] - L.C[o + 1], dz = bp[j * 3 + 2] - L.C[o + 2];
          const along = dx * L.T[o] + dy * L.T[o + 1] + dz * L.T[o + 2];
          const rx = dx - L.T[o] * along, ry = dy - L.T[o + 1] * along, rz = dz - L.T[o + 2] * along;
          const rad = Math.hypot(rx, ry, rz);
          L.R[r * L.cols + k] = rad;
          if (tip && k > 0) continue;
          this.radial.set(rad > 1e-6 ? [rx / rad, ry / rad, rz / rad] : [L.T[o], L.T[o + 1], L.T[o + 2]], j * 3);
        }
      }
      L.meanR = new Float64Array(L.rows);
      L.maxR = new Float64Array(L.rows);
      for (let r = 0; r < L.rows; r++) {
        let sum = 0, max = 0;
        for (let k = 0; k < L.cols; k++) { sum += L.R[r * L.cols + k]; max = Math.max(max, L.R[r * L.cols + k]); }
        L.meanR[r] = sum / L.cols;
        L.maxR[r] = max;
      }
      // stretch: 0 at the thinnest part of the lower leg, 1 at the widest part of the thigh
      let lo = Infinity, hi = 0;
      for (let r = 0; r < L.rows; r++) {
        if (L.us[r] > this.uAnkle[s]) break;
        lo = Math.min(lo, L.meanR[r]); hi = Math.max(hi, L.meanR[r]);
      }
      L.stretch = L.meanR.map(v => Math.min(1, Math.max(0, (v - lo) / (hi - lo))));
    }

    const fab = new Float32Array(m * 4), aSide = new Float32Array(m), aStretch = new Float32Array(m);
    for (let j = 0; j < m; j++) {
      const L = this.legs[this.side[j]], r = Math.round(this._row(L, this.u[j]));
      fab[j * 4] = this.u[j];
      fab[j * 4 + 1] = Math.cos(this.theta[j]);
      fab[j * 4 + 2] = Math.sin(this.theta[j]);
      fab[j * 4 + 3] = L.meanR[Math.min(r, L.rows - 2)];       // mean radius, for arc length
      aSide[j] = this.side[j];
      aStretch[j] = L.stretch[r];
    }
    const geo = new THREE.BufferGeometry();
    const dyn = (arr, size) => new THREE.BufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', dyn(this.basePos.slice(), 3));
    geo.setAttribute('normal', dyn(new Float32Array(m * 3), 3));
    geo.setAttribute('aFab', new THREE.BufferAttribute(fab, 4));
    geo.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1));
    geo.setAttribute('aStretch', new THREE.BufferAttribute(aStretch, 1));
    geo.setAttribute('aRolled', dyn(new Float32Array(m), 1));
    geo.setAttribute('aPull', dyn(new Float32Array(m), 1));
    geo.setIndex(new THREE.BufferAttribute(tris, 1));
    geo.computeVertexNormals();
    // computed once, big enough for anything the stocking does (pulled past the toes, lifted off)
    geo.computeBoundingSphere();
    geo.boundingSphere.radius += 0.6;
    this.geometry = geo;
    this.baseN = geo.attributes.normal.array.slice();

    // which way round the ring-difference normals (_normal) face: the same way as the mesh's own
    this.nSign = this.legs.map((L, s) => {
      const r = L.rows >> 1, k = 7, j = this.base[s] + r * L.cols + k, out = [0, 0, 0];
      this._normal(s, r, k, bp, 1, out);
      return Math.sign(out[0] * this.baseN[j * 3] + out[1] * this.baseN[j * 3 + 1] + out[2] * this.baseN[j * 3 + 2]) || 1;
    });

    this.ring = [0, 1].map(() => ({ line: new Float32Array(K), curl: new Float32Array(K) }));
    this.tight = 0.5;                  // how hard the stocking clings to the leg, see pull()
    this.vstate = new Uint8Array(m);   // per vertex: 0 on the skin, 1 moved, 2 left out (out of sight)
    this.done = [null, null];          // per leg: what the last update() computed
    this.coarse = false;               // the last update() left some out-of-sight fabric coarse
    this.lod = true;                   // leave out-of-sight fabric coarse at all
    this.stats = { rows: 0, verts: 0, coarse: 0, ms: 0 };
    const cols = Math.max(...this.legs.map(L => L.cols));
    this._col = {};      // per-column scratch for update()
    for (const name of ['line', 'curl', 'R0', 'lift', 'cos', 'sin']) this._col[name] = new Float64Array(cols);
    this._col.hid = new Uint8Array(cols);
    for (const name of ['C', 'D', 'T']) this._col[name] = new Float64Array(cols * 3);
    this._frustum = new THREE.Frustum();
    this._sphere = new THREE.Sphere();
    this._mat = new THREE.Matrix4();
  }

  // fractional ring index at u (rings are evenly spaced along the leg, closer together over the toe)
  _row(L, uu) {
    const us = L.us, last = L.rows - 1;
    if (uu <= us[0]) return 0;
    if (uu >= us[last]) return last - 0.0001;
    let r = Math.min(last - 1, Math.floor((uu - us[0]) / L.du));
    if (us[r] > uu) {
      let lo = 0, hi = r;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (us[mid] <= uu) lo = mid; else hi = mid; }
      r = lo;
    } else {
      while (r < last - 1 && us[r + 1] <= uu) r++;
    }
    return r + (uu - us[r]) / (us[r + 1] - us[r]);
  }

  // frame at u for angle th: fills this._F (centre, radial dir, tangent) and returns the skin radius
  _frame(s, uu, th) {
    const L = this.legs[s], f = this._row(L, uu), b = f | 0, t = f - b;
    const F = this._F || (this._F = { C: [0, 0, 0], D: [0, 0, 0], T: [0, 0, 0] });
    const c = Math.cos(th), sn = Math.sin(th), o = b * 3;
    for (let k = 0; k < 3; k++) {
      F.C[k] = lerp(L.C[o + k], L.C[o + 3 + k], t);
      F.T[k] = lerp(L.T[o + k], L.T[o + 3 + k], t);
      F.D[k] = c * lerp(L.N[o + k], L.N[o + 3 + k], t) + sn * lerp(L.B[o + k], L.B[o + 3 + k], t);
    }
    return this._radius(L, b, t, th);
  }

  _radius(L, b, t, th) {
    const sec = (th + Math.PI) / (Math.PI * 2) * L.cols, k0 = ((Math.floor(sec) % L.cols) + L.cols) % L.cols;
    const k1 = (k0 + 1) % L.cols, ks = sec - Math.floor(sec), R = L.R, cols = L.cols;
    const r0 = lerp(R[b * cols + k0], R[b * cols + k1], ks), r1 = lerp(R[(b + 1) * cols + k0], R[(b + 1) * cols + k1], ks);
    return lerp(r0, r1, t);
  }

  sectionRadius(s, uu, th) { const L = this.legs[s], f = this._row(L, uu); return this._radius(L, f | 0, f - (f | 0), th); }

  meanR(s, uu) {
    const L = this.legs[s], f = this._row(L, uu), b = f | 0;
    return lerp(L.meanR[b], L.meanR[b + 1], f - b);
  }

  // centre of the leg at u (continuing straight on past the toes)
  center(s, uu, out = new THREE.Vector3()) {
    this._frame(s, uu, 0);
    const F = this._F, e = Math.max(0, uu - this.uEnd[s]);
    return out.set(F.C[0] + F.T[0] * e, F.C[1] + F.T[1] * e, F.C[2] + F.T[2] * e);
  }

  // a point at (u, th) lifted `extra` off the skin; past the toes it continues ahead and droops
  surfacePoint(s, uu, th, extra, out = new THREE.Vector3()) {
    const e = Math.max(0, uu - this.uEnd[s]);
    const r = this._frame(s, Math.min(uu, this.uEnd[s]), th) + extra;
    const F = this._F;
    out.set(F.C[0] + F.D[0] * r + F.T[0] * e, F.C[1] + F.D[1] * r + F.T[1] * e, F.C[2] + F.D[2] * r + F.T[2] * e);
    if (e > 0) out.y = Math.max(0.004, out.y - 0.9 * e * e);
    return out;
  }

  // P in the frame at u: x along theta = 0, y along theta = +90 degrees, along = down the leg
  toLocal(s, uu, P) {
    const L = this.legs[s], f = this._row(L, uu), b = f | 0, t = f - b, o = b * 3;
    const c = [0, 1, 2].map(k => lerp(L.C[o + k], L.C[o + 3 + k], t));
    const dx = P.x - c[0], dy = P.y - c[1], dz = P.z - c[2];
    const dot = A => dx * lerp(A[o], A[o + 3], t) + dy * lerp(A[o + 1], A[o + 4], t) + dz * lerp(A[o + 2], A[o + 5], t);
    return { x: dot(L.N), y: dot(L.B), along: dot(L.T) };
  }

  // u whose centre is nearest to P, searched around `around` (past the toes too)
  nearestU(s, P, around) {
    const lo = Math.max(this.legs[s].us[0], around - 0.3), hi = Math.min(this.uEnd[s] + 0.45, around + 0.3);
    let best = around, bestD = Infinity;
    const q = new THREE.Vector3();
    for (let u = lo; u <= hi; u += 0.003) {
      const d = this.center(s, u, q).distanceToSquared(P);
      if (d < bestD) { bestD = d; best = u; }
    }
    return best;
  }

  // the part of the index that covers leg s from u0 to u1, for raycasting just that ([start, count])
  indexRange(s, u0, u1) {
    const L = this.legs[s], rs = this.triRow[s];
    const r0 = Math.max(0, Math.floor(this._row(L, u0)) - 1), r1 = Math.min(L.rows, Math.ceil(this._row(L, u1)) + 1);
    return [rs[r0] * 3, (rs[r1] - rs[r0]) * 3];
  }

  // ---------- the welt as an elastic ring ----------
  // Each of the K ring nodes (angle -PI + 2PI k/K around the leg) has
  //   line: where the fabric leaves the skin (the fold or roll line), in u
  //   curl: 0 = slid down under the finger, the fabric bunched up just above the line,
  //         1 = rolled up into a tube (dragged along by the welt)

  resetRing(s, line, curl = 0.8) { this.ring[s].line.fill(line); this.ring[s].curl.fill(curl); }

  ringAt(s, th) {
    const f = (th + Math.PI) / (Math.PI * 2) * K, k0 = ((Math.floor(f) % K) + K) % K, k1 = (k0 + 1) % K, t = f - Math.floor(f);
    const R = this.ring[s];
    return [lerp(R.line[k0], R.line[k1], t), lerp(R.curl[k0], R.curl[k1], t)];
  }

  // The finger moves the welt at angle thg to u = line.
  // Pushed down, every other node only moves when the welt between it and the finger is stretched
  // past its slack (friction holds it otherwise), and a node dragged along this way curls into a
  // roll, more so the further it is from the finger.
  // Lifted back up, the elastic welt pulls up all the way round at once: each node's distance below
  // the top shrinks in proportion to the finger's (a little less on the far side), so the whole welt
  // is back at the top when the finger is, and the rolls shrink and unroll on the way.
  // this.tight (0..1, default 0.5) is how hard the stocking clings to the leg. Looser (towards 0) the
  // slack shrinks and the welt moves more as one; tighter (towards 1) the slack grows and less of the
  // lift reaches the far side, until at 1 it stays where it is until the welt is stretched past its slack.
  pull(s, thg, line, top) {
    const R = this.ring[s], end = this.uEnd[s], t = this.tight;
    const slackK = t < 0.5 ? lerp(0.4, 1, t * 2) : lerp(1, 1.6, t * 2 - 1), follow = Math.min(1, 2 - 2 * t);
    const lg = Math.min(end + 0.4, Math.max(top, line));
    const was = Math.min(end + 0.4, Math.max(top, this.ringAt(s, thg)[0]));
    const up = was - lg, ratio = up > 0 ? (lg - top) / (was - top) : 1;
    for (let k = 0; k < K; k++) {
      const a = angDist(-Math.PI + (Math.PI * 2 * k) / K, thg);
      const arc = a * this.meanR(s, Math.min(R.line[k], end));
      const slack = slackK * 1.25 * arc * arc / (arc + 0.04);
      const old = R.line[k];
      const held = up > 0 ? top + (old - top) * Math.pow(ratio, (1 - 0.35 * smoothstep(0.3, Math.PI, a)) * follow) : old;
      let nl = Math.max(top, Math.min(lg + slack, Math.max(lg - slack, held)));
      if (up > 0 && lg - top < 5e-4 && nl - top < 0.003) nl = top;     // the finger is home: so is the rest
      const moved = nl - old;
      if (moved !== 0) {
        const target = 0.85 * smoothstep(0.35, 1.9, a);
        const goal = moved > 0 ? target : Math.min(target, R.curl[k]);   // lifting only ever uncurls
        R.curl[k] += (goal - R.curl[k]) * Math.min(1, Math.abs(moved) / 0.025);
      }
      R.line[k] = nl;
    }
  }

  // highest point of the fold line: below it the leg is still covered
  coverU(s) { return Math.min(...this.ring[s].line); }
  isOff(s) { return Math.min(...this.ring[s].line) >= this.uEnd[s] - 1e-3; }
  isWorn(s, top) { return Math.max(...this.ring[s].line) <= top + 1e-4; }
  progress(s, top) {
    const end = this.uEnd[s];
    let sum = 0;
    for (const l of this.ring[s].line) sum += (Math.min(l, end) - top) / (end - top);
    return sum / K;
  }

  // How far a finger hooked under the welt pulls it off the leg, per column. The welt is an elastic
  // loop round the leg's cross-section at u; with the finger at F2 (in that section's plane) the loop
  // takes the shape of the convex hull of the section and the finger: two straight, taut runs from
  // the finger to where they leave the skin, and the rest still on the leg.
  hookLift(s, uu, F2, thick) {
    const L = this.legs[s], f = this._row(L, uu), b = f | 0, t = f - b, cols = L.cols;
    const pts = [], base = new Float64Array(cols), lift = new Float32Array(cols);
    for (let k = 0; k < cols; k++) {
      const th = -Math.PI + Math.PI * 2 * k / cols;
      base[k] = this._radius(L, b, t, th) + thick;
      pts.push([base[k] * Math.cos(th), base[k] * Math.sin(th)]);
    }
    pts.push(F2);
    const hull = convexHull(pts);
    let max = 0;
    for (let k = 0; k < cols; k++) {
      const th = -Math.PI + Math.PI * 2 * k / cols;
      lift[k] = Math.max(0, rayHull(Math.cos(th), Math.sin(th), hull) - base[k]);
      max = Math.max(max, lift[k]);
    }
    return { lift, max, cols };
  }

  // forget what leg s looked like, so the next update() redoes all of it
  invalidate(s) { this.done[s] = null; }

  // Positions the stocking of leg s (the one in view).
  // hook: null, or { s, u, F2: [x, y] } — the finger at F2 in the frame at u (see hookLift)
  // camera: for leaving out-of-sight fabric coarse (null: everything exact)
  update(s, top, thick, hook = null, camera = null) {
    const t0 = performance.now();
    const L = this.legs[s], rows = L.rows, cols = L.cols, end = this.uEnd[s], b0 = this.base[s];
    const geo = this.geometry, P = geo.attributes.position.array, Nrm = geo.attributes.normal.array;
    const rolledA = geo.attributes.aRolled.array, pullA = geo.attributes.aPull.array;
    const { basePos, baseN, radial, vstate: st, ring } = this;
    const hk = hook && hook.s === s ? this.hookLift(s, hook.u, hook.F2, thick) : null;
    const lifting = !!(hk && hk.max > 1e-4);
    // below the welt the lifted fabric runs straight back to the skin, further the harder it is pulled
    const reach = lifting ? 0.02 + 2.2 * hk.max : 0;

    // rings that can be off the skin: from just above the top down to the lowest fold line, or as far
    // as the lifted fabric reaches; and the rings that were off it last time, which go back now
    let lowest = top;
    for (const l of ring[s].line) lowest = Math.max(lowest, l);
    const moving = lowest > top + 1e-5 || lifting;
    const r0 = Math.max(0, Math.floor(this._row(L, top)) - 1);
    const r1 = moving ? Math.min(rows - 1, Math.ceil(this._row(L, Math.min(lowest, end) + reach)) + 2) : r0 - 1;
    const last = this.done[s], full = !last || last.top !== top || last.thick !== thick;
    let a0 = r0, a1 = r1;
    if (full) { a0 = 0; a1 = rows - 1; }
    else if (last.r1 >= last.r0) { a0 = Math.min(a0, last.r0); a1 = Math.max(a1, last.r1); }
    this.done[s] = { top, thick, r0, r1 };
    this.coarse = false;
    if (a1 < a0) { this.stats = { rows: 0, verts: 0, coarse: 0, ms: performance.now() - t0 }; return; }

    // what the camera cannot see: rings out of frame, and fabric round the back of the leg
    let frustum = null, eye = null;
    if (camera && this.lod) {
      camera.updateMatrixWorld();
      frustum = this._frustum.setFromProjectionMatrix(this._mat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      eye = camera.position;
    }
    const sph = this._sphere;
    const hiddenAt = (C, D, radius) => {
      sph.center.set(C[0], C[1], C[2]);
      sph.radius = radius;
      if (!frustum.intersectsSphere(sph)) return 1;
      const ex = eye.x - C[0], ey = eye.y - C[1], ez = eye.z - C[2];
      return (ex * D[0] + ey * D[1] + ez * D[2]) / Math.hypot(ex, ey, ez) < BACK ? 1 : 0;
    };

    // per column: the fold line, the welt's frame there (and whether the camera sees it), the finger's lift
    const c = this._col;
    for (let k = 0; k < cols; k++) {
      const th = -Math.PI + Math.PI * 2 * k / cols;
      const [line, curl] = this.ringAt(s, th), lr = Math.min(line, end);
      c.line[k] = lr; c.curl[k] = curl;
      c.cos[k] = Math.cos(th); c.sin[k] = Math.sin(th);
      c.lift[k] = lifting ? hk.lift[k] : 0;
      if (lr - top > 1e-5) {
        c.R0[k] = this._frame(s, lr, th) + thick;
        const F = this._F;
        for (let i = 0; i < 3; i++) { c.C[k * 3 + i] = F.C[i]; c.D[k * 3 + i] = F.D[i]; c.T[k * 3 + i] = F.T[i]; }
        // the fabric bunched or rolled up at the welt is there, not where it lay on the leg
        c.hid[k] = frustum ? hiddenAt(F.C, F.D, c.R0[k] + 0.03) : 0;
      }
    }

    let verts = 0, coarse = 0;
    for (let r = a0; r <= a1; r++) {
      const uu = L.us[r], tip = r === rows - 1, o = r * 3;
      // out-of-sight fabric is left out on odd rings and columns. Only inside the rings that can move
      // and away from their ends (the welt's rings are always exact), so which vertices are left out
      // depends on the stocking's state alone, not on how much this update happens to redo
      let hidden = 0;          // 0: never left out, 1: ring out of frame, 2: look per column
      let fa = 0, fb = 0;
      if (frustum && r > Math.max(a0, r0 + 2) && r < Math.min(a1, r1 - 1) && r < rows - 2) {
        sph.center.set(L.C[o], L.C[o + 1], L.C[o + 2]);
        sph.radius = L.maxR[r] + 0.05;
        if (!frustum.intersectsSphere(sph)) hidden = 1;
        else {
          const ex = eye.x - L.C[o], ey = eye.y - L.C[o + 1], ez = eye.z - L.C[o + 2], el = Math.hypot(ex, ey, ez);
          fa = (ex * L.N[o] + ey * L.N[o + 1] + ez * L.N[o + 2]) / el;
          fb = (ex * L.B[o] + ey * L.B[o + 1] + ez * L.B[o + 2]) / el;
          hidden = 2;
        }
      }
      for (let kk = 0, kn = tip ? 1 : cols; kk < kn; kk++) {
        const k = tip ? this.tipK[s] : kk, j = b0 + r * cols + kk, j3 = j * 3;
        const lr = c.line[k], Lk = lr - top;
        if (hidden && ((r | k) & 1) && c.lift[k] === 0 &&
            (Lk > 1e-5 && uu < lr ? c.hid[k] : hidden === 1 || fa * c.cos[k] + fb * c.sin[k] < BACK)) {
          st[j] = 2; coarse++; continue;
        }
        verts++;
        let dx = radial[j3], dy = radial[j3 + 1], dz = radial[j3 + 2];
        let rolled = 0, moved = 0;
        if (Lk <= 1e-5 || uu >= lr) {
          P[j3] = basePos[j3] + baseN[j3] * thick;
          P[j3 + 1] = basePos[j3 + 1] + baseN[j3 + 1] * thick;
          P[j3 + 2] = basePos[j3 + 2] + baseN[j3 + 2] * thick;
        } else {
          const d = lr - Math.max(uu, top), kf = d / Lk, curl = c.curl[k], th = -Math.PI + Math.PI * 2 * k / cols;
          const k3 = k * 3, R0 = c.R0[k];
          dx = c.D[k3]; dy = c.D[k3 + 1]; dz = c.D[k3 + 2];

          // rolled: a spiral tube, welt at the core, thicker the more fabric it holds
          const sq = Math.sqrt(Lk);
          const wob = 1 + 0.22 * Math.sin(th * 3 + d * 55) + 0.1 * Math.sin(th * 7 - d * 31);
          const rho = (0.003 + 0.011 * sq) * wob;
          const layer = rho * (0.3 + 0.7 * (1 - kf));
          const phi = d / (rho / wob * 0.7);
          const rRad = R0 + rho - layer * Math.cos(phi), rAlong = -layer * Math.sin(phi);
          const x = c.C[k3] + dx * rRad + c.T[k3] * rAlong;
          const y = c.C[k3 + 1] + dy * rRad + c.T[k3 + 1] * rAlong;
          const z = c.C[k3 + 2] + dz * rRad + c.T[k3 + 2] * rAlong;

          // slid: the fabric the welt passed bunches into folds from the line up to the welt
          // (starts on the skin at the line, so there is no jump where it leaves the leg)
          const w = Math.min(0.06, 0.015 + 0.12 * Lk, 0.6 * Lk);
          const folds = 3 + 12 * Lk;
          const bunch = (0.0012 + 0.006 * sq) * Math.abs(Math.sin(kf * Math.PI * folds))
            * (1 + 0.25 * Math.sin(th * 3 + d * 40)) * Math.min(1, d / 0.006);
          const f = this._row(L, lr - w * kf), b = f | 0, t = f - b, ob = b * 3;
          const rad = lerp(L.R[b * cols + k], L.R[(b + 1) * cols + k], t) + thick + bunch;
          const cs = c.cos[k], sn = c.sin[k];
          for (let i = 0; i < 3; i++) {
            const q = lerp(L.C[ob + i], L.C[ob + 3 + i], t)
              + rad * (cs * lerp(L.N[ob + i], L.N[ob + 3 + i], t) + sn * lerp(L.B[ob + i], L.B[ob + 3 + i], t));
            P[j3 + i] = lerp(q, i === 0 ? x : i === 1 ? y : z, curl);
          }
          // layers of fabric on top of each other: bunched fabric is denser, a roll is opaque
          rolled = Math.min(1, d / 0.008) * (0.25 + 0.75 * curl);
          moved = 1;
        }
        rolledA[j] = rolled;

        // hooked: straight out from the leg, by the welt's lift at this angle, fading linearly below the welt
        let pl = 0;
        if (c.lift[k] > 0) {
          pl = c.lift[k] * (uu >= lr ? Math.max(0, 1 - (uu - lr) / reach) : 1);
          P[j3] += dx * pl; P[j3 + 1] += dy * pl; P[j3 + 2] += dz * pl;
          if (pl > 0) moved = 1;
        }
        pullA[j] = Math.min(1, pl / 0.03);
        st[j] = moved;
      }
    }

    // fill in what was left out from the computed neighbours: the rings either side on odd rings,
    // the columns either side on odd columns, the four corners where both are odd
    if (coarse) {
      for (let r = a0 + 1; r < a1; r++) {
        const row = b0 + r * cols;
        for (let k = 0; k < cols; k++) {
          const j = row + k;
          if (st[j] !== 2) continue;
          const kl = k === 0 ? cols - 1 : k - 1, kr = k === cols - 1 ? 0 : k + 1;
          let n0, n1, n2 = -1, n3 = -1;
          if (!(r & 1)) { n0 = row + kl; n1 = row + kr; }
          else if (!(k & 1)) { n0 = j - cols; n1 = j + cols; }
          else { n0 = row - cols + kl; n1 = row - cols + kr; n2 = row + cols + kl; n3 = row + cols + kr; }
          const j3 = j * 3;
          if (!(st[n0] | st[n1] | (n2 < 0 ? 0 : st[n2] | st[n3]))) {
            P[j3] = basePos[j3] + baseN[j3] * thick;
            P[j3 + 1] = basePos[j3 + 1] + baseN[j3 + 1] * thick;
            P[j3 + 2] = basePos[j3 + 2] + baseN[j3 + 2] * thick;
            rolledA[j] = pullA[j] = st[j] = 0;
            continue;
          }
          const a3 = n0 * 3, b3 = n1 * 3;
          if (n2 < 0) {
            P[j3] = (P[a3] + P[b3]) * 0.5; P[j3 + 1] = (P[a3 + 1] + P[b3 + 1]) * 0.5; P[j3 + 2] = (P[a3 + 2] + P[b3 + 2]) * 0.5;
            rolledA[j] = (rolledA[n0] + rolledA[n1]) * 0.5; pullA[j] = (pullA[n0] + pullA[n1]) * 0.5;
          } else {
            const c3 = n2 * 3, d3 = n3 * 3;
            P[j3] = (P[a3] + P[b3] + P[c3] + P[d3]) * 0.25;
            P[j3 + 1] = (P[a3 + 1] + P[b3 + 1] + P[c3 + 1] + P[d3 + 1]) * 0.25;
            P[j3 + 2] = (P[a3 + 2] + P[b3 + 2] + P[c3 + 2] + P[d3 + 2]) * 0.25;
            rolledA[j] = (rolledA[n0] + rolledA[n1] + rolledA[n2] + rolledA[n3]) * 0.25;
            pullA[j] = (pullA[n0] + pullA[n1] + pullA[n2] + pullA[n3]) * 0.25;
          }
          st[j] = 1;
        }
      }
    }

    // normals: the mesh's own where the fabric lies on the skin, from the neighbours where it moved
    const nrm = [0, 0, 0];
    for (let r = a0; r <= a1; r++) {
      for (let k = 0, kn = r === rows - 1 ? 1 : cols; k < kn; k++) {
        const j = b0 + r * cols + k, j3 = j * 3;
        if (!st[j]) { Nrm[j3] = baseN[j3]; Nrm[j3 + 1] = baseN[j3 + 1]; Nrm[j3 + 2] = baseN[j3 + 2]; continue; }
        this._normal(s, r, k, P, this.nSign[s], nrm);
        Nrm[j3] = nrm[0]; Nrm[j3 + 1] = nrm[1]; Nrm[j3 + 2] = nrm[2];
      }
    }

    // upload only the vertices that were touched
    const v0 = b0 + a0 * cols, v1 = a1 === rows - 1 ? this.base[s + 1] : b0 + (a1 + 1) * cols;
    for (const [name, size] of [['position', 3], ['normal', 3], ['aRolled', 1], ['aPull', 1]]) {
      const attr = geo.attributes[name];
      attr.clearUpdateRanges();
      attr.addUpdateRange(v0 * size, (v1 - v0) * size);
      attr.needsUpdate = true;
    }
    this.coarse = coarse > 0;
    this.stats = { rows: a1 - a0 + 1, verts, coarse, ms: performance.now() - t0 };
  }

  // normal at ring r, column k of leg s from the positions of its four neighbours (into out)
  _normal(s, r, k, P, sign, out) {
    const L = this.legs[s], rows = L.rows, cols = L.cols, b0 = this.base[s];
    let x = 0, y = 0, z = 0;
    if (r === rows - 1) {
      // the toe tip: the fan of triangles round it
      const t3 = (b0 + r * cols) * 3, o = b0 + (r - 1) * cols;
      for (let k0 = 0; k0 < cols; k0++) {
        const a3 = (o + k0) * 3, c3 = (o + (k0 + 1) % cols) * 3;
        const ax = P[a3] - P[t3], ay = P[a3 + 1] - P[t3 + 1], az = P[a3 + 2] - P[t3 + 2];
        const cx = P[c3] - P[t3], cy = P[c3 + 1] - P[t3 + 1], cz = P[c3 + 2] - P[t3 + 2];
        x += cy * az - cz * ay; y += cz * ax - cx * az; z += cx * ay - cy * ax;
      }
    } else {
      const row = b0 + r * cols;
      const up = (r > 0 ? row - cols + k : row + k) * 3, dn = (r + 1 === rows - 1 ? row + cols : row + cols + k) * 3;
      const lf = (row + (k === 0 ? cols - 1 : k - 1)) * 3, rt = (row + (k === cols - 1 ? 0 : k + 1)) * 3;
      const ax = P[rt] - P[lf], ay = P[rt + 1] - P[lf + 1], az = P[rt + 2] - P[lf + 2];
      const bx = P[dn] - P[up], by = P[dn + 1] - P[up + 1], bz = P[dn + 2] - P[up + 2];
      x = ay * bz - az * by; y = az * bx - ax * bz; z = ax * by - ay * bx;
    }
    const l = Math.hypot(x, y, z) || 1;
    out[0] = sign * x / l; out[1] = sign * y / l; out[2] = sign * z / l;
    return out;
  }
}

// column of angle th on a ring of `cols` points (column 0 at -PI)
function column(th, cols) {
  return ((Math.round((th + Math.PI) / (Math.PI * 2) * cols) % cols) + cols) % cols;
}
// convex hull of 2D points (monotone chain), counter-clockwise
function convexHull(pts) {
  pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of pts) { while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (hi.length > 1 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
// distance from the origin along unit (dx, dy) to where the ray leaves the convex polygon
function rayHull(dx, dy, hull) {
  let best = 0;
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i], [bx, by] = hull[(i + 1) % hull.length];
    const ex = bx - ax, ey = by - ay, den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (ax * ey - ay * ex) / den, sg = (ax * dy - ay * dx) / den;
    if (t > 0 && sg >= 0 && sg <= 1) best = Math.max(best, t);
  }
  return best;
}
function angDist(a, b) {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
