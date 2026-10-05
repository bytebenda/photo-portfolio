// npm run check: validates content/ without building anything.
import { loadContent, ContentError } from '../src/lib/content.mjs';

try {
  const { photos, categories, styles, years, warnings } = await loadContent();
  for (const w of warnings) console.warn(`warning: ${w}`);
  console.log(
    `ok: ${photos.length} photos, ${categories.length} categories, ${styles.length} styles, years ${years.map((y) => y.label).join(', ') || 'none'}`,
  );
} catch (e) {
  console.error(e instanceof ContentError ? e.message : e);
  process.exit(1);
}
