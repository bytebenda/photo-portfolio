// @ts-check
import { defineConfig } from 'astro/config';

// The absolute site URL is needed for link previews (og:image).
// On Vercel it comes from the production domain; set SITE_URL to override.
const site =
  process.env.SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:4321');

export default defineConfig({
  site,
  output: 'static',
  trailingSlash: 'never',
  build: { format: 'file' },
  // Images are made by scripts/images.mjs, not by Astro's image service.
  image: { service: { entrypoint: 'astro/assets/services/noop' } },
});
