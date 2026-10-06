// The photo globe: one instanced mesh of square tiles, textured from an atlas of
// the grid thumbnails. One progress value drives everything in the vertex
// shader: the sphere unrolls into a flat sheet, and while it is still
// flattening every tile starts its own flight, in an arc towards the viewer,
// to its grid square. The windows overlap, so the motion never stops halfway.
//
// World units are CSS pixels: the camera is placed so the z = 0 plane maps one
// unit to one pixel, with the origin at the centre of the viewport and y up.
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer,
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
  dt: number; // seconds since the last frame, for the sparkles
  spinRate: number; // spin speed in rad/s, signed; sparkles fly off with it
  sparkle: number; // sparkles to emit per second
};

const FOV = 30;

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

// Glitter: small additive stars that fly off the spinning surface, drift down and
// twinkle out. Positions are simulated on the CPU; a few hundred is plenty.
const MAX_SPARKS = 480;

const sparkVertex = /* glsl */ `
  attribute vec3 aInfo;   // size in pixels, alpha, seed
  uniform float uDpr;
  uniform float uCamZ;
  uniform float uTime;
  varying float vAlpha;
  varying float vSeed;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float twinkle = 0.6 + 0.4 * sin(uTime * 17.0 + aInfo.z * 47.0);
    gl_PointSize = aInfo.x * uDpr * uCamZ / max(1.0, -mv.z) * twinkle;
    vAlpha = aInfo.y * twinkle;
    vSeed = aInfo.z;
  }
`;

const sparkFragment = /* glsl */ `
  varying float vAlpha;
  varying float vSeed;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float core = exp(-dot(c, c) * 7.0) * 1.3;
    float rays = max(0.0, 1.0 - abs(c.x) * 7.0) * max(0.0, 1.0 - abs(c.y))
               + max(0.0, 1.0 - abs(c.y) * 7.0) * max(0.0, 1.0 - abs(c.x));
    float a = (core + rays * 0.7) * vAlpha;
    if (a < 0.01) discard;
    vec3 col = mix(vec3(1.0, 0.9, 0.7), vec3(0.85, 0.92, 1.0), fract(vSeed * 7.31));
    gl_FragColor = vec4(col, a);
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
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const sparkPos = new Float32Array(MAX_SPARKS * 3);
  const sparkInfo = new Float32Array(MAX_SPARKS * 3);
  const sparkVel = new Float32Array(MAX_SPARKS * 3);
  const sparkAge = new Float32Array(MAX_SPARKS).fill(1);
  const sparkLife = new Float32Array(MAX_SPARKS).fill(1);
  const sparkSize = new Float32Array(MAX_SPARKS);
  const sparkGeometry = new BufferGeometry();
  const sparkPosAttr = new BufferAttribute(sparkPos, 3);
  const sparkInfoAttr = new BufferAttribute(sparkInfo, 3);
  sparkGeometry.setAttribute('position', sparkPosAttr);
  sparkGeometry.setAttribute('aInfo', sparkInfoAttr);
  const sparkUniforms = { uDpr: { value: 1 }, uCamZ: { value: 1000 }, uTime: { value: 0 } };
  const sparkMaterial = new ShaderMaterial({
    vertexShader: sparkVertex,
    fragmentShader: sparkFragment,
    uniforms: sparkUniforms,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const sparks = new Points(sparkGeometry, sparkMaterial);
  sparks.frustumCulled = false;
  scene.add(sparks);
  let sparkNext = 0;
  let sparkDebt = 0;
  let sparksAlive = 0;
  let clock = 0;

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
    sparkUniforms.uDpr.value = Math.min(window.devicePixelRatio || 1, 2);
    sparkUniforms.uCamZ.value = camera.position.z;
    // The globe fills the space below the header; tiles cover it with small gaps.
    const r = Math.min(w, h - 64) * 0.45;
    uniforms.uR.value = r;
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
    mesh.rotation.set(f.tiltX, f.tiltY, 0);
    mesh.position.set(0, f.offsetY, 0);
    mesh.scale.set(f.scaleX, f.scaleY, 1);
    stepSparks(f);
    if (bloom && f.bloom > 0.004) {
      bloom.pass.strength = f.bloom;
      bloom.composer.render();
    } else {
      renderer.render(scene, camera);
    }
  }

  // Sparks start on the visible side of the globe and leave along the spin
  // (the surface velocity), a little outward, then fall and fade.
  function stepSparks(f: Frame) {
    const dt = Math.min(f.dt, 0.05);
    clock += dt;
    sparkUniforms.uTime.value = clock;
    const r = uniforms.uR.value;
    const cy = uniforms.uCenterY.value + f.offsetY;
    sparkDebt = Math.min(sparkDebt + f.sparkle * dt, 60);
    while (sparkDebt >= 1) {
      sparkDebt -= 1;
      const i = sparkNext;
      sparkNext = (sparkNext + 1) % MAX_SPARKS;
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const ring = Math.sqrt(1 - u * u);
      const nx = ring * Math.cos(a);
      const ny = u;
      const nz = Math.abs(ring * Math.sin(a)) * 0.9 + 0.1; // the side facing the viewer
      const out = 40 + Math.random() * 90;
      sparkPos.set([nx * r * 1.02, cy + ny * r * 1.02, nz * r * 1.02], i * 3);
      sparkVel.set(
        [
          f.spinRate * nz * r * 0.55 + nx * out + (Math.random() - 0.5) * 40,
          ny * out + (Math.random() - 0.3) * 50,
          -f.spinRate * nx * r * 0.55 + nz * out * 0.5,
        ],
        i * 3,
      );
      sparkAge[i] = 0;
      sparkLife[i] = 0.7 + Math.random() * 1.0;
      sparkSize[i] = 12 + Math.random() * 20;
      sparkInfo[i * 3 + 2] = Math.random();
    }
    sparksAlive = 0;
    const drag = Math.exp(-dt * 0.9);
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (sparkAge[i] >= sparkLife[i]) {
        sparkInfo[i * 3 + 1] = 0;
        continue;
      }
      sparksAlive++;
      sparkAge[i] += dt;
      const k = i * 3;
      sparkVel[k] *= drag;
      sparkVel[k + 1] = sparkVel[k + 1] * drag - 140 * dt; // a little gravity
      sparkVel[k + 2] *= drag;
      sparkPos[k] += sparkVel[k] * dt;
      sparkPos[k + 1] += sparkVel[k + 1] * dt;
      sparkPos[k + 2] += sparkVel[k + 2] * dt;
      const t = sparkAge[i] / sparkLife[i];
      sparkInfo[k] = sparkSize[i] * (1 - t * 0.5);
      sparkInfo[k + 1] = Math.min(1, t / 0.12) * (1 - t) * (1 - t);
    }
    sparkPosAttr.needsUpdate = true;
    sparkInfoAttr.needsUpdate = true;
  }

  function dispose() {
    sparkGeometry.dispose();
    sparkMaterial.dispose();
    geometry.dispose();
    material.dispose();
    atlas.texture.dispose();
    renderer.dispose();
  }

  return { resize, pickPrimaries, setTargets, render, dispose, renderer, sparksAlive: () => sparksAlive };
}

export type Globe = Awaited<ReturnType<typeof createGlobe>>;
