// The globe hero: scroll progress, rolling, drag, following the cursor and the hand-off to
// the grid. The inline script in Hero.astro adds the `hero` class before the
// first paint when the hero should run; Three.js loads after the page.
import type { Globe, Target } from './globe.ts';

const root = document.documentElement;
if (root.classList.contains('hero')) start();

function start() {
  const hero = document.getElementById('hero')!;
  const canvas = document.getElementById('hero-canvas') as HTMLCanvasElement;
  const hint = document.getElementById('hero-hint')!;
  const pauseBtn = document.getElementById('hero-pause') as HTMLButtonElement;
  const tiles = Array.from(document.querySelectorAll<HTMLElement>('#grid .tile'));
  const grid = document.getElementById('grid')!;
  const glowEl = hero.querySelector<HTMLElement>('.hero-glow')!;
  const data = JSON.parse(document.getElementById('gallery-data')!.textContent || '{}') as { photos: { thumbs: string[] }[] };
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const still = () => reduceMotion.matches;
  const phone = window.matchMedia('(max-width: 640px), (pointer: coarse)').matches;
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)');

  if (!data.photos?.length) return stop();

  const ROLL = (2 * Math.PI) / 18; // rolls towards the viewer, one turn per 18 seconds
  const SPRING = 10; // rad/s; the shown progress trails the scroll by a few hundred ms
  const MAX_SPEED = 1.6; // progress per second: a full swipe still takes at least 0.6 s

  let globe: Globe | null = null;
  let heroH = hero.offsetHeight;
  let raf = 0;
  let last = 0;
  let orient: Quat = [0, 0, 0, 1]; // the ball's orientation as it rolls
  let rolled = 0; // distance rolled forward, pixels: moves the floor
  let scrollSpin = 0; // extra roll from scrolling down, rad/s
  let lastP = 0;
  let ballX = 0; // sideways position, pixels, following the cursor
  let ballTarget = 0;
  let spinV = 0; // momentum from a drag around the vertical axis, rad/s
  let spinH = 0; // and around the horizontal axis
  let paused = false; // the pause button: no rolling, the ball rolls back to the centre
  let dragging = false;
  let dragX = 0;
  let dragY = 0;
  let swiping = false;
  let dragH = 0;
  let dragT = 0;
  let dragV = 0;
  let downX = 0;
  let downY = 0;
  let downT = 0;
  let hoverT = 0;
  let backdropT = 0;
  let intro = 0;
  let readyAt = 0;
  let shown = 0; // progress drawn, following the scroll progress through a spring
  let shownV = 0;
  let slow = 0; // count of slow frames while the glow is on
  let glow = true; // switched off for good when the device cannot keep up
  let glowLevel = 1;

  const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const progress = () => (heroH > 0 ? clamp(window.scrollY / heroH) : 1);
  // Same as globeRadius() in globe.ts, which loads later.
  const radius = (w: number, h: number) => Math.min(w * 0.45, (h - 64) * 0.4);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  // Quaternions as [x, y, z, w], enough for rolling.
  type Quat = [number, number, number, number];
  const axisAngle = (x: number, y: number, z: number, a: number): Quat => {
    const s = Math.sin(a / 2);
    return [x * s, y * s, z * s, Math.cos(a / 2)];
  };
  const mul = (a: Quat, b: Quat): Quat => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const normal = (q: Quat): Quat => {
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  };
  const slerp = (a: Quat, b: Quat, t: number): Quat => {
    let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const c = dot < 0 ? (b.map((v) => -v) as Quat) : b;
    dot = Math.abs(dot);
    if (dot > 0.9995) return normal(a.map((v, i) => v + (c[i] - v) * t) as Quat);
    const th = Math.acos(dot);
    const s0 = Math.sin((1 - t) * th) / Math.sin(th);
    const s1 = Math.sin(t * th) / Math.sin(th);
    return a.map((v, i) => v * s0 + c[i] * s1) as Quat;
  };
  // A world-space turn applied to the ball: rolling forward is a turn around
  // -x, rolling right a turn around -z, a sideways drag a turn around y.
  const turn = (q: Quat, x: number, y: number, z: number, a: number) => normal(mul(axisAngle(x, y, z, a), q));
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
      pose.spin = 6 * Math.PI * easeInOut(s); // three forward flips in the air
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
    // Opacities go straight onto the four elements that use them, and only when
    // they change: a variable on the root would restyle the whole page each frame.
    const x = smooth(clamp((shown - 0.9) / 0.06));
    setStyle(canvas, 'opacity', (1 - x).toFixed(3));
    setStyle(glowEl, 'opacity', Math.max(0, 1 - at * 1.6).toFixed(3));
    setStyle(hint, 'opacity', Math.max(0, 1 - at * 8).toFixed(3));
    setStyle(pauseBtn, 'opacity', Math.max(0, 1 - at * 8).toFixed(3));
    setStyle(pauseBtn, 'pointerEvents', at < 0.1 ? 'auto' : 'none');
    setStyle(grid, 'opacity', at < 1 ? Math.min(1, x * 50).toFixed(3) : '');
    setStyle(canvas, 'pointerEvents', p < 0.1 ? 'auto' : 'none');
    return p;
  }

  const written = new WeakMap<HTMLElement, Record<string, string>>();
  function setStyle(el: HTMLElement, prop: 'opacity' | 'pointerEvents', value: string) {
    const seen = written.get(el) ?? {};
    if (seen[prop] === value) return;
    seen[prop] = value;
    written.set(el, seen);
    el.style[prop] = value;
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

    // The ball rolls towards the viewer on the floor and, on desktop, rolls sideways
    // towards the cursor; a drag turns it and throws it. All of it stops while
    // the globe unrolls. Reduce Motion keeps only what follows the visitor's
    // own scrolling and dragging.
    const free = 1 - smooth(clamp(d / 0.06));
    const r = radius(w, h);
    if (!dragging) {
      spinV *= Math.exp(-dt * 2.2);
      spinH *= Math.exp(-dt * 2.2);
      if (Math.abs(spinV) < 1e-3) spinV = 0;
      if (Math.abs(spinH) < 1e-3) spinH = 0;
      if (spinV) orient = turn(orient, 0, 1, 0, spinV * free * dt);
      if (spinH) orient = turn(orient, 1, 0, 0, spinH * free * dt);
    }
    if (moving && intro >= 1 && !paused) {
      const a = ROLL * free * dt;
      // Towards the viewer: the top comes forward and the floor runs away
      // under the ball, the same way the page moves when scrolling down.
      orient = turn(orient, 1, 0, 0, a);
      rolled -= a * r;
    }
    // Scrolling down flicks the ball into a faster roll that fades over about
    // two seconds. It is gone by 20% of the scroll, before the ball opens, and
    // scrolling up gives no kick, so that animation stays as it was.
    if (moving && intro >= 1 && !paused && p > lastP) scrollSpin = Math.min(12, scrollSpin + (p - lastP) * 30);
    lastP = p;
    scrollSpin *= Math.exp(-dt * 1.2);
    const spinRoom = 1 - smooth(clamp(d / 0.2));
    if (scrollSpin > 1e-3 && spinRoom > 0) orient = turn(orient, 1, 0, 0, scrollSpin * dt * spinRoom);
    const reach = Math.max(0, w / 2 - r - 24);
    // Paused, the ball rolls back to the centre and stays there instead of
    // following the cursor.
    const goal = paused ? 0 : clamp(ballTarget, -1, 1) * reach * free;
    let nextX = ballX + (goal - ballX) * Math.min(1, dt * 2.5);
    if (Math.abs(goal - nextX) < 0.1) nextX = goal;
    if (nextX !== ballX) orient = turn(orient, 0, 0, -1, (nextX - ballX) / r);
    ballX = nextX;

    // The drop-in flips the ball forward three times. To unroll, the ball comes
    // back over the first bit of the scroll to rolling straight forward only:
    // a turn around x, along its rows, which the shader takes over.
    const shownQ = turn(orient, 1, 0, 0, pose.spin);
    const upright = smooth(clamp(d / 0.06));
    // Then it turns a quarter turn on screen, rows across, for the wide sheet.
    const tq = clamp((d - 0.06) / 0.16);
    const turnBack = tq * tq * tq * (tq * (tq * 6 - 15) + 10);
    const along = Math.hypot(shownQ[0], shownQ[3]) < 1e-3 ? 0 : 2 * Math.atan2(shownQ[0], shownQ[3]);
    const standing: Quat = [Math.sin(along / 2), 0, 0, Math.cos(along / 2)];
    const isUpright = upright >= 1;
    if (isUpright && introT >= INTRO) orient = standing;

    // Which copy of each photo flies is settled before the targets are set.
    if (d < 0.15) globe.pickPrimaries(isUpright ? along : 0);
    if (d > 0.15) globe.setTargets(tiles.map(rectOf));

    // Glow: a little on the globe, most in mid-flight, none by the hand-off.
    const flight = clamp((d - 0.35) / 0.55);
    // It tapers to nothing by 0.86 instead of being cut off, and when the device
    // is too slow for it, it fades out over half a second rather than vanishing.
    glowLevel += ((glow ? 1 : 0) - glowLevel) * Math.min(1, dt * 4);
    let bloom = (0.12 * (1 - smooth(clamp(d / 0.6))) + 0.3 * Math.sin(Math.PI * flight)) * (moving ? 1 : 0.5);
    bloom *= (1 - smooth(clamp((d - 0.78) / 0.08))) * glowLevel;
    if (bloom < 0.002) bloom = 0;
    // The glow is the only costly part; drop it if frames take longer than ~30 ms.
    if (bloom > 0 && intro >= 1 && glow) {
      slow = dt > 0.034 ? slow + 1 : Math.max(0, slow - 1);
      if (slow > 12) glow = false;
    }

    // Floor and glow behind the globe: there before the globe lands, sunk and
    // gone early in the scroll. Reduce Motion keeps them still.
    if (moving && !paused) backdropT += dt;
    const backdrop = smooth(clamp(introT / 0.35)) * (1 - smooth(clamp(d / 0.3)));

    globe.render({
      p: d,
      backdrop,
      time: backdropT,
      floorDrop: smooth(clamp(d / 0.3)) * h * 0.3,
      shadowY: pose.y * rest,
      shadowScale: 1 + (pose.sx - 1) * rest,
      vel: Math.abs(shownV),
      rot: isUpright ? along : 0,
      quat: isUpright ? [0, 0, 0, 1] : slerp(shownQ, standing, upright),
      upright: isUpright,
      turn: isUpright ? turnBack : 0,
      ballX: ballX * (1 - upright),
      floorZ: rolled,
      intro: 1,
      centerY: -32,
      bloom,
      offsetY: pose.y * rest,
      scaleX: 1 + (pose.sx - 1) * rest,
      scaleY: 1 + (pose.sy - 1) * rest,
    });

    // Nothing to draw behind the open viewer.
    const busy = moving && !paused && Math.min(p, shown) < 1 && !document.hidden && !root.classList.contains('viewer-open');
    const coasting = spinV !== 0 || spinH !== 0 || scrollSpin > 1e-3 || ballX !== goal;
    if (busy || coasting || springing || dragging || intro < 1) raf = requestAnimationFrame(tick);
  }

  // A grid square in viewport pixels, and when its photo leaves: by distance
  // from the screen centre at the end of the hero (the grid is then just under
  // the header), so the flight ripples outward.
  // Grid squares in page coordinates, measured once per layout instead of every
  // frame (reading them each frame forces the browser to lay the page out).
  let boxes: ({ x: number; y: number; size: number } | null)[] | null = null;
  const remeasure = () => (boxes = null);
  new ResizeObserver(remeasure).observe(grid);
  function measure() {
    const sy = window.scrollY;
    boxes = tiles.map((t) => {
      if (t.hidden) return null;
      const r = t.getBoundingClientRect();
      return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 + sy, size: r.width } : null;
    });
    return boxes;
  }
  function rectOf(_t: HTMLElement, i: number): Target {
    const b = (boxes ?? measure())[i];
    if (!b) return null;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const y = b.y - window.scrollY;
    const endY = b.y - heroH;
    const dist = Math.hypot(b.x - w / 2, endY - (h + 64) / 2) / Math.hypot(w / 2, h / 2);
    return { x: b.x, y, size: b.size, order: clamp(dist) };
  }

  // The canvas is sized to the large viewport, so a phone's address bar sliding
  // away does not resize it mid-scroll; only real size changes rebuild it.
  let size = '';
  function resize() {
    heroH = hero.offsetHeight;
    remeasure();
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    if (globe && size !== `${w}x${h}`) {
      size = `${w}x${h}`;
      globe.resize(w, h);
    }
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
  document.addEventListener('gallery:layout', () => {
    remeasure();
    kick();
  });
  document.addEventListener('viewer:closed', kick);

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.setAttribute('aria-pressed', String(paused));
    pauseBtn.setAttribute('aria-label', paused ? 'Play the globe' : 'Pause the globe');
    canvas.classList.toggle('is-paused', paused);
    if (paused) scrollSpin = 0;
    kick();
  });

  hint.addEventListener('click', (e) => {
    e.preventDefault();
    window.scrollTo({ top: heroH, behavior: still() ? 'auto' : 'smooth' });
  });

  // Drag or swipe sideways to spin; vertical swipes still scroll (touch-action: pan-y).
  canvas.addEventListener('pointerdown', (e) => {
    if (progress() >= 0.1) return;
    // Paused on a touch screen the canvas no longer scrolls by itself; a swipe
    // that starts beside the ball still scrolls the page.
    const r0 = radius(canvas.clientWidth, canvas.clientHeight);
    const cx = canvas.clientWidth / 2 + ballX;
    const cy = canvas.clientHeight / 2 + 32;
    swiping = paused && e.pointerType === 'touch' && Math.hypot(e.clientX - cx, e.clientY - cy) > r0 * 1.05;
    dragging = true;
    dragX = e.clientX;
    dragY = e.clientY;
    dragT = performance.now();
    dragV = 0;
    dragH = 0;
    spinV = 0;
    spinH = 0;
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
    if (swiping) {
      window.scrollBy(0, dragY - e.clientY);
      dragX = e.clientX;
      dragY = e.clientY;
      return;
    }
    const now = performance.now();
    const r = radius(canvas.clientWidth, canvas.clientHeight);
    // Sideways turns the ball around its vertical axis, up and down around its
    // horizontal one, so it can be turned to show any photo. On touch screens a
    // vertical swipe scrolls the page unless the ball is paused.
    const dx = (e.clientX - dragX) / r;
    const dy = e.pointerType === 'touch' && !paused ? 0 : (e.clientY - dragY) / r;
    orient = turn(orient, 0, 1, 0, dx);
    if (dy) orient = turn(orient, 1, 0, 0, dy);
    const span = Math.max(0.008, (now - dragT) / 1000);
    dragV = dx / span;
    dragH = dy / span;
    dragX = e.clientX;
    dragY = e.clientY;
    dragT = now;
  });
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    // A release after a pause throws nothing.
    const thrown = !swiping && !still() && performance.now() - dragT <= 80;
    spinV = thrown ? clamp(dragV, -6, 6) : 0;
    spinH = thrown ? clamp(dragH, -6, 6) : 0;
    canvas.classList.remove('is-dragging');
    // A tap or click that barely moved opens the photo under it in the viewer.
    if (e.type === 'pointerup' && Math.hypot(e.clientX - downX, e.clientY - downY) < 8 && performance.now() - downT < 500) {
      spinV = 0;
      spinH = 0;
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

  // On desktop the ball rolls left and right after the cursor.
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !fine.matches || still()) return;
    ballTarget = (e.clientX / window.innerWidth - 0.5) * 2;
    if (progress() < 1) kick();
  });

  sync();

  // Everything starts at once: the thumbnails download while three.js loads.
  // The globe uses the grid's own thumbnails (same file, same format), so each
  // photo is downloaded once; they are made eager so they load right away.
  const boot = async () => {
    try {
      const images = data.photos.map((p, i) => {
        const own = tiles[i]?.querySelector('img');
        if (own) {
          own.loading = 'eager';
          return own;
        }
        const img = new Image();
        img.decoding = 'async';
        img.src = p.thumbs[0];
        return img;
      });
      // Loading ring: three.js counts for 30%, the photos for the rest.
      let decoded = 0;
      let code = 0;
      const loader = document.getElementById('hero-loader');
      const loaderText = document.getElementById('hero-loader-text');
      const showLoad = () => {
        loader?.style.setProperty('--load', (code * 0.3 + (decoded / images.length) * 0.7).toFixed(3));
        if (loaderText) loaderText.textContent = 'Loading';
      };
      images.forEach((img) => {
        const done = () => {
          decoded++;
          showLoad();
        };
        img.decode().then(done, done);
      });
      showLoad();
      const { createGlobe } = await import('./globe.ts');
      code = 1;
      showLoad();
      globe = await createGlobe(canvas, images, phone ? 120 : 220, phone ? 256 : 384, !phone);
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
  boot();
}
