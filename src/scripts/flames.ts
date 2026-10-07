// The flame button on the hero: each click sends a burst of flames up the
// screen. Every burst is its own layer, removed once its flames are gone.
const button = document.getElementById('flame-btn');
const MAX_BURSTS = 8; // enough for spamming, without piling up thousands of flames

button?.addEventListener('click', () => {
  // The ball goes up with the flames (hero.ts decides whether it can).
  document.dispatchEvent(new CustomEvent('hero:launch'));
  if (document.querySelectorAll('.flames').length >= MAX_BURSTS) return;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  const layer = document.createElement('div');
  layer.className = 'flames';
  layer.setAttribute('aria-hidden', 'true');
  let longest = 0;
  for (let i = 0; i < (still ? 14 : 48); i++) {
    const flame = document.createElement('span');
    flame.textContent = '\u{1F525}';
    const dur = rand(1.6, 3);
    const delay = rand(0, 0.7);
    longest = Math.max(longest, dur + delay);
    flame.style.setProperty('--x', `${rand(-2, 98).toFixed(1)}%`);
    flame.style.setProperty('--y', `${rand(5, 85).toFixed(1)}%`);
    flame.style.setProperty('--size', `${Math.round(rand(22, 60))}px`);
    flame.style.setProperty('--dur', `${dur.toFixed(2)}s`);
    flame.style.setProperty('--delay', `${delay.toFixed(2)}s`);
    flame.style.setProperty('--sway', `${Math.round(rand(-60, 60))}px`);
    flame.style.setProperty('--rot', `${Math.round(rand(-25, 25))}deg`);
    layer.append(flame);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), longest * 1000 + 100);
});
