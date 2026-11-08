import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { en } from './en.js';
import { nl } from './nl.js';

type I18n = typeof import('./index.svelte.js');
let i18n: I18n;

beforeAll(async () => {
  vi.stubGlobal('document', { documentElement: { lang: '' } });
  vi.stubGlobal('localStorage', { getItem: () => 'en', setItem: () => {} });
  vi.stubGlobal('navigator', { language: 'en' });
  i18n = await import('./index.svelte.js');
});

const placeholders = (s: string) => [...new Set([...s.matchAll(/(?<!\{)\{(\w+)[:}]/g)].map((m) => m[1]))].sort();
// A message without its plural choices: what is left must not need one.
const withoutPlurals = (s: string) => s.replace(/\{\w+:(?:[^{}]|\{\w+\})*\}/g, '');

describe('the message files', () => {
  // JSON keeps the last of two equal keys without a word: a second "error.unknown_host" with other
  // words replaced the first in both languages and no test saw it (2.11.0).
  it('have each key once', () => {
    for (const lang of ['en', 'nl']) {
      const raw = readFileSync(join(import.meta.dirname, `${lang}.json`), 'utf8');
      const keys = [...raw.matchAll(/^\s*"((?:[^"\\]|\\.)+)"\s*:/gm)].map((m) => m[1]!);
      const twice = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
      expect(twice, `${lang}.json`).toEqual([]);
    }
  });
});

