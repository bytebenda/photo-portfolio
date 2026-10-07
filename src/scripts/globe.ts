// The photo globe: one instanced mesh of square tiles, textured from an atlas of
// the grid thumbnails. One progress value drives everything in the vertex
// shader: the sphere unrolls into a flat sheet, and while it is still
// flattening every tile starts its own flight, in an arc towards the viewer,
// to its grid square. The windows overlap, so the motion never stops halfway.
//
// World units are CSS pixels: the camera is placed so the z = 0 plane maps one
// unit to one pixel, with the origin at the centre of the viewport and y up.
import {
  CanvasTexture,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';

export type Target = { x: number; y: number; size: number; order: number } | null;

export type Frame = {
  p: number; // 0 globe, 1 every tile on its grid square
  vel: number; // speed of p per second, for the motion stretch
  rot: number; // spin around the vertical axis, radians
  tiltX: number;
  tiltY: number;
  intro: number; // fade-in after loading, 0 to 1
  centerY: number; // globe centre offset in pixels (below the header)
  bloom: number; // glow strength, desktop only
  // Pose for the drop-in on load: vertical offset in pixels and squash/stretch.
  offsetY: number;
  scaleX: number;
  scaleY: number;
  backdrop: number; // strength of the floor and glow behind the globe, 0 to 1
  time: number; // seconds, moves the floor and glow
  floorDrop: number; // pixels the floor has sunk while scrolling
  shadowY: number; // height of the globe above the floor during the drop-in, pixels
  shadowScale: number; // squash of the globe, widens its shadow
};

const FOV = 30;

// Globe radius in pixels: as large as fits below the header, leaving a strip of
// floor visible under it.
const globeRadius = (w: number, h: number) => Math.min(w * 0.45, (h - 64) * 0.4);
const PICK = 6; // pixels around a click that still count as a hit
const PICK_SIZE = PICK * 2 + 1;

// Timeline, as shares of p. Unrolling runs over [0, UNROLL]. Copies leave
// between COPY_START and COPY_START + COPY_SPREAD; primaries start between
// FLY_START and FLY_START + FLY_SPREAD (centre of the screen first) and take
// FLY_TIME, so the last one lands at 0.90, before the crossfade to the grid.
const UNROLL = 0.6;

const vertexShader = /* glsl */ `
  #define PI 3.141592653589793
  attribute vec4 aGeo;      // theta, phi, side, photo index
  attribute vec2 aCell;     // atlas cell origin (uv)
  attribute vec4 aTarget;   // grid square: x, y, size, 1 for a primary with a visible square
  attribute float aOrder;   // start of the flight within its window, 0 to 1

  uniform float uR;
  uniform float uRot;
  uniform float uP;
  uniform float uVel;
  uniform float uIntro;
  uniform float uCenterY;
  uniform float uLift;
  uniform float uFx;

  varying vec2 vUv;
  varying vec2 vCell;
  varying float vLight;
  varying float vAlpha;
  varying float vBlur;
  varying float vRim;
  varying float vPhoto;
  varying float vFacing;

  // A point on the surface between sphere (u = 0) and flat sheet (u = 1).
  // Latitude and longitude are bent with a curvature that drops to zero, so the
  // sphere opens into a sinusoidal (equal-area) map, like a peeled globe.
  vec3 surface(float th, float ph, float u) {
    float a = uR * ph;
    float k = (1.0 - u) / uR;
    float y = a;
    float rr = uR;
    if (k > 1e-6) {
      float h = sin(a * k * 0.5);
      y = sin(a * k) / k;
      rr = uR - 2.0 * h * h / k;
    }
    float c = max(cos(ph), 0.04);
    float s = th * uR * c;
    float l = (1.0 - u) / (uR * c);
    float x = s;
    float z = rr;
    if (l > 1e-7) {
      float h = sin(s * l * 0.5);
      x = sin(s * l) / l;
      z = rr - 2.0 * h * h / l;
    }
    return vec3(x, y, z - uR * u);
  }

  float smoother(float t) {
    t = clamp(t, 0.0, 1.0);
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  }

  vec3 rotateAround(vec3 v, vec3 axis, float a) {
    return v * cos(a) + cross(axis, v) * sin(a) + axis * dot(axis, v) * (1.0 - cos(a));
  }

  void main() {
    float th = mod(aGeo.x + uRot + PI, 2.0 * PI) - PI;
    float ph = aGeo.y;
    float side = aGeo.z;
    float photo = aGeo.w;

    // Unroll: the back opens first, the front last, so the globe peels open
    // from its seam.
    float seam = 1.0 - abs(th) / PI;
    float u = smoother(uP / ${UNROLL.toFixed(2)} * 1.3 - seam * 0.3);

    vec3 c = surface(th, ph, u);
    // An orthonormal frame, so tiles stay square while the surface bends.
    vec3 east = normalize(surface(th + 0.002, ph, u) - c);
    vec3 n = normalize(cross(east, surface(th, ph + 0.002, u) - c));
    vec3 north = cross(n, east);

    float intro = mix(0.9, 1.0, uIntro);
    vec3 c1 = c * intro;
    c1.y += uCenterY;
    vec3 local1 = (position.x * east + position.y * north) * side * intro;

    // Each tile has its own window on the timeline.
    float primary = aTarget.w;
    float start = mix(0.24 + aOrder * 0.14, 0.28 + aOrder * 0.24, primary);
    float q = clamp((uP - start) / mix(0.3, 0.38, primary), 0.0, 1.0);
    float qe = smoother(q);
    float arc = sin(q * PI);

    vec3 pos;
    if (primary > 0.5) {
      // A quadratic curve that lifts towards the viewer halfway.
      vec3 c2 = vec3(aTarget.xy, 0.0);
      vec3 ctrl = mix(c1, c2, 0.5) + vec3(0.0, 0.0, uLift);
      vec3 centre = mix(mix(c1, ctrl, qe), mix(ctrl, c2, qe), qe);
      vec3 tangent = normalize(mix(ctrl - c1, c2 - ctrl, qe) + vec3(1e-4));
      vec3 local = mix(local1, vec3(position.xy * aTarget.z, 0.0), qe);
      // A slight turn in flight around a per-photo axis, flat again on landing.
      float a = photo * 2.39996;
      vec3 axis = normalize(vec3(cos(a), sin(a), 0.0));
      local = rotateAround(local, axis, arc * 0.5 * (mod(photo, 2.0) * 2.0 - 1.0));
      // Stretch along the path while moving fast.
      local += tangent * dot(local, tangent) * arc * min(uVel * 0.3, 0.45);
      pos = centre + local;
      n = mix(n, vec3(0.0, 0.0, 1.0), qe);
    } else {
      // Copies drift outward, sink back and fade.
      pos = c1 + local1;
      pos.xy += normalize(c1.xy + vec2(1e-3)) * qe * 120.0;
      pos.z -= qe * 600.0;
    }

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    // Soft key light from the upper left, darker on the far side, plain at the end.
    vec3 vn = normalize(normalMatrix * n);
    float facing = vn.z;
    float key = max(dot(vn, normalize(vec3(-0.35, 0.45, 0.82))), 0.0);
    float depth = clamp((c.z + uR) / (2.0 * uR), 0.0, 1.0);
    float lit = facing < 0.0 ? 0.18 + 0.12 * depth : mix(0.32, 1.0, key) * mix(0.55, 1.0, depth);
    vLight = mix(lit, 1.0, max(u, qe * primary));
    vAlpha = uIntro * (1.0 - qe * (1.0 - primary));
    // Depth blur: the far side of the globe and receding copies go soft.
    vBlur = (1.0 - u) * (1.0 - depth) * 2.5 + qe * (1.0 - primary) * 4.0;
    vRim = arc * primary * uFx;
    vPhoto = photo;
    vFacing = facing;

    vUv = uv;
    vCell = aCell;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec2 uCellSize;
  uniform vec2 uInset;
  varying vec2 vUv;
  varying vec2 vCell;
  varying float vLight;
  varying float vAlpha;
  varying float vBlur;
  varying float vRim;

  void main() {
    if (vAlpha < 0.004) discard;
    vec2 uv = vCell + uInset + vUv * (uCellSize - 2.0 * uInset);
    vec3 col = texture2D(uMap, uv, vBlur).rgb * vLight;
    // A thin light edge on tiles in flight.
    float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
    col += vec3(0.75, 0.85, 1.0) * (1.0 - smoothstep(0.0, 0.035, edge)) * vRim * 0.35;
    gl_FragColor = vec4(col, vAlpha);
  }
`;

// For clicks: each tile drawn in a colour that encodes its photo. The far side
// is left out, so a click between two front tiles hits nothing.
const pickShader = /* glsl */ `
  varying float vPhoto;
  varying float vFacing;
  varying float vAlpha;

  void main() {
    if (vAlpha < 0.5 || vFacing < 0.0) discard;
    float id = vPhoto + 1.0;
    gl_FragColor = vec4(mod(id, 256.0) / 255.0, floor(id / 256.0) / 255.0, 0.0, 1.0);
  }
`;

// The backdrop: one full-screen quad drawn before the tiles. A perspective
// grid floor just under the globe, with a contact shadow that follows the
// drop-in, and two soft glows in the colours of the photos facing the viewer.
const backdropVertex = /* glsl */ `
  varying vec2 vP;
  void main() {
    vP = position.xy * 2.0;
    gl_Position = vec4(vP, 0.999, 1.0);
  }
`;

const backdropFragment = /* glsl */ `
  uniform float uTime;
  uniform float uAmount;
  uniform float uR;
  uniform float uCamZ;
  uniform float uTanH;
  uniform float uAspect;
  uniform float uFloorY;
  uniform float uYaw;
  uniform float uShadowY;
  uniform float uShadowS;
  uniform float uCenterY;
  uniform vec3 uColA;
  uniform vec3 uColB;
  varying vec2 vP;

  float gridLine(vec2 g) {
    vec2 w = abs(fract(g - 0.5) - 0.5) / max(fwidth(g), vec2(1e-4));
    return 1.0 - min(min(w.x, w.y), 1.0);
  }

  void main() {
    vec3 dir = normalize(vec3(vP.x * uTanH * uAspect, vP.y * uTanH, -1.0));
    vec2 px = vec2(vP.x * uAspect, vP.y) * uCamZ * uTanH; // pixels from the centre
    vec3 mid = (uColA + uColB) * 0.5;
    vec3 col = vec3(0.0);
    float shade = 0.0;

    // Two slow glows behind the globe, left and right.
    float t = uTime;
    vec2 ca = vec2(-0.85 + 0.12 * sin(t * 0.21), 0.3 + 0.1 * cos(t * 0.17)) * uR + vec2(0.0, uCenterY);
    vec2 cb = vec2(0.85 + 0.12 * cos(t * 0.19), -0.15 + 0.1 * sin(t * 0.23)) * uR + vec2(0.0, uCenterY);
    col += uColA * exp(-dot(px - ca, px - ca) / (uR * uR * 0.8)) * 0.5;
    col += uColB * exp(-dot(px - cb, px - cb) / (uR * uR * 0.8)) * 0.5;

    // A thin horizon line where the floor meets the dark.
    float horizon = exp(-abs(dir.y) * 70.0) * smoothstep(1.0, 0.2, abs(vP.x));
    col += mix(vec3(0.35, 0.42, 0.55), mid * 1.4, 0.6) * horizon * 0.22;

    if (dir.y < -1e-4) {
      float d = uFloorY / dir.y;
      vec3 hit = vec3(0.0, 0.0, uCamZ) + dir * d;
      vec2 q = hit.xz;
      float c = cos(uYaw);
      float s = sin(uYaw);
      vec2 g = mat2(c, -s, s, c) * q;
      float cell = uR / 3.0;
      g.y += t * cell * 0.25; // drifting towards the viewer
      float minor = gridLine(g / cell);
      float major = gridLine(g / (cell * 4.0));
      float far = exp(-max(0.0, -hit.z) / (uR * 3.5));
      float side = smoothstep(1.0, 0.55, abs(vP.x));
      vec3 lineCol = mix(vec3(0.42, 0.5, 0.64), normalize(mid + 0.02) * 0.9, 0.55);
      col += lineCol * (minor * 0.16 + major * 0.32) * far * side;
      // Light pooling on the floor around the globe, in the photos' colours.
      float pool = exp(-length(q / vec2(1.0, 0.7)) / (uR * 1.1));
      col += mid * pool * 0.22;
      // Contact shadow: smaller, softer and lighter while the globe is in the air.
      float lift = uShadowY / uR;
      vec2 e = q / (uR * vec2(0.85 * uShadowS, 0.45) * (1.0 + lift * 0.6));
      shade = exp(-dot(e, e) * 2.2) * 0.85 / (1.0 + lift * 2.5);
    }

    col *= 1.0 - shade;
    col *= uAmount;
    float a = clamp(max(max(col.r, col.g), col.b), 0.0, 1.0);
    a = max(a, shade * uAmount * 0.9);
    gl_FragColor = vec4(a > 0.0 ? col / a : col, a);
  }
`;

async function loadAtlas(urls: string[], cell: number) {
  const n = urls.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const size = Math.min(cell, Math.floor(4096 / cols), Math.floor(4096 / rows));
  const canvas = document.createElement('canvas');
  canvas.width = cols * size;
  canvas.height = rows * size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await Promise.all(
    urls.map(async (url, i) => {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      try {
        await img.decode();
      } catch {
        return; // a missing thumbnail stays a dark square
      }
      // Thumbnails are square already; cover-crop anyway in case one is not.
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      const sx = (img.naturalWidth - s) / 2;
      const sy = (img.naturalHeight - s) / 2;
      ctx.drawImage(img, sx, sy, s, s, (i % cols) * size, Math.floor(i / cols) * size, size, size);
    }),
  );
  const texture = new CanvasTexture(canvas);
  texture.flipY = false;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 4;
  return { texture, cols, rows, size };
}

export async function createGlobe(canvas: HTMLCanvasElement, thumbs: string[], count: number, cell: number, fx: boolean) {
  const n = thumbs.length;
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  // The shader outputs the thumbnails' own sRGB values; no conversion anywhere,
  // so the landed tiles match the real grid.
  renderer.outputColorSpace = LinearSRGBColorSpace;
  const atlas = await loadAtlas(thumbs, cell);
  atlas.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 1, 10000);

  // Tiles sit in rows of latitude, each row as long as its circle allows, so the
  // globe looks tiled and the unrolled sheet is an orderly map. Every run of n
  // tiles holds each photo once, in a shuffled order so copies do not line up.
  const step = Math.sqrt((4 * Math.PI) / Math.max(count, n)); // tile pitch, radians
  const bands = Math.max(3, Math.round(Math.PI / step));
  const layout: [number, number][] = [];
  for (let k = 0; k < bands; k++) {
    const phi = -Math.PI / 2 + ((k + 0.5) * Math.PI) / bands;
    const m = Math.max(1, Math.round((2 * Math.PI * Math.cos(phi)) / step));
    for (let j = 0; j < m; j++) layout.push([-Math.PI + ((j + 0.5 + (k % 2) * 0.5) * 2 * Math.PI) / m, phi]);
  }
  while (layout.length < n) layout.push([Math.random() * 2 * Math.PI - Math.PI, Math.random() - 0.5]);
  const total = layout.length;
  const pitch = Math.min(step, Math.PI / bands);
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const assign: number[] = [];
  while (assign.length < total) {
    const run = Array.from({ length: n }, (_, j) => j);
    for (let j = n - 1; j > 0; j--) {
      const r = Math.floor(random() * (j + 1));
      [run[j], run[r]] = [run[r], run[j]];
    }
    assign.push(...run);
  }

  const geo = new Float32Array(total * 4);
  const cells = new Float32Array(total * 2);
  const targets = new Float32Array(total * 4);
  const order = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const [theta, phi] = layout[i];
    const photo = assign[i];
    geo.set([theta, phi, 0, photo], i * 4);
    cells.set([(photo % atlas.cols) / atlas.cols, Math.floor(photo / atlas.cols) / atlas.rows], i * 2);
    order[i] = random();
  }

  const base = new PlaneGeometry(1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute('position', base.getAttribute('position'));
  geometry.setAttribute('uv', base.getAttribute('uv'));
  const aGeo = new InstancedBufferAttribute(geo, 4);
  const aTarget = new InstancedBufferAttribute(targets, 4);
  const copyOrder = order.slice();
  const aOrder = new InstancedBufferAttribute(order, 1);
  geometry.setAttribute('aGeo', aGeo);
  geometry.setAttribute('aCell', new InstancedBufferAttribute(cells, 2));
  geometry.setAttribute('aTarget', aTarget);
  geometry.setAttribute('aOrder', aOrder);
  geometry.instanceCount = total;

  const uniforms = {
    uMap: { value: atlas.texture },
    uCellSize: { value: [1 / atlas.cols, 1 / atlas.rows] },
    uInset: { value: [1 / (atlas.cols * atlas.size), 1 / (atlas.rows * atlas.size)] },
    uR: { value: 300 },
    uRot: { value: 0 },
    uP: { value: 0 },
    uVel: { value: 0 },
    uLift: { value: 200 },
    uFx: { value: fx ? 1 : 0 },
    uIntro: { value: 0 },
    uCenterY: { value: 0 },
  };
  const material = new ShaderMaterial({ vertexShader, fragmentShader, uniforms, transparent: true, side: DoubleSide });
  const backdropUniforms = {
    uTime: { value: 0 },
    uAmount: { value: 0 },
    uR: { value: 300 },
    uCamZ: { value: 1000 },
    uTanH: { value: Math.tan((FOV * Math.PI) / 360) },
    uAspect: { value: 1 },
    uFloorY: { value: -300 },
    uYaw: { value: 0 },
    uShadowY: { value: 0 },
    uShadowS: { value: 1 },
    uCenterY: { value: 0 },
    uColA: { value: new Vector3(0.25, 0.3, 0.4) },
    uColB: { value: new Vector3(0.25, 0.3, 0.4) },
  };
  const backdropMaterial = new ShaderMaterial({
    vertexShader: backdropVertex,
    fragmentShader: backdropFragment,
    uniforms: backdropUniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const backdrop = new Mesh(new PlaneGeometry(1, 1), backdropMaterial);
  backdrop.frustumCulled = false;
  backdrop.renderOrder = -1;
  scene.add(backdrop);

  // Average colour of each photo, for the glow: the atlas scaled down to 4 by 4
  // pixels per photo, then averaged.
  const colours = new Float32Array(n * 3);
  try {
    const k = 4;
    const small = document.createElement('canvas');
    small.width = atlas.cols * k;
    small.height = atlas.rows * k;
    const sctx = small.getContext('2d', { willReadFrequently: true })!;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(atlas.texture.image as HTMLCanvasElement, 0, 0, small.width, small.height);
    const px = sctx.getImageData(0, 0, small.width, small.height).data;
    for (let i = 0; i < n; i++) {
      const x0 = (i % atlas.cols) * k;
      const y0 = Math.floor(i / atlas.cols) * k;
      for (let y = y0; y < y0 + k; y++)
        for (let x = x0; x < x0 + k; x++)
          for (let c = 0; c < 3; c++) colours[i * 3 + c] += px[(y * small.width + x) * 4 + c] / (255 * k * k);
    }
  } catch {
    colours.fill(0.3); // a tainted or failed canvas leaves the glow neutral
  }
  const glowA = [0.25, 0.3, 0.4];
  const glowB = [0.25, 0.3, 0.4];
  let glowT = 0;

  // The mix of the photos facing the viewer, left half and right half, made a
  // little more colourful and kept at one brightness, eased over about a second.
  function updateGlow(rot: number) {
    const now = performance.now();
    const dt = glowT ? Math.min(0.1, (now - glowT) / 1000) : 1;
    glowT = now;
    // Per side, the most colourful photo near the front sets the colour; an
    // average of many photos would only give a muddy brown.
    const best = [-1, -1];
    const score = [0, 0];
    for (let i = 0; i < total; i++) {
      const th = geo[i * 4] + rot;
      const ph = geo[i * 4 + 1];
      const z = Math.cos(ph) * Math.cos(th);
      if (z <= 0.2) continue;
      const x = Math.cos(ph) * Math.sin(th);
      const photo = geo[i * 4 + 3];
      const r0 = colours[photo * 3];
      const g0 = colours[photo * 3 + 1];
      const b0 = colours[photo * 3 + 2];
      const sc = z * z * (Math.max(r0, g0, b0) - Math.min(r0, g0, b0));
      const side = x < 0 ? 0 : 1;
      if (sc > score[side]) {
        score[side] = sc;
        best[side] = photo;
      }
    }
    const ease = Math.min(1, dt * 1.2);
    [glowA, glowB].forEach((glow, side) => {
      const photo = best[side];
      if (photo < 0) return;
      let c = [0, 1, 2].map((j) => colours[photo * 3 + j]);
      const l = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
      c = c.map((v) => Math.max(0, l + (v - l) * 1.8));
      const top = Math.max(c[0], c[1], c[2]);
      c = top < 0.02 ? [0.25, 0.3, 0.4] : c.map((v) => (v / top) * 0.55);
      for (let j = 0; j < 3; j++) glow[j] += (c[j] - glow[j]) * ease;
    });
    backdropUniforms.uColA.value.set(glowA[0], glowA[1], glowA[2]);
    backdropUniforms.uColB.value.set(glowB[0], glowB[1], glowB[2]);
  }

  const pickMaterial = new ShaderMaterial({ vertexShader, fragmentShader: pickShader, uniforms, side: DoubleSide });
  const pickTarget = new WebGLRenderTarget(PICK_SIZE, PICK_SIZE);
  const pixels = new Uint8Array(PICK_SIZE * PICK_SIZE * 4);
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);

  // PlaneGeometry uv has v = 1 at the top; the atlas is not flipped, so flip v here.
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));

  let width = 1;
  let height = 1;
  let primaries: number[] = [];

  // Desktop only: a bloom pass for the glow, loaded with the rest of the effects.
  let bloom: { composer: { render(): void; setSize(w: number, h: number): void; setPixelRatio(r: number): void }; pass: { strength: number } } | null = null;
  if (fx) {
    try {
      const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
        import('three/examples/jsm/postprocessing/EffectComposer.js'),
        import('three/examples/jsm/postprocessing/RenderPass.js'),
        import('three/examples/jsm/postprocessing/UnrealBloomPass.js'),
        import('three/examples/jsm/postprocessing/OutputPass.js'),
      ]);
      const composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      const pass = new UnrealBloomPass(new Vector2(256, 256), 0, 0.45, 0.82);
      composer.addPass(pass);
      composer.addPass(new OutputPass());
      bloom = { composer, pass };
    } catch {
      bloom = null; // no glow, the rest still works
    }
  }

  function resize(w: number, h: number) {
    width = w;
    height = h;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    if (bloom) {
      bloom.composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      bloom.composer.setSize(w, h);
    }
    camera.aspect = w / h;
    camera.position.set(0, 0, h / 2 / Math.tan((FOV * Math.PI) / 360));
    camera.far = camera.position.z * 4;
    camera.updateProjectionMatrix();
    // The globe fills the space below the header; tiles cover it with small gaps.
    const r = globeRadius(w, h);
    uniforms.uR.value = r;
    backdropUniforms.uR.value = r;
    backdropUniforms.uAspect.value = w / h;
    backdropUniforms.uCamZ.value = camera.position.z;
    uniforms.uLift.value = Math.min(w, h) * 0.5;
    const side = pitch * r * 0.92;
    for (let i = 0; i < total; i++) geo[i * 4 + 2] = side;
    aGeo.needsUpdate = true;
  }

  // For each photo the copy closest to the front becomes the one that flies to
  // the grid, so the paths stay short.
  function pickPrimaries(rot: number) {
    const best: number[] = new Array(n).fill(-1);
    const score: number[] = new Array(n).fill(Infinity);
    for (let i = 0; i < total; i++) {
      const th = ((((geo[i * 4] + rot + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
      const s = Math.abs(th) + Math.abs(geo[i * 4 + 1]) * 0.8;
      const photo = geo[i * 4 + 3];
      if (s < score[photo]) {
        score[photo] = s;
        best[photo] = i;
      }
    }
    primaries = best;
  }

  // Grid squares in viewport pixels (from getBoundingClientRect), null when
  // hidden. `order` (0 to 1) sets when each primary leaves: centre first.
  function setTargets(rects: Target[]) {
    targets.fill(0);
    order.set(copyOrder);
    rects.forEach((r, photo) => {
      const i = primaries[photo];
      if (!r || i === undefined || i < 0) return;
      targets.set([r.x - width / 2, height / 2 - r.y, r.size, 1], i * 4);
      order[i] = r.order;
    });
    aTarget.needsUpdate = true;
    aOrder.needsUpdate = true;
  }

  function render(f: Frame) {
    uniforms.uP.value = f.p;
    uniforms.uVel.value = f.vel;
    uniforms.uRot.value = f.rot;
    uniforms.uIntro.value = f.intro;
    uniforms.uCenterY.value = f.centerY;
    backdrop.visible = f.backdrop > 0.002;
    if (backdrop.visible) {
      updateGlow(f.rot);
      backdropUniforms.uAmount.value = f.backdrop;
      backdropUniforms.uTime.value = f.time % 1000;
      backdropUniforms.uCenterY.value = f.centerY;
      backdropUniforms.uFloorY.value = f.centerY - uniforms.uR.value - 4 - f.floorDrop;
      backdropUniforms.uYaw.value = f.tiltY;
      backdropUniforms.uShadowY.value = Math.max(0, f.shadowY);
      backdropUniforms.uShadowS.value = f.shadowScale;
    }
    mesh.rotation.set(f.tiltX, f.tiltY, 0);
    mesh.position.set(0, f.offsetY, 0);
    mesh.scale.set(f.scaleX, f.scaleY, 1);
    if (bloom && f.bloom > 0.004) {
      bloom.pass.strength = f.bloom;
      bloom.composer.render();
    } else {
      renderer.render(scene, camera);
    }
  }

  // The photo under a point in viewport pixels, as drawn by the last frame, and
  // the size its tile has on screen. A small square around the point is
  // rendered, and the nearest tile in it wins, so a click in the gap between two
  // tiles still lands.
  function pick(x: number, y: number) {
    camera.setViewOffset(width, height, x - PICK, y - PICK, PICK_SIZE, PICK_SIZE);
    mesh.material = pickMaterial;
    const backdropOn = backdrop.visible;
    backdrop.visible = false;
    renderer.setRenderTarget(pickTarget);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(pickTarget, 0, 0, PICK_SIZE, PICK_SIZE, pixels);
    renderer.setRenderTarget(null);
    mesh.material = material;
    backdrop.visible = backdropOn;
    camera.clearViewOffset();
    let photo = -1;
    let best = Infinity;
    for (let i = 0; i < PICK_SIZE * PICK_SIZE; i++) {
      const id = pixels[i * 4] + pixels[i * 4 + 1] * 256 - 1;
      const d = ((i % PICK_SIZE) - PICK) ** 2 + (Math.floor(i / PICK_SIZE) - PICK) ** 2;
      if (id >= 0 && id < n && d < best) {
        best = d;
        photo = id;
      }
    }
    if (photo < 0) return null;
    const z = camera.position.z;
    return { photo, size: (geo[2] * z) / Math.max(1, z - uniforms.uR.value) };
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
    pickMaterial.dispose();
    backdrop.geometry.dispose();
    backdropMaterial.dispose();
    pickTarget.dispose();
    atlas.texture.dispose();
    renderer.dispose();
  }

  return { resize, pickPrimaries, setTargets, render, pick, dispose, renderer };
}

export type Globe = Awaited<ReturnType<typeof createGlobe>>;
