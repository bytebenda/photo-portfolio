# Dieter's portfolio

A static photography portfolio: a square grid on black, one Filter button for location, category, year and style, and a fullscreen photo view. Built with Astro and sharp in GitHub Actions, hosted on Vercel.

The photos come from Google Drive and never go into Git. They live in three places: the Drive folder, the GitHub Actions cache (private to this repository: the originals and the web images, so a run only processes new photos), and the deployed site on Vercel. `content/photos/` and `public/img/` are ignored by Git; `npm run import` fills them locally.

## Adding a photo

1. Put it in the Google Drive folder. The next run of the workflow (every morning, or "Run workflow" in the Actions tab) imports it, makes its images and deploys the site.
2. Optional: add an entry to `content/photos.yaml` at the position it should take in the grid, and push.

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

- Unchanged photos are skipped, photos changed in Drive are downloaded again, and photos removed from Drive are removed from `content/photos/`.
- A photo that sits in several folders, or a shortcut to a photo or folder, is imported once and gets the tags of every folder it is in.
- A folder named `Private` is never imported, at any depth, with everything in it, also when reached through a shortcut. Photos imported from it before are removed. The names are in `driveSkipFolders` in `src/site.config.mjs`.
- JPEG, PNG, WebP, TIFF and AVIF are imported. HEIC and camera RAW files are skipped with a warning: export them as JPEG in Drive.
- `node scripts/drive-import.mjs --dry-run` shows what would change without writing anything.

Access is one environment variable, or none:

| Variable | When |
| --- | --- |
| none | The folder is shared as "anyone with the link". The import reads Drive's public folder pages. A photo you replace in Drive under the same file is not downloaded again, because those pages give no checksum: delete and re-upload it, or use an API key. |
| `GOOGLE_API_KEY` | The folder is shared as "anyone with the link". Make a key in Google Cloud Console with the Google Drive API enabled. |
| `GOOGLE_SERVICE_ACCOUNT` | The folder stays private. Make a service account with the Google Drive API enabled, share the folder with its e-mail address (viewer), and pass the key JSON or the path to the key file. |

In the workflow, add the variable above as a repository secret when you use one.

### Filters from keywords

The Categories filter lists categories alphabetically, with Uncategorized last.

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

### Location filter

The Location section of the filter comes from the subfolders of the Drive folder `Favorites` (`locationRoot` in `src/site.config.mjs`). Name each subfolder `<Country> - <Place>`; the first `-` splits country and place, so `Belgium - Pajottenland` gives Belgium > Pajottenland.

- A folder with only a country (`Belgium`) puts its photos under Belgium > Other, listed last among that country's places.
- Photos directly in `Favorites` (or outside it) go under a top-level Other.
- Deeper subfolders don't change the location; a photo in several folders gets each location.
- The section appears once at least one country folder exists. A country with only Other shows as one row.

## Globe hero

The home page opens on a full-screen globe made of the gallery's square thumbnails, rolling forward over a grid floor (one turn every 12 seconds, with the floor moving at the matching speed). On desktop it rolls left and right after the cursor. Dragging or swiping sideways turns it. Clicking or tapping a photo on the globe opens it in the viewer, growing out of that tile; a click in the gap between tiles counts for the nearest one. Scrolling down (one screen on desktop, one and a half on phones) unrolls the globe into a flat sheet, like a map peeled off a globe. While it is still flattening, one copy of each photo starts its flight to its grid square, in an arc towards the viewer with a slight turn, centre of the screen first; the other copies drift back out of focus and fade. Everything runs on one timeline with overlapping windows, so the motion never stops halfway. The animation follows the scroll through a spring with a speed limit: a fast swipe still plays it in full (at least 0.6 seconds), and the last few percent crossfade into the real grid. Scrolling back up builds the globe again. The Filter button appears once the grid is reached.

