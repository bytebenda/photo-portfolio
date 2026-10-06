// npm run import: copies every photo in a Google Drive folder, including all
// subfolders at any depth, into content/photos/ and records where each one came
// from in content/drive.yaml. The folder names become the photo's tags, which
// content.mjs turns into categories, style and year (see categories.yaml and
// styles.yaml, field "match").
//
// The folder comes from DRIVE_FOLDER (an ID or a folder URL) or driveFolder in
// src/site.config.mjs. Access, one of:
//   GOOGLE_API_KEY          an API key with the Drive API enabled; works when the
//                           folder is shared as "anyone with the link"
//   GOOGLE_SERVICE_ACCOUNT  a service account key (the JSON itself or a path to
//                           the file); works for a private folder shared with the
//                           service account's e-mail address
//
// Unchanged files are skipped (Drive's MD5 checksum), changed files are
// downloaded again, and files that were removed from Drive are removed from
// content/photos/. Photos you added to content/photos/ yourself are never touched.
//
//   node scripts/drive-import.mjs [--dry-run]
import { readFile, writeFile, rename, unlink, access, mkdir } from 'node:fs/promises';
import { createHash, createSign } from 'node:crypto';
import path from 'node:path';
import YAML from 'yaml';
import site from '../src/site.config.mjs';
import { CONTENT_DIR, PHOTOS_DIR, slugify, loadContent, ContentError } from '../src/lib/content.mjs';

const API = 'https://www.googleapis.com/drive/v3';
const MANIFEST = path.join(CONTENT_DIR, 'drive.yaml');
const DRY_RUN = process.argv.includes('--dry-run');
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
// Formats sharp can read with its prebuilt binaries. HEIC and camera RAW files are skipped.
const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/tiff': '.tif', 'image/avif': '.avif' };
const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif']);

const exists = (f) => access(f).then(() => true, () => false);
const fail = (msg) => {
  console.error(`drive-import: ${msg}`);
  process.exit(1);
};

/* ------------------------------------------------------------------ */
/* Access                                                              */
/* ------------------------------------------------------------------ */

async function serviceAccountToken(raw) {
  const key = JSON.parse(raw.trim().startsWith('{') ? raw : await readFile(raw, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/drive.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  });
  if (!res.ok) fail(`service account sign-in failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function makeClient() {
  const { GOOGLE_API_KEY: apiKey, GOOGLE_SERVICE_ACCOUNT: account } = process.env;
  let headers = {};
  let extra = {};
  if (account) headers = { Authorization: `Bearer ${await serviceAccountToken(account)}` };
  else if (apiKey) extra = { key: apiKey };
  else fail('set GOOGLE_API_KEY (folder shared as "anyone with the link") or GOOGLE_SERVICE_ACCOUNT (private folder)');

  return async function drive(route, params = {}, { raw = false } = {}) {
    const q = new URLSearchParams({ supportsAllDrives: 'true', ...params, ...extra });
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${API}/${route}?${q}`, { headers });
      // Drive answers 403 or 429 when requests come in too fast: wait and try again.
      if ((res.status === 429 || res.status === 403 || res.status >= 500) && attempt < 5) {
        const body = res.status === 403 ? await res.text() : '';
        if (res.status !== 403 || /rate|quota/i.test(body)) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
          continue;
        }
        fail(`${route}: HTTP 403 ${body}`);
      }
      if (!res.ok) fail(`${route}: HTTP ${res.status} ${await res.text()}`);
      return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
    }
  };
}

/* ------------------------------------------------------------------ */
/* Walk the folder tree                                                */
/* ------------------------------------------------------------------ */

const FILE_FIELDS = 'id, name, mimeType, md5Checksum, size, description, imageMediaMetadata(time), shortcutDetails';

