// npm run check: validates content/ without building anything.
import { loadContent, ContentError } from '../src/lib/content.mjs';

try {
  const { photos, categories, styles, years, warnings, tagReport } = await loadContent();
  for (const w of warnings) console.warn(`warning: ${w}`);
  const fromKeywords = tagReport.fromKeywords.filter((k) => k.kind === 'category').map((k) => `${k.label} (${k.count})`);
  const typesFromKeywords = tagReport.fromKeywords.filter((k) => k.kind === 'style').map((k) => `${k.label} (${k.count})`);
  if (fromKeywords.length) console.log(`categories from keywords: ${fromKeywords.join(', ')}`);
  if (typesFromKeywords.length) console.log(`types from keywords: ${typesFromKeywords.join(', ')}`);
  if (tagReport.unmatched.length) {
    console.log('folder words that match no category or style (add them to "match" in categories.yaml or styles.yaml to use them):');
    for (const [tag, n] of tagReport.unmatched) console.log(`  ${tag} (${n} ${n === 1 ? 'photo' : 'photos'})`);
  }
  console.log(
    `ok: ${photos.length} photos, ${categories.length} categories, ${styles.length} styles, years ${years.map((y) => y.label).join(', ') || 'none'}`,
  );
} catch (e) {
  console.error(e instanceof ContentError ? e.message : e);
  process.exit(1);
}
