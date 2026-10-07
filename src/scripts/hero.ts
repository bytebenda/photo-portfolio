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
  const SPRING = 10; // rad/s; the shown progress trails the scroll by a few hundred ms
  const MAX_SPEED = 1.6; // progress per second: a full swipe still takes at least 0.6 s

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
  let downX = 0;
  let downY = 0;
  let downT = 0;
  let hoverT = 0;
  let backdropT = 0;
  let tilt = { x: 0, y: 0 };
  let tiltTarget = { x: 0, y: 0 };
  let intro = 0;
  let readyAt = 0;
  let shown = 0; // progress drawn, following the scroll progress through a spring
  let shownV = 0;
  let slow = 0; // count of slow frames while the glow is on
  let glow = true; // switched off for good when the device cannot keep up

  const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const progress = () => (heroH > 0 ? clamp(window.scrollY / heroH) : 1);
  // Same as globeRadius() in globe.ts, which loads later.
  const radius = (w: number, h: number) => Math.min(w * 0.45, (h - 64) * 0.4);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  // Drop-in on load: the globe falls in from above, squashes on impact, bounces
  // high while spinning three times, lands with a small second bounce and settles
  // into the slow spin. Times in seconds from the moment the globe is ready.
  const FALL = 0.45;
  const HOP = 0.8;
  const HOP2 = 0.26;
  const INTRO = FALL + HOP + HOP2 + 0.15;
  function introPose(t: number, h: number, r: number) {
    const pose = { y: 0, sx: 1, sy: 1, spin: 0 };
    const squash = (at: number, amount: number) => {
      const k = Math.max(0, 1 - Math.abs(t - at) / 0.08);
      pose.sy -= amount * k;
      pose.sx += amount * 0.6 * k;
    };
    if (t < FALL) {
      const s = t / FALL;
      pose.y = (h / 2 + r + 40) * (1 - s * s); // falling, speeding up
      pose.sy += 0.06 * s * s; // stretched by the speed
      pose.sx -= 0.03 * s * s;
    } else if (t < FALL + HOP) {
      const s = (t - FALL) / HOP;
      pose.y = h * 0.17 * 4 * s * (1 - s);
      pose.spin = 6 * Math.PI * easeInOut(s); // three turns in the air
    } else if (t < FALL + HOP + HOP2) {
      const s = (t - FALL - HOP) / HOP2;
      pose.y = h * 0.04 * 4 * s * (1 - s);
      pose.spin = 6 * Math.PI;
    } else {
      pose.spin = 6 * Math.PI;
    }
    squash(FALL, 0.14);
    squash(FALL + HOP, 0.08);
    squash(FALL + HOP + HOP2, 0.03);
    return pose;
  }

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

  // The canvas stays until the drawn progress has landed, even when a fast swipe
  // is already past the hero. Once every tile has landed (0.9) it fades out over
  // the real grid, which is fully there underneath, by 0.96.
  function sync() {
    const p = progress();
    if (!globe) shown = p;
    const at = Math.min(p, shown);
    root.classList.toggle('hero-on', at < 1);
    // The Filter button comes in when the gallery is nearly there, not only once
    // the scroll is fully past the hero.
    root.classList.toggle('hero-filter', at >= 0.9);
    root.style.setProperty('--hero-p', at.toFixed(4));
    root.style.setProperty('--hero-x', smooth(clamp((shown - 0.9) / 0.06)).toFixed(4));
    canvas.style.pointerEvents = p < 0.1 ? 'auto' : 'none';
    return p;
  }

  // Critically damped spring with a speed limit, in small steps so it stays
  // stable at any frame rate.
  function stepSpring(target: number, dt: number) {
    for (let t = 0; t < dt; t += 1 / 240) {
      const h = Math.min(1 / 240, dt - t);
      shownV += (SPRING * SPRING * (target - shown) - 2 * SPRING * shownV) * h;
      shownV = clamp(shownV, -MAX_SPEED, MAX_SPEED);
      shown += shownV * h;
    }
    if (Math.abs(target - shown) < 1e-4 && Math.abs(shownV) < 1e-3) {
      shown = target;
      shownV = 0;
    }
    return shown !== target;
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
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const p = progress();
    const springing = stepSpring(p, dt);
    sync();
    const moving = !still();
    const d = clamp(shown);

    const introT = moving ? (now - readyAt) / 1000 : INTRO;
    intro = clamp(introT / INTRO);
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    const pose = introPose(introT, h, radius(w, h));
    // Scrolling during the drop-in takes the globe straight to rest.
    const rest = 1 - smooth(clamp(d / 0.08));

    // Slow spin plus drag momentum; both stop while the globe unrolls, so the
    // seam stays at the back. Reduce Motion keeps only what follows the
    // visitor's own scrolling and dragging.
    const free = 1 - smooth(clamp(d / 0.1));
    if (!dragging) {
      spinV *= Math.exp(-dt * 2.2);
      rot += ((moving ? SPIN : 0) + spinV) * free * dt;
    }
    tilt.x += (tiltTarget.x - tilt.x) * Math.min(1, dt * 4);
    tilt.y += (tiltTarget.y - tilt.y) * Math.min(1, dt * 4);
    const lean = 1 - smooth(clamp(d / 0.5));

    const shownRot = rot + pose.spin;

    if (d < 0.2) globe.pickPrimaries(shownRot);
    if (d > 0.15) globe.setTargets(tiles.map(rectOf));

    // Glow: a little on the globe, most in mid-flight, none by the hand-off.
    const flight = clamp((d - 0.15) / 0.75);
    let bloom = (0.12 * (1 - smooth(clamp(d / 0.6))) + 0.3 * Math.sin(Math.PI * flight)) * (moving ? 1 : 0.5);
    if (d >= 0.88 || !glow) bloom = 0;
    // The glow is the only costly part; drop it if frames take longer than ~30 ms.
    if (bloom > 0 && intro >= 1) {
      slow = dt > 0.034 ? slow + 1 : Math.max(0, slow - 1);
      if (slow > 12) glow = false;
    }

    // Floor and glow behind the globe: there before the globe lands, sunk and
    // gone early in the scroll. Reduce Motion keeps them still.
    if (moving) backdropT += dt;
    const backdrop = smooth(clamp(introT / 0.35)) * (1 - smooth(clamp(d / 0.3)));

    globe.render({
      p: d,
      backdrop,
      time: backdropT,
      floorDrop: smooth(clamp(d / 0.3)) * h * 0.3,
      shadowY: pose.y * rest,
      shadowScale: 1 + (pose.sx - 1) * rest,
      vel: Math.abs(shownV),
      rot: shownRot,
      tiltX: tilt.x * lean,
      tiltY: tilt.y * lean,
      intro: 1,
      centerY: -32,
      bloom,
      offsetY: pose.y * rest,
      scaleX: 1 + (pose.sx - 1) * rest,
      scaleY: 1 + (pose.sy - 1) * rest,
    });

    // Nothing to draw behind the open viewer.
    const busy = moving && Math.min(p, shown) < 1 && !document.hidden && !root.classList.contains('viewer-open');
    if (busy || springing || dragging || intro < 1) raf = requestAnimationFrame(tick);
  }

  // A grid square in viewport pixels, and when its photo leaves: by distance
  // from the screen centre at the end of the hero (the grid is then just under
  // the header), so the flight ripples outward.
  function rectOf(t: HTMLElement): Target {
    if (t.hidden) return null;
    const r = t.getBoundingClientRect();
    if (!r.width) return null;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const endY = r.top + r.height / 2 - (heroH - window.scrollY);
    const dist = Math.hypot(r.left + r.width / 2 - w / 2, endY - (h + 64) / 2) / Math.hypot(w / 2, h / 2);
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, size: r.width, order: clamp(dist) };
  }

  function resize() {
    heroH = hero.offsetHeight;
    globe?.resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
    sync();
    kick();
  }

  window.addEventListener('scroll', () => {
    if (!globe) sync();
    kick();
  }, { passive: true });
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', kick);
  reduceMotion.addEventListener('change', kick);
  document.addEventListener('gallery:layout', kick);
  document.addEventListener('viewer:closed', kick);

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
    downX = e.clientX;
    downY = e.clientY;
    downT = dragT;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('is-dragging');
    kick();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) {
      hover(e);
      return;
    }
    const now = performance.now();
    const r = radius(canvas.clientWidth, canvas.clientHeight);
    const d = (e.clientX - dragX) / r;
    rot += d;
    dragV = d / Math.max(0.008, (now - dragT) / 1000);
    dragX = e.clientX;
    dragT = now;
  });
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    // A release after a pause throws nothing.
    spinV = still() || performance.now() - dragT > 80 ? 0 : clamp(dragV, -6, 6);
    canvas.classList.remove('is-dragging');
    // A tap or click that barely moved opens the photo under it in the viewer.
    if (e.type === 'pointerup' && Math.hypot(e.clientX - downX, e.clientY - downY) < 8 && performance.now() - downT < 500) {
      spinV = 0;
      const hit = globe?.pick(e.clientX, e.clientY);
      if (hit) {
        canvas.classList.remove('is-over-photo');
        document.dispatchEvent(new CustomEvent('hero:open', { detail: { index: hit.photo, x: e.clientX, y: e.clientY, size: hit.size } }));
      }
    }
    kick();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // With a mouse the cursor turns into a hand over a photo; checked at most
  // every 80 ms, because each check reads a pixel back from the GPU.
  function hover(e: PointerEvent) {
    if (e.pointerType !== 'mouse' || !globe) return;
    const now = performance.now();
    if (now - hoverT < 80) return;
    hoverT = now;
    canvas.classList.toggle('is-over-photo', globe.pick(e.clientX, e.clientY) !== null);
  }
  canvas.addEventListener('pointerleave', () => canvas.classList.remove('is-over-photo'));

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
      globe = await createGlobe(canvas, thumbs, phone ? 120 : 220, phone ? 256 : 512, !phone);
      shown = progress();
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
