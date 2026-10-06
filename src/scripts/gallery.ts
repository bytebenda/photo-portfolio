// All interaction on the page: hiding header, scroll gap, filters, photo viewer.
// No framework: the HTML is rendered at build time and this script enhances it.

type Key = 'loc' | 'cat' | 'year' | 'style';
type Photo = {
  slug: string;
  title: string;
  cat: string[];
  year: string[];
  style: string[];
  loc: string[];
  ar: number;
  focus: [number, number];
  preview: string;
  avif: string;
  webp: string;
  fallback: string;
  camera: string | null;
  lens: string | null;
  place: string | null;
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
const KEYS: Key[] = ['loc', 'cat', 'year', 'style'];
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const motion = () => !reduceMotion.matches;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const header = $<HTMLElement>('header');
const grid = $<HTMLElement>('grid');
const empty = $<HTMLElement>('empty');
const tiles = Array.from(grid.querySelectorAll<HTMLAnchorElement>('.tile'));
const hero = document.getElementById('hero');

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
  hoverReveal = false;
}

// On desktop the hidden header slides in when the cursor reaches the top edge,
// and slides out again once the cursor moves away below it.
let hoverReveal = false;
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
window.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !finePointer.matches || root.classList.contains('viewer-open')) return;
  if (e.clientY <= 24 && header.classList.contains('is-hidden')) {
    setHeaderHidden(false);
    hoverReveal = true;
  } else if (hoverReveal && e.clientY > 96 && !openPanel && window.scrollY >= 10) {
    setHeaderHidden(true);
  }
});

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

    // Over the globe hero the header stays put and the gap stays at rest.
    if (hero && root.classList.contains('hero') && y <= hero.offsetHeight) {
      travel = 0;
      setHeaderHidden(false);
      return;
    }

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

const options: Record<Key, string[]> = { loc: [], cat: [], year: [], style: [] };
for (const g of data.groups) options[g.key] = g.options;

const selected: Record<Key, Set<string>> = { loc: new Set(), cat: new Set(), year: new Set(), style: new Set() };

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
  const s = q.toString().replace(/%2C/g, ',').replace(/%2F/g, '/');
  history.replaceState(history.state, '', `${location.pathname}${s ? `?${s}` : ''}`);
}

const narrowed = (k: Key) => options[k].some((v) => !selected[k].has(v));
// A group restricts the photos only when some, not all, of its options are ticked.
const restricts = (k: Key) => selected[k].size > 0 && narrowed(k);
// Nothing ticked anywhere (after "Deselect all"): no photos.
const noneTicked = () => KEYS.every((k) => !options[k].length || selected[k].size === 0);

// Within a group options combine with OR, across groups with AND.
// A group with every option ticked lets everything through, including photos
// without a value for it (no year, uncategorized). A group with nothing ticked
// is left out, so after "Deselect all" each option ticked adds its photos.
// With `except` (the counts next to the options) the empty state is ignored.
function passes(p: Photo, except?: Key) {
  if (!except && noneTicked()) return false;
  return KEYS.every((k) => k === except || !restricts(k) || p[k].some((v) => selected[k].has(v)));
}

let visible: boolean[] = photos.map(() => true);

// One Filter button opens one panel with a section per group.
const filterEl = document.querySelector<HTMLElement>('.filter')!;
const filterPill = filterEl.querySelector<HTMLElement>('.pill')!;
const filterCount = filterEl.querySelector<HTMLElement>('.pill-count')!;
const sectionEls = Array.from(filterEl.querySelectorAll<HTMLElement>('.filter-section'));
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

// The leaves (places) behind a country checkbox.
const leavesOf = (input: HTMLInputElement) => (input.dataset.leaves ?? '').split(',').filter(Boolean);

