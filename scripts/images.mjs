// Makes every image the site needs from the originals in content/photos/:
// square thumbnails (400, 800), large versions (1600, 3000 on the long edge)
// in AVIF and WebP, a small preview WebP and a JPEG for link previews.
// Files are named after the slug and a hash of the original, so unchanged
// photos are skipped and old versions are removed. Neither the originals nor the
// images are in Git: the workflow keeps both in the GitHub Actions cache, so a run
// only makes the images of new photos. Afterwards content/images.json is updated
// with what the build needs from each original.
import { mkdir, readdir, unlink, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { loadContent, writeSources, ContentError, IMG_OUT_DIR } from '../src/lib/content.mjs';

const exists = (f) => access(f).then(() => true, () => false);

function squareCrop(p) {
  const side = Math.min(p.width, p.height);
  const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(v)));
  return {
    left: clamp(p.focus[0] * p.width - side / 2, p.width - side),
    top: clamp(p.focus[1] * p.height - side / 2, p.height - side),
    width: side,
    height: side,
  };
}

function jobsFor(p) {
  const src = () => sharp(p.abs).rotate();
  const jobs = [];
  const crop = squareCrop(p);
  for (const fmt of ['avif', 'webp']) {
    for (const t of p.images.thumb[fmt]) {
      jobs.push({ name: t.name, run: () => src().extract(crop).resize(t.w, t.w)[fmt](fmt === 'avif' ? { quality: 55 } : { quality: 80 }) });
    }
    for (const l of p.images.large[fmt]) {
      jobs.push({ name: l.name, run: () => src().resize(l.w, l.w, { fit: 'inside', withoutEnlargement: true })[fmt](fmt === 'avif' ? { quality: 60 } : { quality: 84 }) });
    }
  }
  jobs.push({ name: p.images.preview.name, run: () => src().resize(p.images.preview.w, p.images.preview.w, { fit: 'inside' }).webp({ quality: 70 }) });
  jobs.push({ name: p.images.og.name, run: () => src().resize(p.images.og.w, p.images.og.w, { fit: 'inside' }).jpeg({ quality: 82, mozjpeg: true }) });
  return jobs;
}

async function runPool(tasks, size) {
  let i = 0;
  const worker = async () => {
    while (i < tasks.length) await tasks[i++]();
  };
  await Promise.all(Array.from({ length: size }, worker));
}

try {
  const { photos, warnings } = await loadContent();
  for (const w of warnings) console.warn(`warning: ${w}`);
  await mkdir(IMG_OUT_DIR, { recursive: true });

  const wanted = new Set();
  const todo = [];
  const missing = new Set();
  for (const p of photos) {
    const jobs = jobsFor(p);
    p.outputs = jobs.map((j) => j.name);
    for (const job of jobs) {
      wanted.add(job.name);
      const out = path.join(IMG_OUT_DIR, job.name);
      if (!(await exists(out))) {
        todo.push(() => job.run().toFile(out));
        if (p.pointer) missing.add(p.file);
      }
    }
  }
  if (missing.size) {
    throw new ContentError([...missing].map((f) => `${f}: the original is needed to make its images, run "npm run import"`));
  }

  let removed = 0;
  for (const f of await readdir(IMG_OUT_DIR)) {
    if (!wanted.has(f)) {
      await unlink(path.join(IMG_OUT_DIR, f));
      removed++;
    }
  }

  const t0 = Date.now();
  sharp.concurrency(1);
  await runPool(todo, Math.max(1, Math.min(os.cpus().length, 8)));
  await writeSources(photos);
  console.log(`images: ${photos.length} photos, ${todo.length} files made, ${wanted.size - todo.length} up to date, ${removed} removed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
} catch (e) {
  console.error(e instanceof ContentError ? e.message : e);
  process.exit(1);
}
