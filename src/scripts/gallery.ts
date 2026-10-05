// All interaction on the page: hiding header, scroll gap, filters, photo viewer.
// No framework: the HTML is rendered at build time and this script enhances it.

type Key = 'cat' | 'year' | 'style';
type Photo = {
  slug: string;
  title: string;
  cat: string[];
  year: string[];
  style: string[];
  ar: number;
  focus: [number, number];
  preview: string;
  avif: string;
  webp: string;
  fallback: string;
};
type Data = {
  siteTitle: string;
  groups: { key: Key; options: string[] }[];
  photos: Photo[];
  open: string | null;
};

const root = document.documentElement;
root.classList.add('js');

const data: Data = JSON.parse(document.getElementById('gallery-data')!.textContent || '{}');
const photos = data.photos;
const KEYS: Key[] = ['cat', 'year', 'style'];
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const motion = () => !reduceMotion.matches;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const header = $<HTMLElement>('header');
const grid = $<HTMLElement>('grid');
const empty = $<HTMLElement>('empty');
const tiles = Array.from(grid.querySelectorAll<HTMLAnchorElement>('.tile'));

/* ------------------------------------------------------------------ */
/* Hiding header and scroll gap                                        */
/* ------------------------------------------------------------------ */

let lastY = window.scrollY;
let lastT = performance.now();
let travel = 0; // distance scrolled in the current direction
let gap = 2;
let gapVelocity = 0;
let gapTarget = 2;
let raf = 0;
let idleTimer = 0;
const REST_GAP = 2;
const MAX_GAP = 8;

function setHeaderHidden(hidden: boolean) {
  header.classList.toggle('is-hidden', hidden);
}

function stepGap() {
  // Damped spring towards the target gap; settles in about 300 ms.
  gapVelocity += (gapTarget - gap) * 0.18;
  gapVelocity *= 0.72;
  gap += gapVelocity;
  if (gapTarget === REST_GAP && Math.abs(gap - REST_GAP) < 0.02 && Math.abs(gapVelocity) < 0.02) {
    gap = REST_GAP;
    gapVelocity = 0;
    grid.style.setProperty('--gap', `${REST_GAP}px`);
    raf = 0;
    return;
  }
  grid.style.setProperty('--gap', `${gap.toFixed(2)}px`);
  raf = requestAnimationFrame(stepGap);
}
function kickGap() {
  if (!raf) raf = requestAnimationFrame(stepGap);
}

window.addEventListener(
  'scroll',
  () => {
    if (root.classList.contains('viewer-open')) return;
    const y = window.scrollY;
    const t = performance.now();
    const dy = y - lastY;
    const dt = Math.max(1, t - lastT);
    lastY = y;
    lastT = t;

    if (y < 10) {
      travel = 0;
      setHeaderHidden(false);
    } else {
      travel = dy > 0 === travel > 0 ? travel + dy : dy;
      if (travel > 10 && !openPanel) setHeaderHidden(true);
      else if (travel < -10) setHeaderHidden(false);
    }

    if (!motion()) return;
    gapTarget = Math.min(MAX_GAP, REST_GAP + (Math.abs(dy) / dt) * 2.5);
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      gapTarget = REST_GAP;
      kickGap();
    }, 90);
    kickGap();
  },
  { passive: true },
);

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

const options: Record<Key, string[]> = { cat: [], year: [], style: [] };
for (const g of data.groups) options[g.key] = g.options;

const selected: Record<Key, Set<string>> = { cat: new Set(), year: new Set(), style: new Set() };

function readQuery() {
  const q = new URLSearchParams(location.search);
  for (const k of KEYS) {
    const raw = q.get(k);
    selected[k] = new Set(
      raw === null ? options[k] : raw.split(',').filter((v) => options[k].includes(v)),
    );
  }
}

function writeQuery() {
  const q = new URLSearchParams(location.search);
  for (const k of KEYS) {
    if (narrowed(k)) q.set(k, options[k].filter((v) => selected[k].has(v)).join(','));
    else q.delete(k);
  }
  const s = q.toString().replace(/%2C/g, ',');
  history.replaceState(history.state, '', `${location.pathname}${s ? `?${s}` : ''}`);
}

const narrowed = (k: Key) => options[k].some((v) => !selected[k].has(v));

// Within a pill options combine with OR, across pills with AND.
// A pill with every option ticked lets everything through, including photos
// without a value for it (no year, uncategorized).
function passes(p: Photo, except?: Key) {
  return KEYS.every((k) => k === except || !narrowed(k) || p[k].some((v) => selected[k].has(v)));
}

let visible: boolean[] = photos.map(() => true);