function renderFilterUI() {
  const active = KEYS.filter((k) => options[k].length && restricts(k)).length;
  filterPill.classList.toggle('is-narrowed', active > 0);
  filterCount.hidden = active === 0;
  filterCount.textContent = String(active);
  filterPill.setAttribute('aria-label', active ? `Filter, ${active} active` : 'Filter');

  for (const el of sectionEls) {
    const k = el.dataset.group as Key;
    el.querySelectorAll<HTMLLabelElement>('.option').forEach((label) => {
      const input = label.querySelector('input')!;
      const values = input.dataset.country ? leavesOf(input) : [input.value];
      const n = photos.filter((p) => passes(p, k) && p[k].some((v) => values.includes(v))).length;
      const on = values.filter((v) => selected[k].has(v)).length;
      input.checked = on === values.length;
      input.indeterminate = on > 0 && on < values.length;
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
  document.dispatchEvent(new Event('gallery:layout'));
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

filterPill.addEventListener('click', () => setPanel(openPanel === filterEl ? null : filterEl));

for (const el of sectionEls) {
  const k = el.dataset.group as Key;
  el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
    input.addEventListener('change', () => {
      // A country ticks or unticks all its places.
      for (const v of input.dataset.country ? leavesOf(input) : [input.value]) {
        if (input.checked) selected[k].add(v);
        else selected[k].delete(v);
      }
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

function showAll() {
  for (const k of KEYS) selected[k] = new Set(options[k]);
  applyFilters();
  writeQuery();
}
$<HTMLButtonElement>('show-all').addEventListener('click', showAll);
$<HTMLButtonElement>('deselect-all').addEventListener('click', () => {
  for (const k of KEYS) selected[k] = new Set();
  applyFilters();
  writeQuery();
});
$<HTMLButtonElement>('reset').addEventListener('click', showAll);

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
const btnInfo = $<HTMLButtonElement>('viewer-info');
const infoPanel = $<HTMLElement>('info-panel');
const infoPlace = $<HTMLElement>('info-place');
const infoCamera = $<HTMLElement>('info-camera');
const infoLens = $<HTMLElement>('info-lens');

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
  // While the details are open or the photo is zoomed the controls stay visible.
  if (infoOpen || zoom.s > 1) return;
  controlsTimer = window.setTimeout(() => viewer.classList.remove('controls-on'), 2000);
}

/* Photo details: location, camera and lens behind the (i) button. */
let infoOpen = false;
// Rendered open for visitors without JavaScript; with it, the panel starts closed.
infoPanel.hidden = true;

function setInfo(open: boolean) {
  infoOpen = open && !btnInfo.hidden;
  infoPanel.hidden = !infoOpen;
  btnInfo.setAttribute('aria-expanded', String(infoOpen));
  showControls();
}

function fillInfo(p: Photo) {
  const row = (el: HTMLElement, value: string | null) => {
    el.hidden = !value;
    el.querySelector('dd')!.textContent = value ?? '';
  };
  row(infoPlace, p.place);
  row(infoCamera, p.camera);
  row(infoLens, p.lens);
  btnInfo.hidden = !p.place && !p.camera && !p.lens;
  if (btnInfo.hidden && infoOpen) setInfo(false);
  else infoPanel.hidden = !infoOpen;
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
  fillInfo(p);
  resetZoom();
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
  resetZoom();
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
  setInfo(false);
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
btnInfo.addEventListener('click', () => setInfo(!infoOpen));

btnNext.addEventListener('click', (e) => {
  e.preventDefault();
  go(1);
  showControls();
});

viewer.addEventListener('mousemove', showControls, { passive: true });
viewer.addEventListener('focusin', showControls);

/* ------------------------------------------------------------------ */
/* Zoom: pinch on touch screens; plus and minus, trackpad pinch,       */
/* drag, keys and a click on desktop                                   */
/* ------------------------------------------------------------------ */

const zoomEl = $<HTMLElement>('zoom');
const btnZoomIn = $<HTMLButtonElement>('zoom-in');
const btnZoomOut = $<HTMLButtonElement>('zoom-out');
const MAX_ZOOM = 4;
const ZOOM_STEPS = [1, 1.5, 2, 3, 4];
// Scale and translation of the photo inside the stage, in stage pixels.
const zoom = { s: 1, x: 0, y: 0 };

function applyZoom(animate = false) {
  zoomEl.classList.toggle('is-animating', animate && motion());
  zoomEl.style.transform = zoom.s === 1 ? '' : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
  viewer.classList.toggle('is-zoomed', zoom.s > 1);
  btnZoomOut.disabled = zoom.s <= 1;
  btnZoomIn.disabled = zoom.s >= MAX_ZOOM;
}

// Keep the zoomed photo on screen: no empty edge where the photo is larger than
// the screen, centred where it is smaller.
function clampPan() {
  const r = stage.getBoundingClientRect();
  const fit = (pos: number, size: number, start: number, view: number) => {
    const scaled = size * zoom.s;
    if (scaled <= view) return (view - scaled) / 2 - start;
    return Math.min(-start, Math.max(view - start - scaled, pos));
  };
  zoom.x = fit(zoom.x, r.width, r.left, window.innerWidth);
  zoom.y = fit(zoom.y, r.height, r.top, window.innerHeight);
}

// Asks the browser for a larger file once the photo is shown bigger than the screen.
function sharpen() {
  const sizes = `${Math.ceil(Math.max(1, zoom.s) * 100)}vw`;
  if (stageFull.sizes !== sizes) {
    stageFull.sizes = sizes;
    stageAvif.sizes = sizes;
  }
}

/** Zooms to scale s2 around a point given in screen coordinates. */
function zoomAt(s2: number, clientX: number, clientY: number, animate = false) {
  const r = stage.getBoundingClientRect();
  const px = clientX - r.left;
  const py = clientY - r.top;
  const next = Math.min(MAX_ZOOM, Math.max(1, s2));
  zoom.x = px - ((px - zoom.x) * next) / zoom.s;
  zoom.y = py - ((py - zoom.y) * next) / zoom.s;
  zoom.s = next;
  if (zoom.s === 1) zoom.x = zoom.y = 0;
  else clampPan();
  applyZoom(animate);
  showControls();
}

function resetZoom() {
  zoom.s = 1;
  zoom.x = zoom.y = 0;
  applyZoom();
  sharpen();
}

function step(d: number) {
  const next = d > 0 ? ZOOM_STEPS.find((z) => z > zoom.s + 0.01) : [...ZOOM_STEPS].reverse().find((z) => z < zoom.s - 0.01);
  zoomAt(next ?? zoom.s, window.innerWidth / 2, window.innerHeight / 2, true);
  sharpen();
}

btnZoomIn.addEventListener('click', () => step(1));
btnZoomOut.addEventListener('click', () => step(-1));
zoomEl.addEventListener('transitionend', () => zoomEl.classList.remove('is-animating'));
window.addEventListener('resize', () => {
  if (zoom.s > 1) resetZoom();
});

// Trackpad pinch arrives as a wheel event with ctrlKey.
viewer.addEventListener(
  'wheel',
  (e) => {
    if (current === null || !e.ctrlKey) return;
    e.preventDefault();
    zoomAt(zoom.s * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    sharpen();
  },
  { passive: false },
);

// Mouse: drag to pan when zoomed, a click without dragging zooms in at that point.
let drag: { x: number; y: number; zx: number; zy: number; moved: boolean } | null = null;
zoomEl.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse' || e.button !== 0) return;
  e.preventDefault();
  drag = { x: e.clientX, y: e.clientY, zx: zoom.x, zy: zoom.y, moved: false };
  zoomEl.setPointerCapture(e.pointerId);
});
zoomEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  if (zoom.s === 1) return;
  zoomEl.classList.add('is-dragging');
  zoom.x = drag.zx + dx;
  zoom.y = drag.zy + dy;
  clampPan();
  applyZoom();
});
zoomEl.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const clicked = !drag.moved;
  drag = null;
  zoomEl.classList.remove('is-dragging');
  if (clicked && zoom.s === 1) {
    zoomAt(2, e.clientX, e.clientY, true);
    sharpen();
  }
});
zoomEl.addEventListener('pointercancel', () => {
  drag = null;
  zoomEl.classList.remove('is-dragging');
});

/* Touch: swipe left or right for the next photo and down to close; two fingers
   pinch; one finger pans a zoomed photo; a double tap zooms in or out. */
let touchX = 0;
let touchY = 0;
let touchMax = 0; // most fingers on the screen during this gesture
let touchZoomed = false; // the gesture zoomed or panned, so it is no swipe
let lastTap = 0;
let pinch: { cx: number; cy: number; d: number; s: number } | null = null;
let pan: { x: number; y: number; zx: number; zy: number } | null = null;

const distance = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

function startPinch(e: TouchEvent) {
  const [a, b] = [e.touches[0], e.touches[1]];
  const r = stage.getBoundingClientRect();
  const mx = (a.clientX + b.clientX) / 2 - r.left;
  const my = (a.clientY + b.clientY) / 2 - r.top;
  // The point of the photo under the fingers, in unscaled stage pixels.
  pinch = { cx: (mx - zoom.x) / zoom.s, cy: (my - zoom.y) / zoom.s, d: distance(a, b), s: zoom.s };
  pan = null;
  zoomEl.classList.add('is-gesture');
}

viewer.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length === 1) {
      touchMax = 1;
      touchZoomed = zoom.s > 1;
      touchX = e.touches[0].clientX;
      touchY = e.touches[0].clientY;
      pan = zoom.s > 1 ? { x: touchX, y: touchY, zx: zoom.x, zy: zoom.y } : null;
    }
    touchMax = Math.max(touchMax, e.touches.length);
    if (e.touches.length === 2 && current !== null) {
      touchZoomed = true;
      startPinch(e);
    }
    showControls();
  },
  { passive: true },
);

