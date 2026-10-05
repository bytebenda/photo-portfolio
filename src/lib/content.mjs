// Loads and validates everything under content/.
// Shared by the Astro pages, scripts/images.mjs and scripts/check.mjs,
// so `npm run check`, the image step and the build all apply the same rules.
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import YAML from 'yaml';
import sharp from 'sharp';
import exifr from 'exifr';

export const ROOT = process.cwd();
export const CONTENT_DIR = path.join(ROOT, 'content');
export const PHOTOS_DIR = path.join(CONTENT_DIR, 'photos');
export const IMG_OUT_DIR = path.join(ROOT, 'public', 'img');
export const IMG_URL = '/img';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif', '.heic']);

// Output sizes. Thumbnails are square, large versions are sized on the long edge.
export const SIZES = {
  thumb: [400, 800],
  large: [1600, 3000],
  preview: 640, // small full-aspect WebP shown while the large version loads
  og: 1200, // JPEG used as the link preview image
};

export const UNCATEGORIZED = { id: 'uncategorized', label: 'Uncategorized' };

export class ContentError extends Error {
  constructor(errors) {
    super(`Content check failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    this.errors = errors;
  }
}

export function slugify(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function distance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

function closest(value, ids) {
  let best = null, bestD = Infinity;
  for (const id of ids) {
    const dd = distance(String(value), id);
    if (dd < bestD) { best = id; bestD = dd; }
  }
  return best && bestD <= Math.max(3, Math.floor(best.length / 2)) ? best : null;
}

async function readYaml(file, fallback) {
  try {
    const raw = await readFile(path.join(CONTENT_DIR, file), 'utf8');
    return YAML.parse(raw) ?? fallback;
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new ContentError([`${file}: ${e.message}`]);
  }
}

function readList(list, file, errors) {
  if (!Array.isArray(list)) {
    errors.push(`${file} must be a list of { id, label }`);
    return [];
  }
  const seen = new Set();
  return list.flatMap((item, i) => {
    if (!item || typeof item.id !== 'string') {
      errors.push(`${file} entry ${i + 1} has no id`);
      return [];
    }
    if (seen.has(item.id)) errors.push(`${file}: duplicate id "${item.id}"`);
    seen.add(item.id);
    return [{ id: item.id, label: item.label ?? item.id }];
  });
}

async function captureYear(file) {
  try {
    const exif = await exifr.parse(file, { pick: ['DateTimeOriginal', 'CreateDate'], reviveValues: false });
    const raw = exif?.DateTimeOriginal ?? exif?.CreateDate;
    const m = typeof raw === 'string' ? raw.match(/^(\d{4})/) : null;
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function fileHash(file) {
  return createHash('sha1').update(await readFile(file)).digest('hex').slice(0, 8);
}

function sizesFor(longEdge, wanted) {
  // Every wanted size the original can fill, plus the original size itself
  // when it sits between two wanted sizes (a 2400 px original gets 1600 and 2400).
  const fit = wanted.filter((s) => s <= longEdge);
  if (!fit.length || (longEdge > fit[fit.length - 1] && wanted.some((s) => s > longEdge))) fit.push(longEdge);
  return fit;
}

/** The image files a photo needs, with their public URLs. */
export function imageSet(p) {
  const base = `${p.slug}-${p.hash}`;
  const longEdge = Math.max(p.width, p.height);
  const short = Math.min(p.width, p.height);
  const thumbSizes = sizesFor(short, SIZES.thumb);
  const largeSizes = sizesFor(longEdge, SIZES.large);
  const preview = Math.min(SIZES.preview, longEdge);
  const og = Math.min(SIZES.og, longEdge);
  const f = (name) => ({ name, url: `${IMG_URL}/${name}` });
  return {
    thumb: {
      avif: thumbSizes.map((w) => ({ w, ...f(`${base}-t${w}.avif`) })),
      webp: thumbSizes.map((w) => ({ w, ...f(`${base}-t${w}.webp`) })),
    },
    large: {
      avif: largeSizes.map((w) => ({ w, ...f(`${base}-l${w}.avif`) })),
      webp: largeSizes.map((w) => ({ w, ...f(`${base}-l${w}.webp`) })),
    },
    preview: { w: preview, ...f(`${base}-p${preview}.webp`) },
    og: { w: og, ...f(`${base}-og${og}.jpg`) },
  };
}

let cache = null;

/**
 * Reads content/, applies the rules from the spec and returns the photos in grid order.
 * Throws ContentError when a rule that should fail the build is broken.
 */
export async function loadContent({ fresh = false } = {}) {
  if (cache && !fresh) return cache;
  const errors = [];
  const warnings = [];

  const categories = readList(await readYaml('categories.yaml', []), 'categories.yaml', errors);
  const styles = readList(await readYaml('styles.yaml', []), 'styles.yaml', errors);
  const entries = (await readYaml('photos.yaml', [])) ?? [];
  if (!Array.isArray(entries)) throw new ContentError(['photos.yaml must be a list']);

  let onDisk = [];
  try {
    onDisk = (await readdir(PHOTOS_DIR)).filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase())).sort();
  } catch {
    warnings.push('content/photos/ does not exist yet');
  }

  const catIds = categories.map((c) => c.id);
  const styleIds = styles.map((s) => s.id);
  const slugs = new Map();
  const listed = new Set();
  const draft = [];

  entries.forEach((e, i) => {
    const where = `photos.yaml entry ${i + 1}${e?.file ? ` (${e.file})` : ''}`;
    if (!e || typeof e.file !== 'string') {
      errors.push(`${where}: missing "file"`);
      return;
    }
    listed.add(e.file);
    if (!onDisk.includes(e.file)) errors.push(`${where}: file not found in content/photos/`);

    const cats = Array.isArray(e.categories) ? e.categories : e.categories ? [e.categories] : [];
    if (!cats.length) errors.push(`${where}: needs at least one category`);
    for (const c of cats) {
      if (!catIds.includes(c)) {
        const hint = closest(c, catIds);
        errors.push(`${where}: unknown category "${c}"${hint ? `, did you mean "${hint}"?` : ''}`);
      }
    }
    if (!e.style) errors.push(`${where}: missing "style"`);
    else if (!styleIds.includes(e.style)) {
      const hint = closest(e.style, styleIds);
      errors.push(`${where}: unknown style "${e.style}"${hint ? `, did you mean "${hint}"?` : ''}`);
    }

    const slug = slugify(e.slug ?? e.file);
    if (!slug) errors.push(`${where}: slug is empty`);
    if (slugs.has(slug)) errors.push(`${where}: slug "${slug}" is already used by ${slugs.get(slug)}`);
    slugs.set(slug, e.file);

    let focus = [0.5, 0.5];
    if (e.focus !== undefined) {
      const ok = Array.isArray(e.focus) && e.focus.length === 2 && e.focus.every((n) => typeof n === 'number' && n >= 0 && n <= 1);
      if (ok) focus = e.focus;
      else errors.push(`${where}: focus must be [x, y] with values from 0 to 1`);
    }
    if (e.year !== undefined && !Number.isInteger(e.year)) errors.push(`${where}: year must be a whole number`);
    if (!e.title) warnings.push(`${where}: no title, the file name is used as alt text`);

    draft.push({ file: e.file, slug, title: e.title ?? slugify(e.file).replace(/-/g, ' '), categories: cats, style: e.style ?? null, year: e.year ?? null, focus });
  });

  for (const f of onDisk) {
    if (listed.has(f)) continue;
    let slug = slugify(f);
    while (slugs.has(slug)) slug += '-1';
    slugs.set(slug, f);
    warnings.push(`content/photos/${f} has no entry in photos.yaml, shown last under Uncategorized`);
    draft.push({ file: f, slug, title: slugify(f).replace(/-/g, ' '), categories: [UNCATEGORIZED.id], style: null, year: null, focus: [0.5, 0.5], unlisted: true });
  }

  if (errors.length) throw new ContentError(errors);

  const photos = [];
  for (const d of draft) {
    const abs = path.join(PHOTOS_DIR, d.file);
    const meta = await sharp(abs).metadata();
    const swap = (meta.orientation ?? 1) >= 5;
    const width = swap ? meta.height : meta.width;
    const height = swap ? meta.width : meta.height;
    const year = d.year ?? (await captureYear(abs));
    if (year === null) warnings.push(`${d.file}: no capture date in EXIF and no "year" set, the photo has no year`);
    const hash = await fileHash(abs);
    const { mtimeMs } = await stat(abs);
    const p = { ...d, abs, width, height, ar: width / height, year, hash, mtimeMs };
    p.images = imageSet(p);
    photos.push(p);
  }

  const usedCats = new Set(photos.flatMap((p) => p.categories));
  const usedStyles = new Set(photos.map((p) => p.style));
  const years = [...new Set(photos.map((p) => p.year).filter((y) => y !== null))].sort((a, b) => b - a);

  cache = {
    photos,
    categories: [...categories, UNCATEGORIZED].filter((c) => usedCats.has(c.id)),
    styles: styles.filter((s) => usedStyles.has(s.id)),
    years: years.map((y) => ({ id: y, label: String(y) })),
    warnings,
  };
  return cache;
}
