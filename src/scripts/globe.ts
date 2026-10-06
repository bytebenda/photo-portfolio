// The photo globe: one instanced mesh of square tiles, textured from an atlas of
// the grid thumbnails. The vertex shader morphs every tile from the sphere to a
// flat sheet (stage 1) and from the sheet to its grid square (stage 2).
//
// World units are CSS pixels: the camera is placed so the z = 0 plane maps one
// unit to one pixel, with the origin at the centre of the viewport and y up.
import {
  CanvasTexture,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearMipmapLinearFilter,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  WebGLRenderer,
} from 'three';

export type Target = { x: number; y: number; size: number } | null;

export type Frame = {
  p1: number; // stage 1, sphere to sheet, 0 to 1
  p2: number; // stage 2, sheet to grid, 0 to 1
  rot: number; // spin around the vertical axis, radians
  tiltX: number;
  tiltY: number;
  intro: number; // fade-in after loading, 0 to 1
  centerY: number; // globe centre offset in pixels (below the header)
};

const FOV = 30;

const vertexShader = /* glsl */ `
  #define PI 3.141592653589793
  attribute vec4 aGeo;      // theta, phi, side, photo index
  attribute vec2 aCell;     // atlas cell origin (uv)
  attribute vec4 aTarget;   // grid square: x, y, size, 1 for a primary with a visible square
  attribute float aOrder;   // stage 2 stagger, 0 to 1

  uniform float uR;
  uniform float uRot;
  uniform float uP1;
  uniform float uP2;
  uniform float uIntro;
  uniform float uCenterY;

  varying vec2 vUv;
  varying vec2 vCell;
  varying float vLight;
  varying float vAlpha;

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

  void main() {
    float th = mod(aGeo.x + uRot + PI, 2.0 * PI) - PI;
    float ph = aGeo.y;
    float side = aGeo.z;

    // The back opens first, the front last: the globe peels open from its seam.
    float seam = 1.0 - abs(th) / PI;
    float u = smoother(uP1 * 1.3 - seam * 0.3);

    vec3 c = surface(th, ph, u);
    // An orthonormal frame, so tiles stay square while the surface bends.
    vec3 east = normalize(surface(th + 0.002, ph, u) - c);
    vec3 n = normalize(cross(east, surface(th, ph + 0.002, u) - c));
    vec3 north = cross(n, east);

    float intro = mix(0.9, 1.0, uIntro);
    vec3 p1 = (c + (position.x * east + position.y * north) * side) * intro;
    p1.y += uCenterY;

    // Stage 2: primaries slide to their grid square, copies sink and fade early
    // so the flight stays readable.
    float primary = aTarget.w;
    float q = mix(smoother((uP2 - aOrder * 0.15) / 0.45), smoother((uP2 - aOrder * 0.3) / 0.7), primary);
    vec3 p2 = vec3(aTarget.xy + position.xy * aTarget.z, 0.0);
    p2.z += sin(q * PI) * 60.0;
    vec3 pos = mix(p1, p2, q * primary);
    pos.z -= q * (1.0 - primary) * 500.0;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;

    // Soft key light from the upper left, darker on the far side, plain at the end.
    vec3 vn = normalize(normalMatrix * n);
    float facing = vn.z;
    float key = max(dot(vn, normalize(vec3(-0.35, 0.45, 0.82))), 0.0);
    float depth = clamp((c.z + uR) / (2.0 * uR), 0.0, 1.0);
    float lit = facing < 0.0 ? 0.18 + 0.12 * depth : mix(0.32, 1.0, key) * mix(0.55, 1.0, depth);
    vLight = mix(lit, 1.0, max(u, q * primary));
    vAlpha = uIntro * (1.0 - q * (1.0 - primary));

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

  void main() {
    if (vAlpha < 0.004) discard;
    vec2 uv = vCell + uInset + vUv * (uCellSize - 2.0 * uInset);
    vec3 col = texture2D(uMap, uv).rgb * vLight;
    gl_FragColor = vec4(col, vAlpha);
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

export async function createGlobe(canvas: HTMLCanvasElement, thumbs: string[], count: number, cell: number) {
  const n = thumbs.length;
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
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
    order[i] = n > 1 ? photo / (n - 1) : 0;
  }

  const base = new PlaneGeometry(1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute('position', base.getAttribute('position'));
  geometry.setAttribute('uv', base.getAttribute('uv'));
  const aGeo = new InstancedBufferAttribute(geo, 4);
  const aTarget = new InstancedBufferAttribute(targets, 4);
  geometry.setAttribute('aGeo', aGeo);
  geometry.setAttribute('aCell', new InstancedBufferAttribute(cells, 2));
  geometry.setAttribute('aTarget', aTarget);
  geometry.setAttribute('aOrder', new InstancedBufferAttribute(order, 1));
  geometry.instanceCount = total;

  const uniforms = {
    uMap: { value: atlas.texture },
    uCellSize: { value: [1 / atlas.cols, 1 / atlas.rows] },
    uInset: { value: [1 / (atlas.cols * atlas.size), 1 / (atlas.rows * atlas.size)] },
    uR: { value: 300 },
    uRot: { value: 0 },
    uP1: { value: 0 },
    uP2: { value: 0 },
    uIntro: { value: 0 },
    uCenterY: { value: 0 },
  };
  const material = new ShaderMaterial({ vertexShader, fragmentShader, uniforms, transparent: true, side: DoubleSide });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);

  // PlaneGeometry uv has v = 1 at the top; the atlas is not flipped, so flip v here.
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));

  let width = 1;
  let height = 1;
  let primaries: number[] = [];

  function resize(w: number, h: number) {
    width = w;
    height = h;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.set(0, 0, h / 2 / Math.tan((FOV * Math.PI) / 360));
    camera.far = camera.position.z * 4;
    camera.updateProjectionMatrix();
    // The globe fills the space below the header; tiles cover it with small gaps.
    const r = Math.min(w, h - 64) * 0.45;
    uniforms.uR.value = r;
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

  // Grid squares in viewport pixels (from getBoundingClientRect), null when hidden.
  function setTargets(rects: Target[]) {
    targets.fill(0);
    rects.forEach((r, photo) => {
      const i = primaries[photo];
      if (!r || i === undefined || i < 0) return;
      targets.set([r.x - width / 2, height / 2 - r.y, r.size, 1], i * 4);
    });
    aTarget.needsUpdate = true;
  }

  function render(f: Frame) {
    uniforms.uP1.value = f.p1;
    uniforms.uP2.value = f.p2;
    uniforms.uRot.value = f.rot;
    uniforms.uIntro.value = f.intro;
    uniforms.uCenterY.value = f.centerY;
    mesh.rotation.set(f.tiltX, f.tiltY, 0);
    renderer.render(scene, camera);
  }

  function dispose() {
    geometry.dispose();
    material.dispose();
    atlas.texture.dispose();
    renderer.dispose();
  }

  return { resize, pickPrimaries, setTargets, render, dispose, renderer };
}

export type Globe = Awaited<ReturnType<typeof createGlobe>>;