const filterEls = Array.from(document.querySelectorAll<HTMLElement>('.filter'));
let openPanel: HTMLElement | null = null;

function setPanel(filter: HTMLElement | null) {
  if (openPanel && openPanel !== filter) {
    openPanel.querySelector('.panel')!.setAttribute('hidden', '');
    openPanel.querySelector('.pill')!.setAttribute('aria-expanded', 'false');
  }
  openPanel = filter;
  if (filter) {
    filter.querySelector('.panel')!.removeAttribute('hidden');
    filter.querySelector('.pill')!.setAttribute('aria-expanded', 'true');
    setHeaderHidden(false);
  }
}

function renderFilterUI() {
  for (const el of filterEls) {
    const k = el.dataset.group as Key;
    const pill = el.querySelector<HTMLElement>('.pill')!;
    const count = el.querySelector<HTMLElement>('.pill-count')!;
    const isNarrowed = narrowed(k);
    pill.classList.toggle('is-narrowed', isNarrowed);
    count.hidden = !isNarrowed;
    count.textContent = String(selected[k].size);
    pill.setAttribute('aria-label', isNarrowed ? `${pill.textContent!.trim()}, ${selected[k].size} selected` : pill.textContent!.trim());

    el.querySelectorAll<HTMLLabelElement>('.option').forEach((label) => {
      const input = label.querySelector('input')!;
      const v = input.value;
      const n = photos.filter((p) => passes(p, k) && p[k].includes(v)).length;
      input.checked = selected[k].has(v);
      label.classList.toggle('is-empty', n === 0);
      label.querySelector('.option-count')!.textContent = String(n);
    });
  }
}

function applyFilters(animate = true) {
  const next = photos.map((p) => passes(p));
  const changed = next.some((v, i) => v !== visible[i]);
  if (changed) {
    if (animate && motion()) flipGrid(next);
    else tiles.forEach((t, i) => (t.hidden = !next[i]));
    visible = next;
  }
  empty.hidden = visible.some(Boolean);
  renderFilterUI();
}