describe('messages', () => {
  it('picks the singular for one', async () => {
    await i18n.setLocale('en');
    expect(i18n.t('users.passkeys', { n: 1 })).toBe('1 passkey');
    expect(i18n.t('users.passkeys', { n: 2 })).toBe('2 passkeys');
    expect(i18n.t('alerts.clearConfirm', { n: 3 })).toBe('Delete all 3 alerts? Rules and mutes stay.');
    await i18n.setLocale('nl');
    expect(i18n.t('reports.counts', { p: 1, a: 2, o: 0 })).toBe('1 probleem, 2 let op, 0 ok');
    expect(i18n.t('reports.counts', { p: 2, a: 0, o: 1 })).toBe('2 problemen, 0 let op, 1 ok');
  });

  it('never reads a filled-in value as a placeholder', async () => {
    await i18n.setLocale('en');
    expect(i18n.t('ws.replaced', { n: 1, files: 1 })).toBe('1 replaced in 1 file');
    expect(i18n.t('ws.replaceConfirm', { n: 2, files: 1, with: '{files} {n:a|b}' })).toContain('"{files} {n:a|b}"');
  });

  // "1 passkeys", "1 problemen": a count right before a noun needs both forms.
  it('has a singular wherever a count comes before a plural noun', () => {
    const bare = (cat: Record<string, string>, plural: RegExp) =>
      Object.entries(cat)
        .filter(([, s]) => plural.test(withoutPlurals(s)))
        .map(([k]) => k);
    expect(bare(en, /\{(n|p|files|count|imported|e|w|i)\} (new |older |media |image |unused )?[a-z]+s\b/)).toEqual([]);
    // Verbs end in -en too ("{n} verplaatsen"), and so do past participles ("{n} gekozen").
    expect(bare(nl, /\{(n|p|files|count|imported|e|w|i)\} (nieuwe |oudere |ongebruikte )?(?!verplaatsen|uploaden|vervangen|kopiëren|verwijderen|gekozen)[a-z]+(en|s)\b/)).toEqual([]);
  });

  it("has in each translation exactly the source's keys (a key only there is a text nothing asks for)", () => {
    expect(Object.keys(nl).filter((k) => !(k in en))).toEqual([]);
    expect(Object.keys(en).filter((k) => !(k in nl))).toEqual([]);
  });

  it('uses the same placeholders in both languages', () => {
    const differ = Object.keys(en).filter((k) => placeholders(en[k as keyof typeof en]).join() !== placeholders(nl[k as keyof typeof nl] ?? '').join());
    expect(differ).toEqual([]);
  });

  it('has no text that nothing shows', () => {
    // A key in quotes somewhere, or under a prefix that is filled in (`ops.op.${x}`).
    const SRC = join(__dirname, '../..');
    const all: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(svelte|ts)$/.test(f) && !f.endsWith('.test.ts') && !/i18n\/(en|nl)\.ts$/.test(p)) all.push(readFileSync(p, 'utf8'));
      }
    };
    walk(SRC);
    const src = all.join('\n');
    const prefixes = [...src.matchAll(/`([\w.]+\.)\$\{/g)].map((m) => m[1]!);
    const unused = Object.keys(en).filter((k) => !src.includes(`'${k}'`) && !src.includes(`"${k}"`) && !prefixes.some((p) => k.startsWith(p)));
    expect(unused).toEqual([]);
    // Reads every source file: over 5 s on a machine busy with a gate beside it.
  }, 30_000);

  it('a plural form may hold the count itself; a placeholder not given stays as it is', async () => {
    await i18n.setLocale('en');
    expect(i18n.t('term.sharedWith', { n: 1 })).toBe('Shared with 1 person');
    expect(i18n.t('term.sharedWith', { n: 4 })).toBe('Shared with 4 people');
    // A count given as text is a count all the same.
    expect(i18n.t('term.devices', { n: '1' })).toBe('1 device');
    expect(i18n.t('term.devices', {})).toBe('{n} devices');
    expect(i18n.t('term.devices')).toBe(en['term.devices']);
  });

  it('says how long ago (or how soon) in the largest unit that fits, in the app language', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-16T12:00:00Z') });
    try {
      await i18n.setLocale('en');
      expect(i18n.relativeTime(null)).toBe('');
      expect(i18n.relativeTime('2026-10-16T11:59:30Z')).toBe('30 seconds ago');
      expect(i18n.relativeTime('2026-10-16T11:55:00Z')).toBe('5 minutes ago');
      expect(i18n.relativeTime('2026-10-16T09:00:00Z')).toBe('3 hours ago');
      expect(i18n.relativeTime('2026-10-15T12:00:00Z')).toBe('yesterday');
      expect(i18n.relativeTime('2026-10-19T12:00:00Z')).toBe('in 3 days');
      await i18n.setLocale('nl');
      // Short in Dutch: a session's or a passkey's line was cut at 343 px (UIA-08).
      expect(i18n.relativeTime('2026-10-16T11:55:00Z')).toBe('5 min. geleden');
      expect(i18n.dateOnly('2026-09-28T12:00:00Z')).toMatch(/^28 sep\.? 2026$/);
      // The built-in report's name (stored in English) in the reader's language; another as it is.
      expect(i18n.reportName('Weekly report')).toBe(nl['reports.weekly']);
      expect(i18n.reportName('Mine')).toBe('Mine');
      expect(i18n.dateLocale()).toBe('nl');
      await i18n.setLocale('en');
      expect(i18n.dateOnly('2026-09-28T12:00:00Z')).toBe('28 Sep 2026');
      expect(i18n.dateLocale()).toBe('en-GB');
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts in the language chosen before, else the browser's; a choice kept when storage works", async () => {
    const kept: Record<string, string> = {};
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('private mode'); }, setItem: () => { throw new Error('private mode'); } });
    vi.stubGlobal('navigator', { language: 'nl-BE' });
    vi.resetModules();
    const fresh = (await import('./index.svelte.js')) as I18n;
    await fresh.localeReady;
    expect(fresh.locale()).toBe('nl');
    expect(document.documentElement.lang).toBe('nl');
    expect(fresh.t('common.cancel')).toBe(nl['common.cancel']);
    // Not kept (storage off), still chosen for this page.
    await fresh.setLocale('en');
    expect(fresh.locale()).toBe('en');

    vi.stubGlobal('localStorage', { getItem: (k: string) => kept[k] ?? null, setItem: (k: string, v: string) => (kept[k] = v) });
    vi.stubGlobal('navigator', { language: 'de-DE' });
    vi.resetModules();
    const other = (await import('./index.svelte.js')) as I18n;
    expect(other.locale()).toBe('en');
    await other.setLocale('nl');
    expect(kept['burrow.locale']).toBe('nl');
    vi.resetModules();
    expect(((await import('./index.svelte.js')) as I18n).locale()).toBe('nl');
  });

  it('formats dates in the app language, not the browser one', async () => {
    await i18n.setLocale('nl');
    expect(i18n.dateTime('2026-09-28T04:00:00Z')).not.toMatch(/AM|PM/);
    expect(i18n.dateTime('2026-09-28T04:00:00Z')).toMatch(/^28 sep\.? 2026/);
    // In English too: the month in words and 24 hours, never 9/28/26, 4:00 AM.
    await i18n.setLocale('en');
    // Day first, as docs/UI.md says ("28 Sep 2026, 16:05"), not America's "Sep 28, 2026" (A3-WEB-13).
    expect(i18n.dateTime('2026-09-28T16:05:00Z')).toMatch(/^28 Sep 2026, \d\d:05$/);
  });
});
