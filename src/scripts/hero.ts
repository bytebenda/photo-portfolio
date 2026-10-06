// The globe hero: scroll progress, spin, drag, cursor tilt and the hand-off to
// the grid. The inline script in Hero.astro adds the `hero` class before the
// first paint when the hero should run; Three.js loads after the page.
import type { Globe, Target } from './globe.ts';

const root = document.documentElement;
if (root.classList.contains('hero')) start();

function start() {
  const hero = document.getElementById('hero')!;
  const canvas = document.getElementById('hero-canvas') as HTMLCanvasElement;
  const hint = document.getElementById('hero-hint')!;
  const tiles = Array.from(document.querySelectorAll<HTMLElement>('#grid .tile'));
  const data = JSON.parse(document.getElementById('gallery-data')!.textContent || '{}') as { photos: { thumbs: string[] }[] };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const still = () => reduceMotion.matches;
  const phone = window.matchMedia('(max-width: 640px), (pointer: coarse)').matches;
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)');

  if (!data.photos?.length) return stop();

  const SPIN = (2 * Math.PI) / 90; // one turn per 90 seconds
  const STAGE1 = 0.55; // share of the scroll spent unrolling the sphere

  let globe: Globe | null = null;
  let heroH = hero.offsetHeight;
  let raf = 0;
  let last = 0;
  let rot = 0;
  let spinV = 0; // momentum from a drag, rad/s
  let dragging = false;
  let dragX = 0;
  let dragT = 0;
  let dragV = 0;
  let tilt = { x: 0, y: 0 };
  let tiltTarget = { x: 0, y: 0 };
  let intro = 0;
  let readyAt = 0;

  const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const progress = () => (heroH > 0 ? clamp(window.scrollY / heroH) : 1);
  const smooth = (t: number) => t * t * (3 - 2 * t);

  // Back to the plain gallery, keeping what is on screen in place.
  function stop() {
    cancelAnimationFrame(raf);
    const y = window.scrollY;
    root.classList.remove('hero', 'hero-on');
    hero.hidden = true;
    window.scrollTo(0, Math.max(0, y - heroH));
    globe?.dispose();
    globe = null;
  }

  function sync() {
    const p = progress();
    root.classList.toggle('hero-on', p < 1);
    root.style.setProperty('--hero-p', p.toFixed(4));
    canvas.style.pointerEvents = p < 0.1 ? 'auto' : 'none';
    return p;
  }

  function kick() {
    if (!raf && globe) {
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }
  }

  function tick(now: number) {
    raf = 0;
    if (!globe) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const p = sync();
    const moving = !still();

    intro = moving ? clamp((now - readyAt) / 900) : 1;
    // The unroll follows the scroll, so it runs with Reduce Motion too; only the
    // motion nobody asked for (spin, tilt, momentum, intro fade) is left out.
    const p1 = clamp(p / STAGE1);
    const p2 = clamp((p - STAGE1) / (1 - STAGE1));

    // Slow spin plus drag momentum; both stop while the globe unrolls, so the
    // seam stays at the back.
    const free = 1 - smooth(clamp(p / 0.1));
    if (!dragging) {
      spinV *= Math.exp(-dt * 2.2);
      rot += ((moving ? SPIN : 0) + spinV) * free * dt;
    }
    tilt.x += (tiltTarget.x - tilt.x) * Math.min(1, dt * 4);
    tilt.y += (tiltTarget.y - tilt.y) * Math.min(1, dt * 4);
    const lean = 1 - smooth(p1);

    if (p < 0.5) globe.pickPrimaries(rot);
    if (p2 > 0) globe.setTargets(tiles.map(rectOf));

    globe.render({
      p1,
      p2,
      rot,
      tiltX: tilt.x * lean,
      tiltY: tilt.y * lean,
      intro: smooth(intro),
      centerY: -32,
    });

    const busy = moving && p < 1 && !document.hidden;
    if (busy || dragging || intro < 1) raf = requestAnimationFrame(tick);
  }

  function rectOf(t: HTMLElement): Target {
    if (t.hidden) return null;
    const r = t.getBoundingClientRect();
    if (!r.width) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, size: r.width };
  }

  function resize() {
    heroH = hero.offsetHeight;
    globe?.resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
    sync();
    kick();
  }

  window.addEventListener('scroll', () => {
    sync();
    kick();
  }, { passive: true });
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', kick);
  reduceMotion.addEventListener('change', kick);
  document.addEventListener('gallery:layout', kick);

  hint.addEventListener('click', (e) => {
    e.preventDefault();
    window.scrollTo({ top: heroH, behavior: still() ? 'auto' : 'smooth' });
  });

  // Drag or swipe sideways to spin; vertical swipes still scroll (touch-action: pan-y).
  canvas.addEventListener('pointerdown', (e) => {
    if (progress() >= 0.1) return;
    dragging = true;
    dragX = e.clientX;
    dragT = performance.now();
    dragV = 0;
    spinV = 0;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('is-dragging');
    kick();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const now = performance.now();
    const r = Math.min(canvas.clientWidth, canvas.clientHeight - 64) * 0.45;
    const d = (e.clientX - dragX) / r;
    rot += d;
    dragV = d / Math.max(0.008, (now - dragT) / 1000);
    dragX = e.clientX;
    dragT = now;
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    // A release after a pause throws nothing.
    spinV = still() || performance.now() - dragT > 80 ? 0 : clamp(dragV, -6, 6);
    canvas.classList.remove('is-dragging');
    kick();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // On desktop the globe leans a little towards the cursor.
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !fine.matches || still()) return;
    tiltTarget = { x: (e.clientY / window.innerHeight - 0.5) * 0.3, y: (e.clientX / window.innerWidth - 0.5) * 0.3 };
    if (progress() < 1) kick();
  });

  sync();

  const boot = async () => {
    try {
      const { createGlobe } = await import('./globe.ts');
      const thumbs = data.photos.map((p) => (phone ? p.thumbs[0] : p.thumbs[p.thumbs.length - 1]));
      globe = await createGlobe(canvas, thumbs, phone ? 120 : 220, phone ? 256 : 512);
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        stop();
      });
      resize();
      readyAt = performance.now();
      root.classList.add('hero-ready');
      kick();
    } catch (err) {
      console.error('Globe hero unavailable', err);
      stop();
    }
  };
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot, { once: true });
}
