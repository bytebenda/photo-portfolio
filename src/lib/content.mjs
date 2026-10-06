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
    const match = item.match === undefined ? [] : Array.isArray(item.match) ? item.match.map(String) : [String(item.match)];
    return [{ id: item.id, label: item.label ?? item.id, match, default: item.default === true }];
  });
}

/* Tags: what decides a photo's categories and style when photos.yaml leaves them out.
   A photo's tags are the keywords stored in the file (XMP dc:subject or IPTC
   Keywords, as Lightroom, Capture One and the Fujifilm app write them), plus, for
   photos from Google Drive, the names of the folders it sits in and the #hashtags
   in its Drive description. A category or style applies when one of its words (id,
   label or "match") appears in a tag as whole words: the keyword "Street" matches
   street, the folder "Zwart-wit Gent" matches black-and-white. */

const tagSlug = (s) =>
  String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const wordsOf = (item) => [...new Set([item.id, item.label, ...item.match].map(tagSlug).filter(Boolean))];
const hasWords = (tag, words) => `-${tag}-`.includes(`-${words}-`);
const HASHTAG = /#[\p{L}\p{N}_-]+/gu;

/** Folder names and description hashtags of a Drive photo, as slugs. */
export function driveTags(d) {
  const folders = (d?.paths ?? []).flat();
  const hashtags = (String(d?.description ?? '').match(HASHTAG) ?? []).map((h) => h.slice(1));
  return [...new Set([...folders, ...hashtags].map(tagSlug).filter(Boolean))];
}

function tagged(tags, list) {
  return list.filter((item) => wordsOf(item).some((w) => tags.some((t) => hasWords(t, w)))).map((item) => item.id);
}

const YEAR_TAG = /(?:^|-)((?:19|20)\d\d)(?=-|$)/;

// What is left of a tag after removing every category and style word and the year:
// "lissabon-2024" leaves "lissabon", "straat" or "analoog-zwart-wit" leave nothing.
function leftover(tag, categories, styles) {
  let rest = `-${tag}-`;
  for (const w of [...categories, ...styles].flatMap(wordsOf).sort((a, b) => b.length - a.length)) {
    while (rest.includes(`-${w}-`)) rest = rest.replace(`-${w}-`, '-');
  }
  return rest.replace(new RegExp(YEAR_TAG.source, 'g'), '').replace(/^-+|-+$/g, '');
}

// Items whose words include one of the tags exactly. Keywords match exactly, so
// "street art" becomes its own category instead of counting as street.
function exactly(tags, list) {
  return list.filter((item) => wordsOf(item).some((w) => tags.includes(w))).map((item) => item.id);
}

/**
 * Categories, style, title and year a photo gets from its keywords and, when it
 * comes from Drive, its folders and description. Fields photos.yaml sets win.
 *   topics: keywords that name categories ("Street", "Travel")
 *   types:  keywords that name the type, i.e. the style ("Type|Film" or "type: film")
 */
export function fromTags({ topics = [], types = [], drive = null }, categories, styles) {
  const topicTags = [...new Set(topics.map(tagSlug).filter(Boolean))];
  const typeTags = [...new Set(types.map(tagSlug).filter(Boolean))];
  const folderTags = driveTags(drive);
  const tags = [...new Set([...topicTags, ...typeTags, ...folderTags])];
  const folderYear = folderTags.map((t) => t.match(YEAR_TAG)).find(Boolean);
  const descriptionLine = String(drive?.description ?? '')
    .split('\n')
    .map((l) => l.replace(HASHTAG, '').trim())
    .find(Boolean);
  // The deepest folder that says more than a category or style, so
  // "Reizen/Lissabon 2024/Straat" gives "Lissabon 2024".
  const longest = [...(drive?.paths ?? [])].sort((a, b) => b.length - a.length)[0] ?? [];
  const folderTitle = [...longest].reverse().find((f) => leftover(tagSlug(f), categories, styles)) ?? null;
  const byKeyword = new Set(exactly(topicTags, categories));
  const byFolder = new Set(tagged(folderTags, categories));
  // One style: a type keyword first, then a specific style word beats the default,
  // so the keywords "film" and "colour" give film.
  const plainStyles = new Set([...exactly(topicTags, styles), ...tagged(folderTags, styles)]);
  const defaultStyle = styles.find((st) => st.default)?.id ?? null;
  return {
    tags,
    categories: categories.filter((c) => byKeyword.has(c.id) || byFolder.has(c.id)).map((c) => c.id),
    style: exactly(typeTags, styles)[0] ?? styles.map((st) => st.id).find((id) => plainStyles.has(id) && id !== defaultStyle) ?? defaultStyle,
    title: descriptionLine ?? folderTitle ?? null,
    year: folderYear ? Number(folderYear[1]) : null,
  };
}

