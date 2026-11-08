// Cel-shaded materials: skin, stocking and the inverted-hull outline.
import * as THREE from 'three';

export const light = {
  dir: new THREE.Vector3(-0.45, 0.75, 0.55).normalize(),   // key light, from the upper left front
};

const lightChunk = /* glsl */`
uniform vec3 uLightDir;
float celBand(float ndl, float soft) { return smoothstep(-soft, soft, ndl); }
`;

// Leg details, both switchable on the panel:
//   knee lines: anime-style ink on the knee (an arc under the kneecap, a short stroke either side) and a
//     small highlight on the kneecap, placed by u along the leg and the angle round it (0 = front)
//   shine strip: a vertical highlight down the side of the leg facing the camera, leaning towards the
//     light; it follows the view, so it slides over the leg when the camera turns
const detailChunk = /* glsl */`
uniform float uKneeLines, uShine;
uniform vec2 uKnee;                      // u of the knee joint, left and right
// ink (0..1) of the knee lines at u, angle (as cos, sin) and leg radius r (m); spot: kneecap highlight
float segDist(vec2 p, vec2 a, vec2 b, out float t) {
  vec2 ab = b - a;
  t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
  return length(p - a - ab * t);
}
float kneeInk(float u, vec2 cs, float r, float knee, out float spot) {
  spot = 0.0;
  float y = u - knee;                   // down the leg (m), 0 at the joint
  if (uKneeLines < 0.5 || abs(y) > 0.06 || cs.x < 0.3) return 0.0;
  float a = atan(cs.y, cs.x) * r;       // across the front (m)
  vec2 p = vec2(a, y);
  float fw = max(length(vec2(fwidth(a), fwidth(y))), 1e-5);
  // under the kneecap: a shallow curve, lowest in the middle, thinning out at both ends
  float k = 24.0;
  float d1 = abs(y - (0.004 - k * a * a)) / sqrt(1.0 + 4.0 * k * k * a * a);
  float w1 = 0.001 * (1.0 - smoothstep(0.005, 0.016, abs(a)));
  // (times the width over a pixel: a stroke tapered to nothing must vanish, not stay half-drawn)
  float ink = (1.0 - smoothstep(w1 - fw, w1 + fw, d1)) * clamp(w1 / fw, 0.0, 1.0);
  // either side of the kneecap, well apart from the curve: a short stroke leaning in at the bottom
  float t;
  float s = sign(a);
  float d2 = segDist(p, vec2(s * 0.025, -0.024), vec2(s * 0.021, -0.012), t);
  float w2 = 0.0008 * sin(3.1416 * t);
  ink = max(ink, (1.0 - smoothstep(w2 - fw, w2 + fw, d2)) * clamp(w2 / fw, 0.0, 1.0));
  // the kneecap catching the light
  spot = 1.0 - smoothstep(0.75, 1.0, length(vec2(a + 0.004, y + 0.017) / vec2(0.008, 0.011)));
  return ink * smoothstep(0.3, 0.6, cs.x);
}
// the shine strip (0..1) for normal N, view V, light L
float shineStrip(vec3 N, vec3 V, vec3 L) {
  if (uShine < 0.5) return 0.0;
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 Nh = N - dot(N, up) * up, Vh = V - dot(V, up) * up, Lh = L - dot(L, up) * up;
  float horiz = length(Nh);              // the top of the foot faces up: no strip there
  float h = dot(Nh / max(horiz, 1e-4), normalize(normalize(Vh) + 0.7 * normalize(Lh)));
  float fw = max(fwidth(h), 1e-4);
  return smoothstep(0.972 - fw, 0.972 + fw, h) * smoothstep(0.75, 0.9, horiz);
}
`;

const commonVert = /* glsl */`
varying vec3 vN;
varying vec3 vW;
`;