async function listChildren(drive, folderId) {
  const files = [];
  let pageToken;
  do {
    const page = await drive('files', {
      q: `'${folderId}' in parents and trashed = false`,
      fields: `nextPageToken, files(${FILE_FIELDS})`,
      pageSize: '1000',
      orderBy: 'name',
      includeItemsFromAllDrives: 'true',
      ...(pageToken ? { pageToken } : {}),
    });
    files.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
}

// Every image under the root folder, with the folder path it was found in.
// A shortcut counts as the file or folder it points to.
async function walk(drive, rootId) {
  const images = [];
  const skipped = [];
  const seenFolders = new Set([rootId]);
  const queue = [{ id: rootId, path: [] }];
  while (queue.length) {
    const folder = queue.shift();
    for (let f of await listChildren(drive, folder.id)) {
      if (f.mimeType === SHORTCUT_MIME) {
        const target = f.shortcutDetails?.targetId;
        if (!target) continue;
        const resolved = await drive(`files/${target}`, { fields: FILE_FIELDS });
        // A folder shortcut keeps the name it has in this folder; a file keeps its own name and extension.
        f = resolved.mimeType === FOLDER_MIME ? { ...resolved, name: f.name } : resolved;
      }
      if (f.mimeType === FOLDER_MIME) {
        if (seenFolders.has(f.id)) continue;
        seenFolders.add(f.id);
        queue.push({ id: f.id, path: [...folder.path, f.name] });
      } else if (f.mimeType?.startsWith('image/')) {
        const ext = path.extname(f.name).toLowerCase();
        if (SUPPORTED_EXT.has(ext) || (!ext && EXT_BY_MIME[f.mimeType])) images.push({ ...f, path: folder.path });
        else skipped.push([...folder.path, f.name].join('/'));
      }
    }
  }
  return { images, skipped };
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

function folderId() {
  const raw = process.env.DRIVE_FOLDER || site.driveFolder;
  if (!raw) fail('set DRIVE_FOLDER or driveFolder in src/site.config.mjs');
  return raw.match(/folders\/([\w-]+)/)?.[1] ?? raw.match(/[?&]id=([\w-]+)/)?.[1] ?? raw;
}

async function readManifest() {
  try {
    const list = YAML.parse(await readFile(MANIFEST, 'utf8')) ?? [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

const drive = await makeClient();
const root = folderId();
console.log(`drive-import: reading folder ${root} and all its subfolders`);
const { images, skipped } = await walk(drive, root);

// The same photo in several folders is imported once and gets the tags of every folder.
const byContent = new Map();
for (const img of images) {
  const key = img.md5Checksum ?? img.id;
  const known = byContent.get(key);
  if (known) known.paths.push(img.path);
  else byContent.set(key, { ...img, paths: [img.path] });
}

const previous = await readManifest();
const prevById = new Map(previous.map((m) => [m.id, m]));
const taken = new Set(previous.map((m) => m.file));
const next = [];
const downloads = [];

for (const img of byContent.values()) {
  const prev = prevById.get(img.id);
  let file = prev?.file;
  if (!file) {
    const ext = path.extname(img.name).toLowerCase() || EXT_BY_MIME[img.mimeType];
    const stem = slugify(img.name) || 'photo';
    file = `${stem}${ext}`;
    if (taken.has(file) || (await exists(path.join(PHOTOS_DIR, file)))) file = `${stem}-${img.id.slice(-6).toLowerCase()}${ext}`;
    taken.add(file);
  }
  const entry = {
    file,
    id: img.id,
    md5: img.md5Checksum ?? null,
    paths: img.paths,
    ...(img.description?.trim() ? { description: img.description.trim() } : {}),
    ...(img.imageMediaMetadata?.time ? { taken: img.imageMediaMetadata.time } : {}),
  };
  next.push(entry);
  const onDisk = await exists(path.join(PHOTOS_DIR, file));
  if (!onDisk || !prev || prev.md5 !== entry.md5) downloads.push({ ...entry, size: Number(img.size) || 0, isNew: !prev });
}

const keep = new Set(next.map((m) => m.file));
const removed = previous.filter((m) => !keep.has(m.file));

if (!DRY_RUN) {
  await mkdir(PHOTOS_DIR, { recursive: true });
  let done = 0;
  const queue = [...downloads];
  async function worker() {
    for (let d = queue.shift(); d; d = queue.shift()) {
      const buf = await drive(`files/${d.id}`, { alt: 'media' }, { raw: true });
      if (d.md5 && createHash('md5').update(buf).digest('hex') !== d.md5) fail(`${d.file}: checksum mismatch after download`);
      const target = path.join(PHOTOS_DIR, d.file);
      await writeFile(`${target}.part`, buf);
      await rename(`${target}.part`, target);
      done++;
      if (done % 10 === 0 || done === downloads.length) console.log(`drive-import: ${done}/${downloads.length} downloaded`);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  for (const m of removed) await unlink(path.join(PHOTOS_DIR, m.file)).catch(() => {});

  next.sort((a, b) => a.file.localeCompare(b.file));
  const header = [
    '# Generated by "npm run import" from Google Drive. Do not edit: the next import overwrites it.',
    '# Change titles, categories or the order in photos.yaml, or rename the folders in Drive.',
    '',
  ].join('\n');
  // One line per photo for the folder paths: paths: [[Reizen, Lissabon 2024], [Favorieten]]
  const doc = new YAML.Document(next);
  YAML.visit(doc, { Pair: (_, pair) => void (pair.key?.value === 'paths' && (pair.value.flow = true)) });
  await writeFile(MANIFEST, header + doc.toString());
}

const added = downloads.filter((d) => d.isNew).length;
console.log(
  `drive-import: ${byContent.size} photos in Drive, ${added} new, ${downloads.length - added} updated, ${removed.length} removed${DRY_RUN ? ' (dry run, nothing written)' : ''}`,
);
if (images.length > byContent.size) console.log(`drive-import: ${images.length - byContent.size} duplicates in other folders, imported once`);
for (const s of skipped) console.warn(`warning: skipped ${s}: only JPEG, PNG, WebP, TIFF and AVIF can be used (export HEIC or RAW as JPEG)`);

// Report how the folder names were understood, so missing "match" words are easy to spot.
if (!DRY_RUN) {
  try {
    const { photos, tagReport } = await loadContent({ fresh: true });
    const fromDrive = photos.filter((p) => p.drive);
    const noCat = fromDrive.filter((p) => p.categories.includes('uncategorized'));
    console.log(`drive-import: ${fromDrive.length - noCat.length} of ${fromDrive.length} Drive photos have a category`);
    if (tagReport.unmatched.length) {
      console.log('drive-import: words in folder names that match no category or style (add them to "match" in categories.yaml or styles.yaml, or ignore them):');
      for (const [tag, n] of tagReport.unmatched) console.log(`  ${tag} (${n} ${n === 1 ? 'photo' : 'photos'})`);
    }
  } catch (e) {
    console.error(e instanceof ContentError ? e.message : e);
    process.exit(1);
  }
}
