// npm run check: validates content/ without building anything.
import { loadContent, ContentError } from '../src/lib/content.mjs';

try {
  const { photos, categories, styles, years, warnings, tagReport } = await loadContent();
  for (const w of warnings) console.warn(`warning: ${w}`);
  if (tagReport.unmatched.length) {
    console.log('keywords and folder words that match no category or style (add them to "match" in categories.yaml or styles.yaml, or ignore them):');
    for (const [tag, n] of tagReport.unmatched) console.log(`  ${tag} (${n} ${n === 1 ? 'photo' : 'photos'})`);
  }
  console.log(
    `ok: ${photos.length} photos, ${categories.length} categories, ${styles.length} styles, years ${years.map((y) => y.label).join(', ') || 'none'}`,
  );
} catch (e) {
  console.error(e instanceof ContentError ? e.message : e);
  process.exit(1);
}