export function skinMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uLightDir: { value: light.dir },
      uLit: { value: new THREE.Color('#ffe1d0') },
      uShade: { value: new THREE.Color('#e8a993') },
      uDeep: { value: new THREE.Color('#dc9f8f') },
      uRim: { value: new THREE.Color('#fff4ee') },
      uHide: { value: -1 },              // leg not shown: 0 left (+x), 1 right, -1 none
      uEdge: { value: 0 },               // 1: darken the silhouette in the shader instead of an outline mesh
      uKneeLines: { value: 1 },
      uShine: { value: 1 },
      uKnee: { value: new THREE.Vector2(0.394, 0.394) },
    },
    vertexShader: commonVert + /* glsl */`
      attribute vec2 aLegU;              // (u, 1 - theta), see the outline
      varying vec3 vK;                   // u, cos theta, sin theta: no jump across the back seam
      void main() {
        float th = 1.0 - aLegU.y;
        vK = vec3(aLegU.x, cos(th), sin(th));
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: commonVert + lightChunk + detailChunk + /* glsl */`
      uniform vec3 uLit, uShade, uDeep, uRim;
      uniform float uHide, uEdge;
      varying vec3 vK;
      void main() {
        float side = vW.x > 0.0 ? 0.0 : 1.0;
        if (side == uHide) discard;
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vW);
        float ndl = dot(N, uLightDir);
        vec3 col = mix(uShade, uLit, celBand(ndl, 0.03));
        col = mix(uDeep, col, celBand(ndl + 0.75, 0.05));
        float rim = smoothstep(0.62, 0.68, 1.0 - max(dot(N, V), 0.0)) * celBand(dot(N, uLightDir) + 0.3, 0.05);
        col = mix(col, uRim, rim * 0.6 * (1.0 - 0.6 * uEdge));
        // soft edge: a dark band where the surface turns away, a few pixels wide on the thigh
        float nv = max(dot(N, V), 0.0);
        col = mix(col, uDeep * 0.62, uEdge * (1.0 - smoothstep(0.08, 0.38, nv)) * 0.85);
        // leg details: the shine strip and kneecap highlight, then the knee lines on top
        float spot;
        float ink = kneeInk(vK.x, vK.yz, 0.052, side < 0.5 ? uKnee.x : uKnee.y, spot);
        col = mix(col, uRim, 0.5 * shineStrip(N, V, uLightDir) + 0.45 * spot);
        col = mix(col, uDeep * 0.55, 0.6 * ink);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