// Removed squares fade out, the remaining squares slide to their new place.
function flipGrid(next: boolean[]) {
  const gridBox = grid.getBoundingClientRect();
  const first = tiles.map((t) => (t.hidden ? null : t.getBoundingClientRect()));

  tiles.forEach((t, i) => {
    if (visible[i] && !next[i]) {
      const r = first[i]!;
      const ghost = t.cloneNode(true) as HTMLElement;
      ghost.classList.add('ghost');
      ghost.removeAttribute('href');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.tabIndex = -1;
      Object.assign(ghost.style, {
        left: `${r.left - gridBox.left}px`,
        top: `${r.top - gridBox.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
      grid.appendChild(ghost);
      ghost.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.96)' }], {
        duration: 200,
        easing: 'ease-out',
        fill: 'forwards',
      }).onfinish = () => ghost.remove();
    }
    t.hidden = !next[i];
  });

  tiles.forEach((t, i) => {
    if (!next[i]) return;
    const last = t.getBoundingClientRect();
    const was = first[i];
    if (was) {
      const dx = was.left - last.left;
      const dy = was.top - last.top;
      if (dx || dy) {
        t.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 300, easing: EASE });
      }
    } else {
      t.animate([{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE });
    }
  });
}

for (const el of filterEls) {
  const k = el.dataset.group as Key;
  const pill = el.querySelector<HTMLButtonElement>('.pill')!;
  pill.addEventListener('click', () => setPanel(openPanel === el ? null : el));
  el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) selected[k].add(input.value);
      else selected[k].delete(input.value);
      applyFilters();
      writeQuery();
    });
  });
  el.querySelector('[data-action="all"]')!.addEventListener('click', () => {
    selected[k] = new Set(options[k]);
    applyFilters();
    writeQuery();
  });
  el.querySelector('[data-action="clear"]')!.addEventListener('click', () => {
    selected[k] = new Set();
    applyFilters();
    writeQuery();
  });
}

$<HTMLButtonElement>('reset').addEventListener('click', () => {
  for (const k of KEYS) selected[k] = new Set(options[k]);
  applyFilters();
  writeQuery();
});

document.addEventListener('click', (e) => {
  if (openPanel && !(e.target as Element).closest('.filter')) setPanel(null);
});

/* ------------------------------------------------------------------ */
/* Photo viewer                                                        */
/* ------------------------------------------------------------------ */

const viewer = $<HTMLElement>('viewer');
const stage = $<HTMLElement>('stage');
const stagePreview = $<HTMLImageElement>('stage-preview');
const stageAvif = $<HTMLSourceElement>('stage-avif');
const stageFull = $<HTMLImageElement>('stage-full');
const btnClose = $<HTMLAnchorElement>('viewer-close');
const btnPrev = $<HTMLAnchorElement>('viewer-prev');
const btnNext = $<HTMLAnchorElement>('viewer-next');

let current: number | null = null;
let controlsTimer = 0;
let animating = false;
const preloaded = new Set<string>();

const bySlug = new Map(photos.map((p, i) => [p.slug, i]));
const photoPath = (p: Photo) => `/photo/${p.slug}${location.search}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function showControls() {
  viewer.classList.add('controls-on');
  window.clearTimeout(controlsTimer);
  controlsTimer = window.setTimeout(() => viewer.classList.remove('controls-on'), 2000);
}

function preloadPreview(i: number) {
  const p = photos[i];
  if (preloaded.has(p.preview)) return;
  preloaded.add(p.preview);
  const img = new Image();
  img.src = p.preview;
}

function preloadFull(i: number) {
  const p = photos[i];
  const key = `full:${p.slug}`;
  if (preloaded.has(key)) return;
  preloaded.add(key);
  // A detached <picture> lets the browser pick the same format and size it will show.
  const pic = document.createElement('picture');
  const s = document.createElement('source');
  s.type = 'image/avif';
  s.srcset = p.avif;
  s.sizes = '100vw';
  const img = document.createElement('img');
  img.srcset = p.webp;
  img.sizes = '100vw';
  img.src = p.fallback;
  pic.append(s, img);
  preloadPreview(i);
}

// Photos the arrows and swipes move through: the ones matching the filters.
function sequence() {
  const list = photos.map((_, i) => i).filter((i) => visible[i]);
  return list.length ? list : photos.map((_, i) => i);
}
function neighbour(i: number, d: number) {
  const list = sequence();
  let pos = list.indexOf(i);
  if (pos < 0) pos = d > 0 ? -1 : 0; // the open photo is filtered out: start from the edge
  return list[(pos + d + list.length) % list.length];
}

function setStagePhoto(i: number) {
  const p = photos[i];
  stage.style.setProperty('--ar', String(p.ar));
  stage.classList.remove('is-loaded');
  stagePreview.src = p.preview;
  stageAvif.srcset = p.avif;
  stageFull.srcset = p.webp;
  stageFull.src = p.fallback;
  stageFull.alt = p.title;
  viewer.setAttribute('aria-label', p.title);
  btnPrev.href = photoPath(photos[neighbour(i, -1)]);
  btnNext.href = photoPath(photos[neighbour(i, 1)]);
  btnClose.href = `/${location.search}`;
  const done = () => {
    if (current === i) stage.classList.add('is-loaded');
  };
  if (stageFull.complete && stageFull.naturalWidth) done();
  else stageFull.onload = done;
  document.title = `${p.title} | ${data.siteTitle}`;
  preloadFull(neighbour(i, 1));
  preloadFull(neighbour(i, -1));
}

// The square in the grid that shows photo i, if it is on screen.
function tileRect(i: number) {
  const t = tiles[i];
  if (!t || t.hidden) return null;
  const r = t.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight || r.width === 0) return null;
  return r;
}

// Keyframes that make the stage look exactly like the grid square:
// scaled down to cover the square and clipped to the same focal crop.
function squareFrame(i: number, from: DOMRect, to: DOMRect): Keyframe {
  const p = photos[i];
  const k = from.width / Math.min(to.width, to.height);
  const side = from.width / k;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  const x0 = clamp(p.focus[0] * to.width - side / 2, to.width - side);
  const y0 = clamp(p.focus[1] * to.height - side / 2, to.height - side);
  const tx = from.left - to.left - x0 * k;
  const ty = from.top - to.top - y0 * k;
  return {
    transform: `translate(${tx}px, ${ty}px) scale(${k})`,
    clipPath: `inset(${y0}px ${to.width - x0 - side}px ${to.height - y0 - side}px ${x0}px)`,
  };
}
const fullFrame: Keyframe = { transform: 'none', clipPath: 'inset(0px 0px 0px 0px)' };

async function openPhoto(i: number, { push = true, animate = true } = {}) {
  if (animating) return;
  const from = animate && motion() ? tileRect(i) : null;
  setPanel(null);
  current = i;
  setStagePhoto(i);
  root.classList.add('viewer-open');
  viewer.hidden = false;
  if (push) history.pushState({ photo: photos[i].slug, fromGrid: true }, '', photoPath(photos[i]));

  if (from) {
    animating = true;
    // Give the small preview a moment to decode so the square does not grow out of nothing.
    await Promise.race([stagePreview.decode().catch(() => {}), sleep(120)]);
    const to = stage.getBoundingClientRect();
    const bg = viewer.querySelector('.viewer-bg')!;
    bg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' });
    await stage.animate([squareFrame(i, from, to), fullFrame], { duration: 340, easing: EASE }).finished;
    animating = false;
  }
  showControls();
  btnClose.focus({ preventScroll: true });
}

async function closeViewer({ fromHistory = false } = {}) {
  if (current === null || animating) return;
  if (!fromHistory) {
    // Opened from the grid: go back, so the back button and the close control agree.
    if (history.state?.fromGrid) {
      history.back();
      return;
    }
    history.replaceState(null, '', `/${location.search}`);
  }
  const i = current;
  const to = motion() ? tileRect(i) : null;
  if (motion()) {
    animating = true;
    const bg = viewer.querySelector('.viewer-bg')!;
    const from = stage.getBoundingClientRect();
    viewer.classList.remove('controls-on');
    if (to) {
      bg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 280, easing: 'ease-in', fill: 'forwards' });
      await stage.animate([fullFrame, squareFrame(i, to, from)], { duration: 300, easing: EASE, fill: 'forwards' }).finished;
    } else {
      await viewer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-out', fill: 'forwards' }).finished;
    }
    viewer.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    animating = false;
  }
  viewer.hidden = true;
  root.classList.remove('viewer-open');
  current = null;
  document.title = data.siteTitle;
  lastY = window.scrollY;
  tiles[i].focus({ preventScroll: true });
}

function go(d: number) {
  if (current === null || animating) return;
  const i = neighbour(current, d);
  current = i;
  setStagePhoto(i);
  history.replaceState({ ...(history.state || {}), photo: photos[i].slug }, '', photoPath(photos[i]));
  if (motion()) {
    stage.animate(
      [
        { opacity: 0, transform: `translateX(${d * 24}px)` },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 240, easing: EASE },
    );
  }
}

tiles.forEach((t, i) => {
  t.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let new-tab clicks through
    e.preventDefault();
    openPhoto(i);
  });
  // Load the small preview as soon as a visitor shows interest, so opening is instant.
  t.addEventListener('pointerenter', () => preloadPreview(i), { passive: true });
  t.addEventListener('touchstart', () => preloadPreview(i), { passive: true });
  t.addEventListener('focus', () => preloadPreview(i));
});

btnClose.addEventListener('click', (e) => {
  e.preventDefault();
  closeViewer();
});
btnPrev.addEventListener('click', (e) => {
  e.preventDefault();
  go(-1);
  showControls();
});
btnNext.addEventListener('click', (e) => {
  e.preventDefault();
  go(1);
  showControls();
});

viewer.addEventListener('mousemove', showControls, { passive: true });
viewer.addEventListener('focusin', showControls);

let touchX = 0;
let touchY = 0;
let touchCount = 0;
viewer.addEventListener(
  'touchstart',
  (e) => {
    touchCount = e.touches.length;
    touchX = e.touches[0].clientX;
    touchY = e.touches[0].clientY;
    showControls();
  },
  { passive: true },
);
viewer.addEventListener('touchend', (e) => {
  if (touchCount > 1) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchX;
  const dy = t.clientY - touchY;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
  else if (dy > 80 && Math.abs(dy) > Math.abs(dx)) closeViewer();
});

document.addEventListener('keydown', (e) => {
  if (current !== null) {
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'Tab') {
      // Keep focus inside the viewer.
      const items = [btnClose, btnPrev, btnNext];
      const at = items.indexOf(document.activeElement as HTMLAnchorElement);
      e.preventDefault();
      items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
    }
    return;
  }
  if (e.key === 'Escape' && openPanel) {
    const pill = openPanel.querySelector<HTMLElement>('.pill')!;
    setPanel(null);
    pill.focus();
  }
});

window.addEventListener('popstate', () => {
  const m = location.pathname.match(/^\/photo\/([^/]+)\/?$/);
  const i = m ? bySlug.get(decodeURIComponent(m[1])) : undefined;
  readQuery();
  applyFilters(false);
  if (i !== undefined) {
    if (current === null) openPhoto(i, { push: false });
    else {
      current = i;
      setStagePhoto(i);
    }
  } else if (current !== null) {
    closeViewer({ fromHistory: true });
  }
});

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

readQuery();
applyFilters(false);

if (data.open !== null && bySlug.has(data.open)) {
  // Direct visit to /photo/<slug>: the page was rendered with the viewer open.
  current = bySlug.get(data.open)!;
  setStagePhoto(current);
  showControls();
}
