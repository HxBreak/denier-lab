// Cel-shaded materials: skin, stocking and the inverted-hull outline.
import * as THREE from 'three';

export const light = {
  dir: new THREE.Vector3(-0.45, 0.75, 0.55).normalize(),   // key light, from the upper left front
};

const lightChunk = /* glsl */`
uniform vec3 uLightDir;
float celBand(float ndl, float soft) { return smoothstep(-soft, soft, ndl); }
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
    },
    vertexShader: commonVert + /* glsl */`
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: commonVert + lightChunk + /* glsl */`
      uniform vec3 uLit, uShade, uDeep, uRim;
      uniform float uHide, uEdge;
      void main() {
        if ((vW.x > 0.0 ? 0.0 : 1.0) == uHide) discard;
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
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

// pattern: 0 plain, 1 fishnet, 2 stripes, 3 a mask texture (uPatTex, see tools/gen_patterns.py);
// band: 0 none, 1 plain welt, 2 lace
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
    fragmentShader: commonVert + lightChunk + /* glsl */`
      uniform vec3 uColor, uColor2;
      uniform float uDenier, uGloss, uTop, uEdge, uPatAround, uPatBase;
      uniform int uPattern, uBand;
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
        float D = uDenier * (1.0 - 0.45 * vStretch) * (1.0 - 0.6 * vPull) * (1.0 + 0.3 * toe);
        float a0 = 1.0 - exp(-D / 55.0);
        // fabric pulled off the leg is a stretched, see-through sheet: less darkening at grazing angles
        float a = 1.0 - pow(1.0 - a0, 1.0 / pow(mix(nv, 1.0, 0.7 * vPull), 0.7));
        vec3 base = uColor;

        if (uPattern == 1) {                                // fishnet
          vec2 q = vec2(s + u, s - u) / 0.018;
          vec2 g = abs(fract(q) - 0.5);
          float e = 0.5 - max(g.x, g.y);
          float line = 1.0 - aa(e, 0.04 + 0.05 * min(uDenier, 100.0) / 100.0);
          a = mix(0.0, 0.96, line);
        } else if (uPattern == 2) {                         // stripes across the leg
          float st = aa(abs(fract(u / 0.045) - 0.5), 0.25);
          base = mix(uColor, uColor2, st);
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
          float m = textureGrad(uPatTex, uv, gx, gy).a;
          a = mix(a * uPatBase, 0.95, m);
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
            base = uColor * mix(1.0, 0.85, lace);
          } else {                                          // plain welt
            a = max(a, 0.93);
            base = uColor * 0.9;
            if (bu > bandW - 0.004) base *= 0.75;           // seam line under the welt
          }
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