- On load the globe drops in from above, squashes on impact, bounces up while flipping forward three times, lands with a small second bounce and starts rolling, all in about 1.7 seconds. Reduce Motion skips it.
- The globe stands on a dark perspective grid floor that moves towards you as the ball rolls. A contact shadow under the globe shrinks while it is in the air during the drop-in and spreads when it lands. Behind it, two soft glows take the colour of the most colourful photo facing you on the left and on the right, and shift as the globe turns. Floor and glow are one shader drawn under the tiles; they sink and fade early in the scroll, and with Reduce Motion they stay still. The globe is a little smaller than the screen height (40% instead of 45% as radius) to leave room for the floor.
- The tiles sit in rows of latitude, edge to edge: each row is split into tiles of exactly equal width, close to square, and rows share their edges, so the surface is closed with no gaps. A round photo covers each pole. The ball is shown with its poles left and right, so it rolls forward along its rows and the photos facing you stand upright. It is lit per corner, so there are no light steps between tiles, and each tile leaves out 3% at its edges so neighbouring photos in the texture never bleed in. 216 tiles on desktop and about 120 on phones, so photos repeat; each run of tiles holds every photo once, in a shuffled order. When you scroll, the ball stops rolling and makes a quarter turn on screen so its rows run across, while every photo turns the other way inside its tile and stays upright (zoomed just enough to fill the tile). It then unrolls into a wide sheet that grows until it covers the whole screen (fully open at 40% of the scroll), before the photos fly into the gallery between 40% and 90%. The pole caps fade before the turn. The globe loads at once with the page: it uses the grid's own thumbnails (one download per photo) while three.js loads, and starts after 1.2 seconds at most, drawing in any thumbnail that arrives later.
- It shows only on the home page without filters in the address. Links to a photo (`/photo/...`) or a filtered view open on the grid as before.
- Tiles in flight stretch slightly with speed, and the far side of the globe and the fading copies are blurred for depth. On desktop the flying tiles also get a thin light edge and a soft glow (bloom), which switches itself off on a device that cannot keep up.
- It is drawn with WebGL (Three.js, about 130 KB gzipped, plus about 20 KB for the glow on desktop). That code loads after the page, so the grid is not slowed down. Without WebGL or JavaScript the page is the plain grid.
- When the visitor's system asks for reduced motion (such as Reduce Motion on an iPhone), the globe does not spin, tilt or fade in by itself, but scrolling still unrolls it into the grid, since that motion follows the visitor's own scrolling.

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
| `npm run import` | Copy the photos from Google Drive into `content/photos/` (needed first on a fresh checkout) |
| `npm run dev` | Make images, then start the dev server on localhost:4321 |
| `npm run build` | Make images, then build the static site into `dist/` |
| `npm run preview` | Serve the built site |
| `npm run check` | Validate `content/` without building |
| `npm run images` | Make the missing images in `public/img/` and update `content/images.json` (runs before every build) |
| `npm run typecheck` | Type check the Astro pages and scripts |
| `npm run samples` | Regenerate the sample photos |

## How it works

- `src/lib/content.mjs` reads the YAML, the originals and their EXIF dates, turns keywords and Drive folder names into categories and styles, and applies the rules above. The pages, the image step and `npm run check` all use it.
- `scripts/images.mjs` makes square thumbnails (400 and 800 px), large versions (1600 and 3000 px on the long edge, or the original size when smaller) in AVIF and WebP, a small preview and a JPEG for link previews. Output goes to `public/img/` and is named after a hash of the original, so unchanged photos are skipped. It also writes `content/images.json` (committed, no pixels) with each original's checksum, size, keywords, camera and lens and whether it is black and white. Making the images for 33 photos takes about 7 minutes; with the Actions cache a run only makes those of new photos.
- `src/components/Gallery.astro` renders the header, grid, footer and photo view. `/photo/<slug>` pages render the same view with the photo open and their own title and preview image.
- `src/scripts/gallery.ts` handles the page: hiding header (on desktop it also slides in when the cursor reaches the top edge), the scroll gap spring, filters (state in the URL query; "Deselect all" and "Show all" at the top of the panel; a section with nothing ticked does not filter, so after "Deselect all" every option you tick adds its photos), and the photo view (history, keyboard, swipe, preloading, the (i) panel with location, camera and lens, which `i` toggles, and zoom up to 4x: pinch, pan with one finger and double tap on touch screens; the minus and plus icons, a click, dragging, trackpad pinch and the keys `+`, `-` and `0` on desktop). Camera and lens come from the EXIF of the original, stored in `content/images.json`; the location comes from the photo's folder in Favorites ("Pajottenland, Belgium", or only the country for its Other; none for photos outside a country folder). A photo without any of the three has no (i). Animations switch off when the visitor's system asks for reduced motion.
- `src/components/Hero.astro`, `src/scripts/hero.ts` and `src/scripts/globe.ts` make the globe hero: see below.
- Without JavaScript every square links to its photo page, so the site still works.

## Building and deploying

`.github/workflows/drive-import.yml` ("Build and deploy") does everything; Vercel itself does not build from Git (`"git": { "deploymentEnabled": false }` in `vercel.json`), because the repository has no photos.

1. Restore the newest photo cache (originals and images).
2. `npm run import`: download new or changed photos from Drive, remove deleted ones.
3. `npm run images`: make the images of new photos and update `content/images.json`.
4. Save the cache when something changed, and commit `content/drive.yaml` and `content/images.json` when they changed.
5. `vercel build` and `vercel deploy --prebuilt`: production for main, a preview for other branches.

It runs on every push, every morning and from the Actions tab. It needs the repository secret `VERCEL_TOKEN` (Vercel, Account Settings, Tokens). The Vercel team and project IDs are in the workflow. When the cache has expired (GitHub drops caches unused for 7 days), the next run downloads all photos again and makes all images, which takes some minutes.

Set `SITE_URL` (for example `https://example.com`) in the Vercel project's environment variables once the domain is known, so link previews use the right address.

## Open points

- Style values: currently Colour, Black and white, Film.
- Domain name.
- Original downloads: only the large optimized version is shown for now.
- Visitor statistics: none for now.
