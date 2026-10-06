# Dieter photography portfolio

A static photography portfolio: a square grid on black, filter pills for category, year and style, and a fullscreen photo view. Built with Astro, images made with sharp and committed, hosted on Vercel.

The photos in `content/photos/` come from Google Drive (`npm run import`, see below). `npm run samples` makes generated sample photos for testing without Drive.

## Adding a photo

1. Put it in the Google Drive folder. The daily import (see below) adds it and its images. Or copy the exported file into `content/photos/` yourself.
2. Optional: add an entry to `content/photos.yaml` at the position it should take in the grid.
3. For a file you copied yourself: run `npm run images` and commit `content/photos/`, `content/images.json` and `public/img/`. Push, and Vercel publishes the site.

```yaml
- file: 2026-08-lisbon-tram.jpg
  slug: tram-28              # optional, defaults to the file name
  title: Tram 28             # page title and alt text
  categories: [street, travel]
  style: colour
  year: 2026                 # optional, overrides the EXIF capture year
  focus: [0.5, 0.3]          # optional crop centre for the square thumbnail
  featured: true             # optional, puts it among the featured photos
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

`.github/workflows/drive-import.yml` runs the import from the Actions tab, every morning, and on every push that changes the import script or the workflow, makes the images for new photos, and commits the result to the branch it ran on, so Vercel publishes the new photos without a local checkout. Add the variable above as a repository secret when you use one.

### Filters from keywords

The filters follow the keywords in your photos. Give a photo its categories and its type (the Style filter) as keywords in your photo editor before you upload it to Drive. The keywords are stored inside the JPEG, so they count whatever folder the photo is in. Every new keyword becomes a filter option at the next import; nothing needs to be listed first. A photo can have several categories and has exactly one type.

| Keyword | Becomes |
| --- | --- |
| `Street`, `Travel`, `Street art` | A category each, labelled as written |
| `Film` under a parent `Type` (Lightroom: Type > Film), or `type: film` | The photo's type; a new type becomes a new option in the Style filter |
| A word from `styles.yaml`, such as `black and white` or `zwart-wit` | The photo's type, also without the parent |
| `featured` or `uitgelicht` (set in `content/keywords.yaml`) | Puts the photo on top of the grid, not a filter |
| A parent such as `Category` in Category > Street | Nothing, only `Street` counts |
| A keyword listed under `ignore` in `content/keywords.yaml` | Nothing |

In Lightroom Classic: select the photos, type the keywords in the Keywording panel, and export with Metadata set to "All Metadata" or "All Except Camera & Camera Raw Info" ("Copyright Only" drops the keywords). The Title field in the Metadata panel becomes the photo's title on the site. Capture One and the Fujifilm app write keywords in the same place (XMP dc:subject or IPTC Keywords).

`content/categories.yaml` and `content/styles.yaml` are optional now. They set the order and label of an option, and extra words that count as the same option: with `match: [straat]` under street, the keywords `Straat` and `Street` both land under Street instead of making two options. Options that only come from keywords follow the listed ones, alphabetically.

| Field | Comes from |
| --- | --- |
| Categories | The keywords as above. Drive folder names and `#hashtags` in a Drive description also count, but only when they contain a listed category word (`Reizen/Lissabon 2024` gives travel). No match gives Uncategorized. |
| Type (Style) | A Type keyword, otherwise the first matching style in `styles.yaml`, where the default only wins when nothing else matches. A photo without colour then gets the style marked `monochrome: true` (black and white); a light tone such as sepia counts as colour. No match gives the style marked `default: true`. |
| Year | The capture date in the photo's EXIF, otherwise a year in a folder name (`Scans 1998`), useful for film scans. |
| Title | The Title stored in the file, otherwise the first line of the Drive description without hashtags, otherwise the deepest folder that says more than a category or style (`Lissabon 2024`). |

`npm run check` and the import list the filter options that came from keywords, so a typo (`Stret`) shows up as its own option. Fix it in the photo, add it to `match` of the right category, or add it to `ignore`.

