import { mount } from 'svelte';
import '../fonts.js';
import '../app.css';
import { setSpecImporter } from '../lib/complete/specs.js';
import { direct } from './bridge.js';

// The Android app's direct route (phase 5): Burrow's terminal UI, bundled in
// the app, for when Burrow itself cannot be reached. The app serves this
// page from its own origin and connects over SSH itself.

// Completion specs: a selection bundled next to this page (scripts/direct-assets.sh).
const FIG = '/direct/fig/';
setSpecImporter(
  (name) => import(/* @vite-ignore */ `${FIG}${name}.js`) as Promise<{ default: unknown }>,
  async () => ((await import(/* @vite-ignore */ `${FIG}index.js`)) as { default: string[] }).default,
);

async function start() {
  // This origin has its own storage: take over the main app's settings
  // (language, theme, terminal) before anything reads them.
  const info = await direct?.info().catch(() => null);
  for (const [k, v] of Object.entries(info?.uiPrefs ?? {})) {
    try {
      localStorage.setItem(k, v);
    } catch {
      // Defaults then.
    }
  }
  const { applyAppearance } = await import('../lib/theme.svelte.js');
  applyAppearance();
  const { default: DirectApp } = await import('./DirectApp.svelte');
  await (await import('../lib/i18n/index.svelte.js')).localeReady;
  mount(DirectApp, { target: document.getElementById('app')!, props: { version: info?.version ?? '' } });
}

void start();
