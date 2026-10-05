// Generates the sample photos used until real photos are added.
// Each sample is an abstract landscape (sky, sun, horizon, ground, grain)
// with an EXIF capture date, so the build pipeline is exercised end to end.
// Run: npm run samples   (overwrites files in content/photos/ with the same names)
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('content/photos');

const TONES = {
  c1: ['#2b3f5c', '#d08a5a', '#3b2f2a', '#1a1513'],
  c2: ['#8fb3c9', '#d7e3ea', '#2f5d73', '#16323f'],
  c3: ['#9fb7a3', '#cfd8c8', '#3c5a3a', '#1d2c1b'],
  c4: ['#0d1424', '#2c3b5e', '#d9a441', '#1a1a1a'],
  c5: ['#e3c79a', '#f1dfc0', '#b5713f', '#6e3d1f'],
  c6: ['#6d8fb0', '#b7c9d8', '#e0b230', '#3a3020'],
  b1: ['#d9d9d9', '#a8a8a8', '#3a3a3a', '#111111'],
  b2: ['#6b6b6b', '#9a9a9a', '#1e1e1e', '#050505'],
  b4: ['#2a2a2a', '#555555', '#bdbdbd', '#e6e6e6'],
  f1: ['#c9b38e', '#e6d6b8', '#7d6a4e', '#3b3024'],
  f2: ['#a3b5a0', '#d8d2b8', '#8a6b4a', '#3d2e22'],
  f3: ['#d4a58a', '#ead2bf', '#6f5a63', '#2e2530'],
};

// file, aspect (w/h), tone, capture date, monochrome
export const SAMPLES = [
  ['2026-08-lisbon-tram.jpg', 1.5, 'c6', '2026:08:14 18:20:00'],
  ['2026-09-ardennes-fog.jpg', 1.5, 'c3', '2026:09:02 07:45:00'],
  ['sample-03.jpg', 0.8, 'b1', '2026:07:21 12:10:00', true],
  ['sample-04.jpg', 0.667, 'b4', '2026:06:30 16:05:00', true],
  ['sample-05.jpg', 1.778, 'c5', '2026:05:11 19:40:00'],
  ['sample-06.jpg', 0.8, 'f3', '2026:04:03 10:00:00'],
  ['sample-07.jpg', 1.5, 'c4', '2025:12:19 21:30:00'],
  ['sample-08.jpg', 1.5, 'f2', '2025:10:08 08:15:00'],
  ['sample-09.jpg', 0.667, 'c2', '2025:09:14 14:20:00'],
  ['sample-10.jpg', 1.5, 'b2', '2025:08:22 17:50:00', true],
  ['sample-11.jpg', 0.8, 'f1', '2025:07:05 11:30:00'],
  ['sample-12.jpg', 1.5, 'f1', '2025:06:18 09:10:00'],
  ['sample-13.jpg', 1.778, 'c1', '2025:05:27 20:45:00'],
  ['sample-14.jpg', 0.667, 'f3', '2025:04:12 15:35:00'],
  ['sample-15.jpg', 1.5, 'b1', '2024:11:09 13:00:00', true],
  ['sample-16.jpg', 1.5, 'c2', '2024:09:23 10:25:00'],
  ['sample-17.jpg', 1.778, 'b2', '2024:08:16 06:55:00', true],
  ['sample-18.jpg', 0.8, 'c4', '2024:07:28 22:10:00'],
  ['sample-19.jpg', 0.8, 'f3', '2024:06:02 18:00:00'],
  ['sample-20.jpg', 1.5, 'f1', '2024:05:19 12:40:00'],
  ['sample-21.jpg', 1.5, 'c3', '2024:04:07 08:30:00'],
  ['sample-22.jpg', 1.5, 'b4', '2024:03:15 16:20:00', true],
  ['sample-23.jpg', 0.667, 'c6', '2024:02:10 11:05:00'],
  ['sample-24.jpg', 1.5, 'f2', '2024:01:26 15:50:00'],
];

const LONG_EDGE = 2400;

function svgFor(i, ar, t) {
  const w = ar >= 1 ? LONG_EDGE : Math.round(LONG_EDGE * ar);
  const h = ar >= 1 ? Math.round(LONG_EDGE / ar) : LONG_EDGE;
  const horizon = 0.38 + ((i * 7) % 30) / 100;
  const hy = Math.round(h * horizon);
  const sunX = Math.round(w * (0.2 + ((i * 13) % 60) / 100));
  const sunY = Math.round(hy * (0.45 + ((i * 5) % 30) / 100));
  const sunR = Math.round(Math.min(w, h) * 0.06);
  // a soft ridge line just above the horizon
  const pts = [];
  for (let x = 0; x <= 12; x++) {
    const px = Math.round((w * x) / 12);
    const py = hy - Math.round(h * 0.03 * (1 + Math.sin(i + x * 1.7)));
    pts.push(`${px},${py}`);
  }
  return {
    w,
    h,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${t[0]}"/><stop offset="1" stop-color="${t[1]}"/>
    </linearGradient>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${t[2]}"/><stop offset="1" stop-color="${t[3]}"/>
    </linearGradient>
    <radialGradient id="sun"><stop offset="0" stop-color="#fff" stop-opacity="0.85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="${i + 1}"/><feColorMatrix type="saturate" values="0"/></filter>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#sky)"/>
  <circle cx="${sunX}" cy="${sunY}" r="${sunR * 3}" fill="url(#sun)"/>
  <polygon points="0,${hy} ${pts.join(' ')} ${w},${hy}" fill="${t[2]}" opacity="0.55"/>
  <rect y="${hy}" width="${w}" height="${h - hy}" fill="url(#ground)"/>
  <rect width="${w}" height="${h}" filter="url(#grain)" opacity="0.06"/>
</svg>`,
  };
}

await mkdir(OUT, { recursive: true });
for (const [i, [file, ar, tone, date, mono]] of SAMPLES.entries()) {
  const { svg } = svgFor(i, ar, TONES[tone]);
  let img = sharp(Buffer.from(svg));
  if (mono) img = img.greyscale();
  await img
    .jpeg({ quality: 84, mozjpeg: true })
    .withExif({ IFD0: { Artist: 'Dieter', Software: 'make-samples' }, IFD2: { DateTimeOriginal: date } })
    .toFile(path.join(OUT, file));
  process.stdout.write('.');
}
console.log(`\n${SAMPLES.length} sample photos written to content/photos/`);
