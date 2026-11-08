import './lib/back.js';
import { mount } from 'svelte';
import './fonts.js';
import './app.css';
import App from './App.svelte';
import { watchErrors, watchReportGestures } from './lib/bugreport.svelte.js';
import { applyAppearance } from './lib/theme.svelte.js';
import { localeReady } from './lib/i18n/index.svelte.js';

// Before the first render, so the page does not flash in the wrong theme.
applyAppearance();
// Errors in the page, kept for a problem report.
watchErrors();
// A shake of the phone, or Ctrl+Shift+B: a problem report from where it went wrong.
watchReportGestures();

// In the reader's language from the first frame (another language than English loads first).
// The words index.html shows until now (with a reload link, should this code not have loaded) go.
void localeReady.then(() => {
  const target = document.getElementById('app')!;
  target.replaceChildren();
  mount(App, { target });
});
