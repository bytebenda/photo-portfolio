# Dieter photography portfolio

A static photography portfolio: a square grid on black, filter pills for category, year and style, and a fullscreen photo view. Built with Astro, images made with sharp at build time, hosted on Vercel.

The photos in `content/photos/` are generated samples (`npm run samples`). Replace them with your own.

## Adding a photo

1. Copy the exported file into `content/photos/`.
2. Add an entry to `content/photos.yaml` at the position it should take in the grid.
3. Run `npm run check`, or just push. Vercel builds and publishes the site.

```yaml
- file: 2026-08-lisbon-tram.jpg
  slug: tram-28              # optional, defaults to the file name
  title: Tram 28             # page title and alt text
  categories: [street, travel]
  style: colour
  year: 2026                 # optional, overrides the EXIF capture year
  focus: [0.5, 0.3]          # optional crop centre for the square thumbnail
```

A new category or style is one extra entry in `content/categories.yaml` or `content/styles.yaml`. It shows up in the filter as soon as one photo uses it.

## Rules the build checks

| Rule | Result when broken |
| --- | --- |
| Every entry points to an existing file | Build fails |
| Every category and style exists in its list | Build fails, with the closest match suggested |
| Slugs are unique | Build fails |
| A file in photos/ has no entry | Build passes, photo appears last under Uncategorized, warning printed |
| A photo has no capture date in EXIF and no `year` set | Build passes, photo has no year, warning printed |

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Install dependencies (Node 20 or newer) |
| `npm run dev` | Make images, then start the dev server on localhost:4321 |
| `npm run build` | Make images, then build the static site into `dist/` |
| `npm run preview` | Serve the built site |
| `npm run check` | Validate `content/` without building |
| `npm run typecheck` | Type check the Astro pages and scripts |
| `npm run samples` | Regenerate the sample photos |

## How it works

- `src/lib/content.mjs` reads the YAML, the originals and their EXIF dates, and applies the rules above. The pages, the image step and `npm run check` all use it.
- `scripts/images.mjs` makes square thumbnails (400 and 800 px), large versions (1600 and 3000 px on the long edge, or the original size when smaller) in AVIF and WebP, a small preview and a JPEG for link previews. Output goes to `public/img/` (not committed) and is named after a hash of the original, so unchanged photos are skipped.
- `src/components/Gallery.astro` renders the header, grid, footer and photo view. `/photo/<slug>` pages render the same view with the photo open and their own title and preview image.
- `src/scripts/gallery.ts` is the only JavaScript: hiding header, the scroll gap spring, filters (state in the URL query), and the photo view (history, keyboard, swipe, preloading). Animations switch off when the visitor's system asks for reduced motion.
- Without JavaScript every square links to its photo page, so the site still works.

## Deploying on Vercel

1. Import this repository in Vercel. The framework preset is Astro and the build command is `npm run build`.
2. In the project settings under Git, turn on Git LFS. Without it Vercel gets pointer files instead of photos and the build fails.
3. Set `SITE_URL` (for example `https://example.com`) once the domain is known, so link previews use the right address. Without it the Vercel production URL is used.

Git LFS storage and bandwidth count against the GitHub quota, and every Vercel build downloads the originals. Check the quota before pushing the full set.

## Open points

- Style values: currently Colour, Black and white, Film.
- Domain name.
- Original downloads: only the large optimized version is shown for now.
- Visitor statistics: none for now.
