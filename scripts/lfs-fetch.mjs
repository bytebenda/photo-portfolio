// Replaces Git LFS pointer files in content/photos/ with the real images.
//
// A build host that clones without Git LFS (Vercel with the LFS setting off)
// gets small text pointers instead of photos. This script downloads the real
// files from the repository's LFS store, checks their SHA-256, and writes them
// in place. When the photos are already real files it does nothing.
//
// The repository comes from Vercel's VERCEL_GIT_REPO_OWNER / VERCEL_GIT_REPO_SLUG,
// or from "repository" in package.json. A private repository needs GITHUB_TOKEN
// (a token with read access to the repository's contents).
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const PHOTOS = path.resolve('content/photos');
const POINTER = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n?$/;

async function repoSlug() {
  const { VERCEL_GIT_REPO_OWNER: owner, VERCEL_GIT_REPO_SLUG: slug } = process.env;
  if (owner && slug) return `${owner}/${slug}`;
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const m = url?.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  return m ? m[1] : null;
}

async function findPointers() {
  let files = [];
  try {
    files = await readdir(PHOTOS);
  } catch {
    return [];
  }
  const pointers = [];
  for (const f of files) {
    const buf = await readFile(path.join(PHOTOS, f));
    if (buf.length > 1024) continue;
    const m = buf.toString('utf8').match(POINTER);
    if (m) pointers.push({ file: f, oid: m[1], size: Number(m[2]) });
  }
  return pointers;
}

const pointers = await findPointers();
if (!pointers.length) process.exit(0);

const repo = await repoSlug();
if (!repo) {
  console.error('lfs-fetch: photos are Git LFS pointers and the GitHub repository is unknown (set "repository" in package.json)');
  process.exit(1);
}

console.log(`lfs-fetch: ${pointers.length} photos are Git LFS pointers, downloading them from ${repo}`);

const headers = { Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Basic ${Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString('base64')}`;

// 1. Ask the LFS server for download links (the standard Git LFS batch API).
const actions = new Map();
try {
  const res = await fetch(`https://github.com/${repo}.git/info/lfs/objects/batch`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: pointers.map((p) => ({ oid: p.oid, size: p.size })) }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  for (const o of (await res.json()).objects ?? []) if (o.actions?.download) actions.set(o.oid, o.actions.download);
} catch (e) {
  console.warn(`lfs-fetch: LFS batch API failed (${e.message}), using media.githubusercontent.com instead`);
}

// 2. Fallback: GitHub serves LFS files of a commit at media.githubusercontent.com.
const ref = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || 'main';
const auth = process.env.GITHUB_TOKEN ? { Authorization: `token ${process.env.GITHUB_TOKEN}` } : {};
const linkFor = (p) =>
  actions.get(p.oid) ?? { href: `https://media.githubusercontent.com/media/${repo}/${ref}/content/photos/${encodeURIComponent(p.file)}`, header: auth };

let failed = 0;
const queue = [...pointers];
async function worker() {
  for (let p = queue.shift(); p; p = queue.shift()) {
    const dl = linkFor(p);
    try {
      let r = await fetch(dl.href, { headers: dl.header ?? {} });
      // A token that does not fit this repository gets a 401 or 404; a public repository works without one.
      if (!r.ok && Object.keys(dl.header ?? {}).length) r = await fetch(dl.href);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const sha = createHash('sha256').update(buf).digest('hex');
      if (sha !== p.oid || buf.length !== p.size) throw new Error('checksum mismatch');
      const target = path.join(PHOTOS, p.file);
      await writeFile(`${target}.part`, buf);
      await rename(`${target}.part`, target);
    } catch (e) {
      failed++;
      console.error(`lfs-fetch: ${p.file}: ${e.message}`);
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

if (failed) {
  console.error('lfs-fetch: for a private repository set GITHUB_TOKEN, or turn on Git LFS in the Vercel project settings');
  process.exit(1);
}
console.log(`lfs-fetch: ${pointers.length} photos downloaded`);
