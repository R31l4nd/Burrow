import type { Locale } from './i18n/index.svelte.js';

// What a release brought, in a few sentences: the same text F-Droid shows
// (android/fastlane/metadata/android/<lang>/changelogs/<version code>.txt),
// bundled into the page at build time.
const NOTES = import.meta.glob('../../../android/fastlane/metadata/android/*/changelogs/*.txt', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const DIRS: Record<Locale, string> = { en: 'en-US', nl: 'nl-NL' };

/** "2.3.2" -> 20302, as android/version-code.txt (major*10000 + minor*100 + patch); null for anything else. */
export function versionCode(version: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : null;
}

/** The release's own few sentences in this language (English when there is no translation), or null. */
export function whatsNew(version: string, lang: Locale): string | null {
  const code = versionCode(version);
  if (code === null) return null;
  const of = (dir: string) => NOTES[`../../../android/fastlane/metadata/android/${dir}/changelogs/${code}.txt`]?.trim() || null;
  return of(DIRS[lang]) ?? of(DIRS.en);
}