viewer.addEventListener(
  'touchmove',
  (e) => {
    if (pinch && e.touches.length >= 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const r = stage.getBoundingClientRect();
      // Below 1x the photo follows the fingers a little, then springs back.
      const s2 = Math.min(MAX_ZOOM, Math.max(0.8, (pinch.s * distance(a, b)) / pinch.d));
      zoom.s = s2;
      zoom.x = (a.clientX + b.clientX) / 2 - r.left - pinch.cx * s2;
      zoom.y = (a.clientY + b.clientY) / 2 - r.top - pinch.cy * s2;
      zoomEl.classList.remove('is-animating');
      zoomEl.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
    } else if (pan && e.touches.length === 1) {
      zoom.x = pan.zx + e.touches[0].clientX - pan.x;
      zoom.y = pan.zy + e.touches[0].clientY - pan.y;
      clampPan();
      applyZoom();
    }
  },
  { passive: true },
);

viewer.addEventListener('touchend', (e) => {
  if (e.touches.length === 0) zoomEl.classList.remove('is-gesture');
  if (pinch && e.touches.length < 2) {
    pinch = null;
    if (zoom.s < 1.05) resetZoom();
    else {
      clampPan();
      applyZoom(true);
      sharpen();
    }
    showControls();
    // A finger left on the screen continues as a pan.
    if (e.touches.length === 1 && zoom.s > 1) {
      const t = e.touches[0];
      pan = { x: t.clientX, y: t.clientY, zx: zoom.x, zy: zoom.y };
    }
    return;
  }
  if (e.touches.length > 0) return;
  pan = null;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchX;
  const dy = t.clientY - touchY;
  const isTap = touchMax === 1 && Math.hypot(dx, dy) < 10;
  if (isTap && current !== null && (e.target as Element).closest('#zoom')) {
    const now = performance.now();
    if (now - lastTap < 300) {
      lastTap = 0;
      if (zoom.s > 1) {
        zoomAt(1, t.clientX, t.clientY, true);
        sharpen();
      } else {
        zoomAt(2.5, t.clientX, t.clientY, true);
        sharpen();
      }
      return;
    }
    lastTap = now;
  }
  if (touchMax > 1 || touchZoomed || zoom.s > 1) return;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
  else if (dy > 80 && Math.abs(dy) > Math.abs(dx)) closeViewer();
});

document.addEventListener('keydown', (e) => {
  if (current !== null) {
    if (e.key === 'Escape') {
      if (infoOpen) setInfo(false);
      else if (zoom.s > 1) zoomAt(1, 0, 0, true);
      else closeViewer();
    } else if (e.key === 'i' && !e.metaKey && !e.ctrlKey && !e.altKey) setInfo(!infoOpen);
    else if ((e.key === '+' || e.key === '=') && !e.metaKey && !e.ctrlKey) step(1);
    else if (e.key === '-' && !e.metaKey && !e.ctrlKey) step(-1);
    else if (e.key === '0' && !e.metaKey && !e.ctrlKey) zoomAt(1, 0, 0, true);
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'Tab') {
      // Keep focus inside the viewer.
      const zoomButtons = getComputedStyle(btnZoomIn.parentElement!).display === 'none' ? [] : [btnZoomOut, btnZoomIn].filter((b) => !b.disabled);
      const items: HTMLElement[] = [btnClose, btnPrev, btnNext, ...zoomButtons, ...(btnInfo.hidden ? [] : [btnInfo])];
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