/** Folder words that match no category, style or year, with the number of photos in such folders. */
function unmatchedTags(tagLists, categories, styles) {
  const counts = new Map();
  for (const tags of tagLists) {
    for (const rest of new Set(tags.map((t) => leftover(t, categories, styles)).filter(Boolean))) {
      counts.set(rest, (counts.get(rest) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);
const asText = (v) => (typeof v === 'string' ? v : typeof v?.value === 'string' ? v.value : Array.isArray(v) ? asText(v[0]) : null);

const TYPE_PARENT = /^(type|style|stijl)$/i;
const TYPE_PREFIX = /^(?:type|style|stijl)\s*[:=]\s*(.+)$/i;

/**
 * Capture date, keywords and title stored in the file. The keywords are split:
 * a keyword under a "Type" parent in Lightroom ("Type|Film") or written as
 * "type: film" names the type; parents themselves ("Category") are left out;
 * every other keyword names a category.
 */
async function readMeta(file) {
  try {
    const m = await exifr.parse(file, {
      ifd0: false, ifd1: false, gps: false, interop: false,
      exif: { pick: ['DateTimeOriginal', 'CreateDate'] },
      xmp: true,
      iptc: true,
      reviveValues: false,
    });
    const raw = m?.DateTimeOriginal ?? m?.CreateDate;
    const taken = typeof raw === 'string' && /^\d{4}/.test(raw) ? raw : null;
    const keywords = [...new Set([...asList(m?.subject), ...asList(m?.Keywords)].map((k) => String(k).trim()).filter(Boolean))];
    const title = (asText(m?.title) ?? asText(m?.ObjectName))?.trim() || null;
    const tree = asList(m?.hierarchicalSubject).map((h) => String(h).split('|').map((x) => x.trim()).filter(Boolean)).filter((x) => x.length);
    const parents = new Set(tree.flatMap((x) => x.slice(0, -1)).map(tagSlug));
    const types = [];
    for (const x of tree) if (x.length > 1 && TYPE_PARENT.test(x[0])) types.push(x[x.length - 1]);
    const typeSlugs = new Set(types.map(tagSlug));
    const topics = [];
    for (const k of keywords) {
      const prefixed = k.match(TYPE_PREFIX);
      if (prefixed) types.push(prefixed[1].trim());
      else if (!parents.has(tagSlug(k)) && !typeSlugs.has(tagSlug(k))) topics.push(k);
    }
    return { taken, year: taken ? Number(taken.slice(0, 4)) : null, keywords, topics, types: [...new Set(types)], title };
  } catch {
    return { taken: null, year: null, keywords: [], topics: [], types: [], title: null };
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
  const driveList = (await readYaml('drive.yaml', [])) ?? [];
  if (!Array.isArray(driveList)) throw new ContentError(['drive.yaml must be a list, run "npm run import" to make it again']);
  const driveByFile = new Map(driveList.filter((d) => d && typeof d.file === 'string').map((d) => [d.file, d]));

  let onDisk = [];
  try {
    onDisk = (await readdir(PHOTOS_DIR)).filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase())).sort();
  } catch {
    warnings.push('content/photos/ does not exist yet');
  }

  const slugs = new Map();
  const listed = new Set();
  const draft = [];

  // Keywords, title and capture date of every photo, read once.
  const metaByFile = new Map(await Promise.all(onDisk.map(async (f) => [f, await readMeta(path.join(PHOTOS_DIR, f))])));

  // The filters follow the keywords: a keyword that is no known category or style
  // becomes a category, a type that is no known style becomes a style. Labels keep
  // the keyword's spelling; categories.yaml and styles.yaml only add order, labels
  // and extra words. content/keywords.yaml lists keywords to leave out.
  const keywordConfig = (await readYaml('keywords.yaml', {})) ?? {};
  const ignored = new Set(asList(keywordConfig.ignore).map(tagSlug));
  for (const m of metaByFile.values()) {
    m.topics = m.topics.filter((k) => !ignored.has(tagSlug(k)));
    m.types = m.types.filter((k) => !ignored.has(tagSlug(k)));
  }
  const label = (k) => k.charAt(0).toUpperCase() + k.slice(1);
  const fromKeywords = new Map();
  const added = (list, k, kind) => {
    const id = tagSlug(k);
    const known = fromKeywords.get(`${kind}:${id}`);
    if (known) return known.count++;
    const item = { id, label: label(k), match: [], default: false };
    fromKeywords.set(`${kind}:${id}`, { item, kind, count: 1 });
    list.push(item);
  };
  const newStyles = [];
  const newCategories = [];
  for (const m of metaByFile.values()) {
    for (const t of m.types) {
      const id = tagSlug(t);
      if (id && (fromKeywords.has(`style:${id}`) || !exactly([id], styles).length)) added(newStyles, t, 'style');
    }
  }
  styles.push(...newStyles.sort((a, b) => a.label.localeCompare(b.label)));
  for (const m of metaByFile.values()) {
    for (const k of m.topics) {
      const id = tagSlug(k);
      if (!id || id === UNCATEGORIZED.id || !leftover(id, [], [])) continue;
      if (fromKeywords.has(`category:${id}`) || (!exactly([id], styles).length && !exactly([id], categories).length)) added(newCategories, k, 'category');
    }
  }
  categories.push(...newCategories.sort((a, b) => a.label.localeCompare(b.label)));
  const catIds = categories.map((c) => c.id);
  const styleIds = styles.map((s) => s.id);

  const deriveFor = (f) => fromTags({ topics: metaByFile.get(f)?.topics, types: metaByFile.get(f)?.types, drive: driveByFile.get(f) }, categories, styles);
  const whereFrom = (f) => (driveByFile.has(f) ? 'keyword or folder name' : 'keyword');

  entries.forEach((e, i) => {
    const where = `photos.yaml entry ${i + 1}${e?.file ? ` (${e.file})` : ''}`;
    if (!e || typeof e.file !== 'string') {
      errors.push(`${where}: missing "file"`);
      return;
    }
    listed.add(e.file);
    if (!onDisk.includes(e.file)) errors.push(`${where}: file not found in content/photos/`);

    // Categories and style left out here come from the photo's keywords and folders.
    const derived = deriveFor(e.file);
    const meta = metaByFile.get(e.file);
    let cats = asList(e.categories);
    for (const c of cats) {
      if (!catIds.includes(c)) {
        const hint = closest(c, catIds);
        errors.push(`${where}: unknown category "${c}"${hint ? `, did you mean "${hint}"?` : ''}`);
      }
    }
    if (!cats.length) {
      cats = derived.categories.length ? derived.categories : [UNCATEGORIZED.id];
      if (!derived.categories.length) warnings.push(`${where}: no categories set and no ${whereFrom(e.file)} matches one, shown under Uncategorized`);
    }
    const style = e.style ?? derived.style;
    if (!style) errors.push(`${where}: missing "style" (or mark one style default: true in styles.yaml)`);
    else if (!styleIds.includes(style)) {
      const hint = closest(style, styleIds);
      errors.push(`${where}: unknown style "${style}"${hint ? `, did you mean "${hint}"?` : ''}`);
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
    const title = e.title ?? meta?.title ?? derived.title;
    if (!title) warnings.push(`${where}: no title, the file name is used as alt text`);

    draft.push({
      file: e.file,
      slug,
      title: title ?? slugify(e.file).replace(/-/g, ' '),
      categories: cats,
      style,
      year: e.year ?? meta?.year ?? derived.year,
      focus,
      keywords: meta?.keywords ?? [],
      tags: derived.tags,
      ...(driveByFile.has(e.file) ? { drive: { id: driveByFile.get(e.file).id } } : {}),
    });
  });

  // Photos without an entry in photos.yaml come after the listed ones, newest first,
  // with categories, style and title from their keywords (and Drive folders).
  const rest = onDisk
    .filter((f) => !listed.has(f))
    .sort((a, b) => String(metaByFile.get(b)?.taken ?? '').localeCompare(String(metaByFile.get(a)?.taken ?? '')) || a.localeCompare(b));
  for (const f of rest) {
    const derived = deriveFor(f);
    const meta = metaByFile.get(f);
    let slug = slugify(f);
    while (slugs.has(slug)) slug += '-1';
    slugs.set(slug, f);
    if (!derived.categories.length) warnings.push(`${f}: no ${whereFrom(f)} matches a category, shown under Uncategorized`);
    draft.push({
      file: f,
      slug,
      title: meta?.title ?? derived.title ?? slugify(f).replace(/-/g, ' '),
      categories: derived.categories.length ? derived.categories : [UNCATEGORIZED.id],
      style: derived.style,
      year: meta?.year ?? derived.year,
      focus: [0.5, 0.5],
      keywords: meta?.keywords ?? [],
      tags: derived.tags,
      ...(driveByFile.has(f) ? { drive: { id: driveByFile.get(f).id } } : {}),
    });
  }
  for (const d of driveByFile.values()) {
    if (!onDisk.includes(d.file)) warnings.push(`drive.yaml lists ${d.file}, but it is not in content/photos/: run "npm run import"`);
  }

  // Git LFS pointer files instead of images mean LFS was not fetched (on Vercel: not enabled).
  for (const d of draft) {
    const head = (await readFile(path.join(PHOTOS_DIR, d.file))).subarray(0, 40).toString('latin1');
    if (head.startsWith('version https://git-lfs')) {
      errors.push(`${d.file} is a Git LFS pointer, not an image: run "git lfs pull" or "node scripts/lfs-fetch.mjs"`);
    }
  }

  if (errors.length) throw new ContentError(errors);

  const photos = [];
  for (const d of draft) {
    const abs = path.join(PHOTOS_DIR, d.file);
    const meta = await sharp(abs).metadata();
    const swap = (meta.orientation ?? 1) >= 5;
    const width = swap ? meta.height : meta.width;
    const height = swap ? meta.width : meta.height;
    const year = d.year ?? null;
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
    tagReport: {
      unmatched: unmatchedTags(photos.map((p) => driveTags(driveByFile.get(p.file))), categories, styles),
      fromKeywords: [...fromKeywords.values()].map(({ item, kind, count }) => ({ kind, id: item.id, label: item.label, count })),
    },
    warnings,
  };
  return cache;
}