// pattern: 0 plain, 1 fishnet, 2 stripes, 3 a mask texture (uPatTex, see tools/gen_patterns.py);
// band: 0 none, 1 plain welt, 2 lace
// gradient (uGrad): 0 none, 1 colour (uColor at the welt -> uGradColor), 2 sheerness (thinner and
// thinner); centred on u = uGradMid, uGradW wide; uGradFlip 1 runs it the other way up the leg
// custom images (js/custom.js): the pattern texture can carry colour (uPatRGB 1); uBand 3 is a custom welt
// (uBandTex, repeated uBandRepeat times round the leg, uBandRGB); uStrapTexMode 1/2 prints an image on
// the straps as a mask or in colour. Mask: the motif in the stocking's (strap's) colour; colour: as is
// (the stocking's sheerness still follows the denier)
// straps (uStrap > 0): two pairs of satin ribbons wound round the leg in opposite directions, crossing
// in an X on the front every 8 cm, from u = uStrapSpan.x to .y, with a ribbon round the leg at each end
export function stockingMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,                // the inside shows where the fabric is pulled away
    uniforms: {
      uLightDir: { value: light.dir },
      uColor: { value: new THREE.Color('#1b1b22') },
      uColor2: { value: new THREE.Color('#f4f1ec') },
      uDenier: { value: 30 },
      uGloss: { value: 0.35 },
      uPattern: { value: 0 },
      uBand: { value: 2 },
      uTop: { value: 0.3 },
      uToe: { value: new THREE.Vector2(0.91, 0.91) },
      uOff: { value: new THREE.Vector2(0, 0) },
      uEdge: { value: 0 },
      uPatTex: { value: null },
      uPatAround: { value: 6 },          // repeats round the leg: the knit has a fixed number of stitches
      uPatBase: { value: 1 },            // how much of the plain knit shows between motifs (0: open holes)
      uGrad: { value: 0 },
      uGradColor: { value: new THREE.Color('#6e1f2e') },
      uGradMid: { value: 0.6 },
      uGradW: { value: 0.25 },
      uGradFlip: { value: 0 },
      uPatRGB: { value: 0 },
      uBandTex: { value: null },
      uBandRGB: { value: 0 },
      uBandRepeat: { value: 8 },
      uStrapTex: { value: null },
      uStrapTexMode: { value: 0 },
      uStrapAspect: { value: 1 },
      uStrap: { value: 0 },
      uStrapColor: { value: new THREE.Color('#15151a') },
      uStrapSpan: { value: new THREE.Vector2(0.45, 0.78) },
      uKneeLines: { value: 1 },
      uShine: { value: 1 },
      uKnee: { value: new THREE.Vector2(0.394, 0.394) },
    },
    vertexShader: commonVert + /* glsl */`
      attribute vec4 aFab;
      attribute float aSide, aStretch, aRolled, aPull;
      varying vec4 vFab;
      varying float vSide, vStretch, vRolled, vPull;
      void main() {
        vFab = aFab; vSide = aSide; vStretch = aStretch; vRolled = aRolled; vPull = aPull;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: commonVert + lightChunk + detailChunk + /* glsl */`
      uniform vec3 uColor, uColor2;
      uniform float uDenier, uGloss, uTop, uEdge, uPatAround, uPatBase;
      uniform int uPattern, uBand, uGrad;
      uniform vec3 uGradColor;
      uniform float uGradMid, uGradW, uGradFlip;
      uniform int uStrap, uStrapTexMode;
      uniform float uPatRGB, uBandRGB, uBandRepeat, uStrapAspect;
      uniform sampler2D uBandTex, uStrapTex;
      uniform vec3 uStrapColor;
      uniform vec2 uStrapSpan;
      uniform sampler2D uPatTex;
      uniform vec2 uToe, uOff;
      varying vec4 vFab;
      varying float vSide, vStretch, vRolled, vPull;

      float aa(float x, float w) { float f = fwidth(x) + 1e-5; return smoothstep(w - f, w + f, x); }

      void main() {
        float off = vSide < 0.5 ? uOff.x : uOff.y;
        if (off > 0.5) discard;
        float u = vFab.x;
        float bu = u - uTop;
        if (bu < 0.0) discard;
        float s = atan(vFab.z, vFab.y) * vFab.w;          // arc length around the leg (m)
        float rolled = vRolled;

        vec3 N = normalize(vN);
        if (!gl_FrontFacing) N = -N;
        vec3 V = normalize(cameraPosition - vW);
        float nv = max(abs(dot(N, V)), 0.18);

        // sheerness: denier gives the coverage seen straight on; stretching (by the leg, or by the
        // hand pulling it out) thins the knit; at grazing angles light crosses more fabric, so the
        // silhouette goes darker (softened a little for the toon look)
        float toe = smoothstep(-0.04, 0.0, u - (vSide < 0.5 ? uToe.x : uToe.y));
        // gradient: 0 at the welt end, 1 at the toe end (or the other way round)
        float gt = 0.0;
        if (uGrad > 0) {
          gt = smoothstep(uGradMid - 0.5 * uGradW, uGradMid + 0.5 * uGradW, u);
          if (uGradFlip > 0.5) gt = 1.0 - gt;
        }
        float D = uDenier * (1.0 - 0.45 * vStretch) * (1.0 - 0.6 * vPull) * (1.0 + 0.3 * toe)
                * (uGrad == 2 ? mix(1.0, 0.18, gt) : 1.0);
        float a0 = 1.0 - exp(-D / 55.0);
        // fabric pulled off the leg is a stretched, see-through sheet: less darkening at grazing angles
        float a = 1.0 - pow(1.0 - a0, 1.0 / pow(mix(nv, 1.0, 0.7 * vPull), 0.7));
        vec3 base = uGrad == 1 ? mix(uColor, uGradColor, gt) : uColor;

        if (uPattern == 1) {                                // fishnet
          vec2 q = vec2(s + u, s - u) / 0.018;
          vec2 g = abs(fract(q) - 0.5);
          float e = 0.5 - max(g.x, g.y);
          float line = 1.0 - aa(e, 0.04 + 0.05 * min(uDenier, 100.0) / 100.0);
          a = mix(0.0, 0.96, line);
        } else if (uPattern == 2) {                         // stripes across the leg
          float st = aa(abs(fract(u / 0.045) - 0.5), 0.25);
          base = mix(base, uColor2, st);
          a = max(a, 0.9);
        } else if (uPattern == 3) {                         // mask texture: opaque motifs on the sheer knit
          // a whole number of repeats round the leg, so it wraps without a seam; tiles are square on the
          // calf (34 cm round) and stretch wider over the thigh, like a pattern knitted into the stocking
          float tile = 0.34 / uPatAround;
          vec2 uv = vec2((atan(vFab.z, vFab.y) / 6.2832 + 0.5) * uPatAround, -u / tile);
          // the angle jumps by a whole tile at the back: take the gradients from an angle that jumps at
          // the front instead wherever that is smoother, or the mipmap level spikes into a thin line
          vec2 uv2 = vec2((atan(-vFab.z, -vFab.y) / 6.2832 + 0.5) * uPatAround, uv.y);
          vec2 gx = dFdx(uv), gy = dFdy(uv), gx2 = dFdx(uv2), gy2 = dFdy(uv2);
          if (abs(gx2.x) + abs(gy2.x) < abs(gx.x) + abs(gy.x)) { gx = gx2; gy = gy2; }
          vec4 tx = textureGrad(uPatTex, uv, gx, gy);
          if (uPatRGB > 0.5) base = mix(base, tx.rgb, tx.a);   // a colour image: printed on, sheerness by denier
          else a = mix(a * uPatBase, 0.95, tx.a);
        }

        float bandW = 0.06;
        if (uBand > 0 && rolled < 0.5 && bu < bandW) {
          if (uBand == 2) {                                 // lace: scalloped edge, flower rings
            float sc = 0.0045 * (0.5 + 0.5 * cos(s / 0.012 * 6.2832));
            if (bu < sc) discard;
            vec2 cell = vec2(s / 0.012, bu / 0.012);
            vec2 f = fract(cell + vec2(0.5 * floor(mod(cell.y, 2.0)), 0.0)) - 0.5;
            float d = length(f);
            float ring = 1.0 - aa(abs(d - 0.3), 0.06);
            float core = 1.0 - aa(d, 0.09);
            float lace = max(ring, core);
            a = mix(0.25 + 0.4 * a, 0.97, lace);
            base *= mix(1.0, 0.85, lace);
          } else if (uBand == 3) {                          // custom image, top of the image at the top edge
            vec2 bv = vec2((atan(vFab.z, vFab.y) / 6.2832 + 0.5) * uBandRepeat, 1.0 - bu / bandW);
            vec2 bv2 = vec2((atan(-vFab.z, -vFab.y) / 6.2832 + 0.5) * uBandRepeat, bv.y);
            vec2 bx = dFdx(bv), by = dFdy(bv), bx2 = dFdx(bv2), by2 = dFdy(bv2);
            if (abs(bx2.x) + abs(by2.x) < abs(bx.x) + abs(by.x)) { bx = bx2; by = by2; }   // see the pattern
            vec4 tx = textureGrad(uBandTex, bv, bx, by);
            if (uBandRGB > 0.5) { base = mix(base, tx.rgb, tx.a); a = max(a, 0.93 * tx.a); }
            else { a = mix(0.15 + 0.3 * a, 0.97, tx.a); base *= mix(1.0, 0.85, tx.a); }
          } else {                                          // plain welt
            a = max(a, 0.93);
            base *= 0.9;
            if (bu > bandW - 0.004) base *= 0.75;           // seam line under the welt
          }
        }
        // straps: not on fabric rolled up at the welt
        float ribbon = 0.0, rShade = 1.0;
        if (uStrap > 0 && rolled < 0.5 && u > uStrapSpan.x - 0.01 && u < uStrapSpan.y + 0.01) {
          const float P = 0.16, W = 0.0045;               // one turn per 16 cm, ribbons 9 mm wide
          float x = atan(vFab.z, vFab.y) / 6.2832;        // -0.5..0.5 round the leg, 0 at the front
          float du = uStrapSpan.y - u;                    // from the ankle up, so an X sits just above it
          // distance (m) to the nearest ribbon of each helix: f is whole along a ribbon; its gradient
          // over (arc length, u) turns the fraction into metres
          float g = length(vec2(2.0 / (6.2832 * max(vFab.w, 0.02)), 1.0 / P));
          float f1 = 2.0 * x + du / P, f2 = 2.0 * x - du / P;
          float inside = step(uStrapSpan.x, u) * step(u, uStrapSpan.y);
          float d1 = mix(1.0, abs(fract(f1 + 0.5) - 0.5) / g, inside);
          float d2 = mix(1.0, abs(fract(f2 + 0.5) - 0.5) / g, inside);
          float dRing = min(abs(u - uStrapSpan.x), abs(u - uStrapSpan.y));
          // which helix lies on top swaps from one crossing to the next, like real lacing; the end
          // ribbons lie on top of both
          bool oneUp = mod(floor(f1 + 0.5) + floor(f2 + 0.5), 2.0) < 0.5;
          float dUp = oneUp ? d1 : d2, dDown = oneUp ? d2 : d1;
          float d = dRing < W ? dRing : dUp < W ? dUp : dDown;
          float under = dRing < W ? 1.0 : min(dRing, dUp);         // what casts a shadow on this ribbon
          float near = min(dRing, min(d1, d2));
          float fw = max(fwidth(du), 1e-5);
          ribbon = 1.0 - smoothstep(W - fw, W + fw, d);
          vec4 stx = vec4(1.0);
          if (uStrapTexMode > 0) {
            // the image runs along the ribbon: (along, across) for the ribbon in view, in metres
            float circ = 6.2832 * max(vFab.w, 0.02), sArc = x * circ;
            vec2 g1 = vec2(2.0 / circ, -1.0 / P), g2 = vec2(2.0 / circ, 1.0 / P);
            float along, across;
            if (dRing < W) { along = sArc; across = abs(u - uStrapSpan.x) < abs(u - uStrapSpan.y) ? u - uStrapSpan.x : u - uStrapSpan.y; }
            else {
              bool first = (d == d1);
              vec2 gg = first ? g1 : g2;
              float f = first ? f1 : f2;
              along = dot(vec2(sArc, u), vec2(-gg.y, gg.x)) / length(gg);
              across = (fract(f + 0.5) - 0.5) / length(gg);
            }
            vec2 st = vec2(along / (2.0 * W * uStrapAspect), across / (2.0 * W) + 0.5);
            vec2 sx = dFdx(st), sy = dFdy(st);
            if (length(sx) + length(sy) > 0.5) { sx = vec2(0.0); sy = vec2(0.0); }   // jumps between ribbons
            stx = textureGrad(uStrapTex, st, sx, sy);
            ribbon *= stx.a;                              // see-through where the image has no motif
          }
          // satin: lighter down the middle, darker at the edges, in shadow next to the ribbon above
          float prof = d / W;
          vec3 rc = (uStrapTexMode == 2 ? stx.rgb : uStrapColor) * (0.8 + 0.35 * (1.0 - prof * prof)) * mix(1.0, 0.65, smoothstep(0.75, 1.0, prof));
          if (d == dDown && dRing >= W) rc *= mix(0.6, 1.0, smoothstep(W, W + 0.002, under));
          // the fabric right beside a ribbon is pressed in and shaded
          rShade = mix(0.62, 1.0, smoothstep(W, W + 0.0025, near));
          base = mix(base * rShade, rc, ribbon);
          a = mix(max(a, 1.0 - rShade), 0.98, ribbon);
        }
        a = mix(a, 0.97, rolled);
        if (a < 0.01) discard;

        float ndl = dot(N, uLightDir);
        vec3 col = base * mix(0.62, 1.0, celBand(ndl, 0.04));
        col = mix(col * 0.75, col, celBand(ndl + 0.5, 0.05));
        // toon sheen: a hard highlight band plus a soft rim that grows with gloss
        vec3 H = normalize(uLightDir + V);
        float spec = smoothstep(0.86, 0.88, dot(N, H)) * uGloss;
        float rim = smoothstep(0.55, 0.75, 1.0 - nv) * celBand(ndl + 0.2, 0.1) * uGloss;
        col += vec3(1.0) * (spec * 0.55 + rim * 0.25) * (1.0 - rolled * 0.5);
        // leg details on the fabric: the shine strip grows with gloss; the skin's knee lines show through
        // sheer fabric by themselves, so the fabric only adds them as it gets opaque
        if (rolled < 0.5 && vPull < 0.02) {
          float spot;
          float ink = kneeInk(u, vec2(vFab.y, vFab.z) / max(length(vFab.yz), 1e-5), vFab.w, vSide < 0.5 ? uKnee.x : uKnee.y, spot);
          col += vec3(1.0) * shineStrip(N, V, uLightDir) * (0.12 + 0.5 * uGloss) * (1.0 - ribbon);
          col = mix(col, col * 0.4, ink * smoothstep(0.5, 0.95, a) * 0.8 * (1.0 - ribbon));
        }
        // soft edge (see the skin): darker and more opaque where the fabric turns away; not on fabric
        // pulled off the leg, whose silhouette is a taut sheet seen almost edge-on
        float edge = uEdge * (1.0 - smoothstep(0.08, 0.38, abs(dot(N, V)))) * (1.0 - smoothstep(0.0, 0.3, vPull));
        col = mix(col, col * 0.35, edge * 0.8);
        a = mix(a, 1.0, edge * 0.6);
        gl_FragColor = vec4(col, a);
        #include <colorspace_fragment>
      }`,
  });
}

// Inverted hull. With STOCKING defined it also honours the stocking's cut and hidden sides.
// With skin given it hides the same leg as the skin material.
export function outlineMaterial(width, color, stocking = null, skin = null) {
  const defines = stocking ? { STOCKING: '' } : skin ? { LEGHIDE: '' } : {};
  const uniforms = {
    uWidth: { value: width },
    uRes: { value: new THREE.Vector2(1, 1) },
    uColor: { value: new THREE.Color(color) },
  };
  if (stocking) { uniforms.uTop = stocking.uniforms.uTop; uniforms.uOff = stocking.uniforms.uOff; uniforms.uPattern = stocking.uniforms.uPattern; uniforms.uPatBase = stocking.uniforms.uPatBase; }
  if (skin) {
    uniforms.uHide = skin.uniforms.uHide;
    // where the stocking leaves the skin round the leg in view (the welt ring's fold line, K nodes from
    // theta = -PI); skin below it is under the stocking. 10 everywhere: nothing covered
    uniforms.uRing = { value: new Float32Array(48).fill(10) };
  }
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    defines,
    uniforms,
    vertexShader: /* glsl */`
      uniform float uWidth;
      uniform vec2 uRes;
      #ifdef STOCKING
      attribute vec4 aFab;
      attribute float aSide, aPull;
      varying float vU, vSide, vPull;
      #endif
      #ifdef LEGHIDE
      attribute vec2 aLegU;              // (u, 1 - theta): glTF stores the second UV coordinate flipped
      uniform float uRing[48];
      varying vec3 vW;
      varying float vLegU, vLine;
      #endif
      void main() {
        #ifdef STOCKING
        vU = aFab.x; vSide = aSide; vPull = aPull;
        #endif
        #ifdef LEGHIDE
        vW = (modelMatrix * vec4(position, 1.0)).xyz;
        vLegU = aLegU.x;
        // the fold line at this vertex's angle (looked up per vertex, so the jump at theta = +-PI is
        // never interpolated across)
        float f = clamp((1.0 - aLegU.y + 3.14159265) / 6.2831853 * 48.0, 0.0, 47.999);
        int k0 = int(floor(f)) % 48;
        vLine = mix(uRing[k0], uRing[(k0 + 1) % 48], fract(f));
        #endif
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec3 nv = normalize(normalMatrix * normal);
        vec2 dir = normalize((projectionMatrix * vec4(nv, 0.0)).xy + 1e-6);
        clip.xy += dir * uWidth * clip.w * 2.0 / uRes;
        gl_Position = clip;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      #ifdef STOCKING
      uniform float uTop;
      uniform vec2 uOff;
      uniform int uPattern;
      uniform float uPatBase;
      varying float vU, vSide, vPull;
      #endif
      #ifdef LEGHIDE
      uniform float uHide;
      varying vec3 vW;
      varying float vLegU, vLine;
      #endif
      void main() {
        #ifdef LEGHIDE
        float side = vW.x > 0.0 ? 0.0 : 1.0;
        if (side == uHide) discard;
        // no skin outline under the stocking: it would show through the sheer fabric as dark seams
        if (vLegU > vLine + 0.01) discard;
        #endif
        #ifdef STOCKING
        // an inverted hull paints every back face: skip fabric pulled off the leg, whose inside is in view
        if (vU < uTop + 0.002 || (vSide < 0.5 ? uOff.x : uOff.y) > 0.5 || uPattern == 1 || (uPattern == 3 && uPatBase < 0.5) || vPull > 0.02) discard;
        #endif
        gl_FragColor = vec4(uColor, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}