A photo already in Drive that gets keywords later has to reach the site again. With an API key or service account the import sees the change. Without one, run the workflow with "refresh" ticked (or `npm run import -- --refresh`), which downloads every photo and keeps the changed ones, or delete the file in Drive and upload the new version.

Photos without an entry in `photos.yaml` come after the listed ones: featured photos first, then newest first. A photo is featured with a keyword or a Drive folder named in `featured` in `content/keywords.yaml` (add `favorieten` to feature the Favorieten folder), or with `featured: true` in `photos.yaml`. To give one a place in the grid, a better title, other categories or a crop centre, add an entry for its file name to `photos.yaml`. Fields you set there win; categories and style may be left out and then still come from the keywords.

## Rules the build checks

| Rule | Result when broken |
| --- | --- |
| Every entry points to an existing file | Build fails |
| Every entry has a style, set or from keywords (with a default style this always holds) | Build fails |
| Every category and style exists in its list | Build fails, with the closest match suggested |
| Slugs are unique | Build fails |
| A photo has no categories in photos.yaml and no keyword or folder name that matches one | Build passes, photo appears under Uncategorized, warning printed |
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
| `npm run images` | Make the missing images in `public/img/` and update `content/images.json` (runs before every build) |
| `node scripts/lfs-fetch.mjs` | Download the originals the build still needs (runs before every build); `--all` downloads every original |
| `npm run typecheck` | Type check the Astro pages and scripts |
| `npm run samples` | Regenerate the sample photos |

## How it works

- `src/lib/content.mjs` reads the YAML, the originals and their EXIF dates, turns keywords and Drive folder names into categories and styles, and applies the rules above. The pages, the image step and `npm run check` all use it.
- `scripts/images.mjs` makes square thumbnails (400 and 800 px), large versions (1600 and 3000 px on the long edge, or the original size when smaller) in AVIF and WebP, a small preview and a JPEG for link previews. Output goes to `public/img/`, is committed, and is named after a hash of the original, so unchanged photos are skipped. It also writes `content/images.json` with each original's checksum, size, keywords and whether it is black and white. With both committed, a build works from Git LFS pointer files and never downloads or processes the originals: making the images for 33 photos takes about 7 minutes, the build then takes seconds.
- `src/components/Gallery.astro` renders the header, grid, footer and photo view. `/photo/<slug>` pages render the same view with the photo open and their own title and preview image.
- `src/scripts/gallery.ts` is the only JavaScript: hiding header, the scroll gap spring, filters (state in the URL query), and the photo view (history, keyboard, swipe, preloading, the (i) panel with camera and lens, which `i` toggles, and zoom up to 4x: pinch, pan with one finger and double tap on touch screens; the minus and plus icons, a click, dragging, trackpad pinch and the keys `+`, `-` and `0` on desktop). Camera and lens come from the EXIF of the original, stored in `content/images.json`; a photo without them has no (i). Animations switch off when the visitor's system asks for reduced motion.
- Without JavaScript every square links to its photo page, so the site still works.

## Deploying on Vercel

1. Import this repository in Vercel. The framework preset is Astro and the build command is `npm run build`.
2. Leave Git LFS off in the project settings under Git. Vercel then clones the originals as small pointer files and builds from `public/img/` and `content/images.json`. Only when an image is missing does `scripts/lfs-fetch.mjs` download that original from GitHub. That works for a public repository; a private one needs a `GITHUB_TOKEN` environment variable with read access to the repository contents.
3. Set `SITE_URL` (for example `https://example.com`) once the domain is known, so link previews use the right address. Without it the Vercel production URL is used.

Git LFS storage counts against the GitHub quota. Downloads are rare now: Vercel and the import workflow work from pointer files. The committed images take about 2.4 MB per photo in normal Git storage, half of it the 3000 px versions.

## Open points

- Style values: currently Colour, Black and white, Film.
- Domain name.
- Original downloads: only the large optimized version is shown for now.
- Visitor statistics: none for now.
