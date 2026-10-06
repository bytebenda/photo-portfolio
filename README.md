# Dieter photography portfolio

A static photography portfolio: a square grid on black, filter pills for category, year and style, and a fullscreen photo view. Built with Astro, images made with sharp at build time, hosted on Vercel.

The photos in `content/photos/` come from Google Drive (`npm run import`, see below). `npm run samples` makes generated sample photos for testing without Drive.

## Adding a photo

1. Copy the exported file into `content/photos/`, or put it in the Google Drive folder and run the import (see below).
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

## Importing from Google Drive

`npm run import` copies every photo from the Google Drive folder in `src/site.config.mjs` (`driveFolder`) into `content/photos/`, from every subfolder at any depth. It records where each photo came from in `content/drive.yaml`, which the import writes and you do not edit.

- Unchanged photos are skipped, photos changed in Drive are downloaded again, and photos removed from Drive are removed from `content/photos/`. Photos you copied into `content/photos/` yourself are left alone.
- A photo that sits in several folders, or a shortcut to a photo or folder, is imported once and gets the tags of every folder it is in.
- JPEG, PNG, WebP, TIFF and AVIF are imported. HEIC and camera RAW files are skipped with a warning: export them as JPEG in Drive.
- `node scripts/drive-import.mjs --dry-run` shows what would change without writing anything.

Access is one environment variable, or none:

| Variable | When |
| --- | --- |
| none | The folder is shared as "anyone with the link". The import reads Drive's public folder pages. A photo you replace in Drive under the same file is not downloaded again, because those pages give no checksum: delete and re-upload it, or use an API key. |
| `GOOGLE_API_KEY` | The folder is shared as "anyone with the link". Make a key in Google Cloud Console with the Google Drive API enabled. |
| `GOOGLE_SERVICE_ACCOUNT` | The folder stays private. Make a service account with the Google Drive API enabled, share the folder with its e-mail address (viewer), and pass the key JSON or the path to the key file. |

`.github/workflows/drive-import.yml` runs the import from the Actions tab, every Monday, and on every push that changes the import script or the workflow, and commits the result to the branch it ran on, so Vercel publishes the new photos without a local checkout. Add the variable above as a repository secret when you use one.

### Tags from folder names

The names of the folders a photo sits in are its tags, plus any `#hashtag` in the file's Drive description. The tags decide the filters:

| Field | Comes from |
| --- | --- |
| Categories | Every category whose id, label or `match` word appears in a tag, as whole words and without regard to case or accents. `Reizen/Lissabon 2024/Straat` gives travel and street. No match gives Uncategorized. |
| Style | The first style in `styles.yaml` that matches, where the default style only wins when nothing else matches. No match gives the style marked `default: true`. |
| Year | The capture date in the photo's EXIF, otherwise a year in a folder name (`Scans 1998`), useful for film scans. |
| Title | The first line of the Drive description without hashtags, otherwise the deepest folder that says more than a category or style (`Lissabon 2024`). |

The import ends with the words in folder names that match nothing. Add the ones that should count to `match` in `content/categories.yaml` or `content/styles.yaml`, for example `match: [straat, straatfotografie]`.

Photos from Drive come after the photos in `photos.yaml`, newest first. To give one a place in the grid, a better title, other categories or a crop centre, add an entry for its file name to `photos.yaml`. Fields you set there win; categories and style may be left out and then still come from the folders.

## Rules the build checks

| Rule | Result when broken |
| --- | --- |
| Every entry points to an existing file | Build fails |
| Every entry has a category and a style (photos from Drive get them from their folders) | Build fails |
| Every category and style exists in its list | Build fails, with the closest match suggested |
| Slugs are unique | Build fails |
| A file in photos/ has no entry and is not from Drive | Build passes, photo appears last under Uncategorized, warning printed |
| A photo from Drive has no folder name that matches a category | Build passes, photo appears under Uncategorized, warning printed |
| A photo has no capture date in EXIF and no `year` set | Build passes, photo has no year, warning printed |

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Install dependencies (Node 20 or newer) |
| `npm run dev` | Make images, then start the dev server on localhost:4321 |
| `npm run build` | Make images, then build the static site into `dist/` |
| `npm run preview` | Serve the built site |
| `npm run check` | Validate `content/` without building |
| `npm run import` | Copy the photos from Google Drive into `content/photos/` |
| `node scripts/lfs-fetch.mjs` | Replace Git LFS pointer files with the real photos (runs before every build) |
| `npm run typecheck` | Type check the Astro pages and scripts |
| `npm run samples` | Regenerate the sample photos |

## How it works

- `src/lib/content.mjs` reads the YAML, the originals and their EXIF dates, turns the Drive folder names into categories and styles, and applies the rules above. The pages, the image step and `npm run check` all use it.
- `scripts/images.mjs` makes square thumbnails (400 and 800 px), large versions (1600 and 3000 px on the long edge, or the original size when smaller) in AVIF and WebP, a small preview and a JPEG for link previews. Output goes to `public/img/` (not committed) and is named after a hash of the original, so unchanged photos are skipped.
- `src/components/Gallery.astro` renders the header, grid, footer and photo view. `/photo/<slug>` pages render the same view with the photo open and their own title and preview image.
- `src/scripts/gallery.ts` is the only JavaScript: hiding header, the scroll gap spring, filters (state in the URL query), and the photo view (history, keyboard, swipe, preloading). Animations switch off when the visitor's system asks for reduced motion.
- Without JavaScript every square links to its photo page, so the site still works.

## Deploying on Vercel

1. Import this repository in Vercel. The framework preset is Astro and the build command is `npm run build`.
2. Optional: in the project settings under Git, turn on Git LFS. When it is off, Vercel clones the photos as Git LFS pointer files and `scripts/lfs-fetch.mjs` downloads the real files from GitHub at the start of the build. That works for a public repository; a private one needs a `GITHUB_TOKEN` environment variable with read access to the repository contents.
3. Set `SITE_URL` (for example `https://example.com`) once the domain is known, so link previews use the right address. Without it the Vercel production URL is used.

Git LFS storage and bandwidth count against the GitHub quota, and every Vercel build downloads the originals. Check the quota before pushing the full set.

## Open points

- Style values: currently Colour, Black and white, Film.
- Domain name.
- Original downloads: only the large optimized version is shown for now.
- Visitor statistics: none for now.
