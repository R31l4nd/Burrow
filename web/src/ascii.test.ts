import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from './lib/i18n/en.js';
import { nl } from './lib/i18n/nl.js';

// Plain ASCII in everything written: interface text, code, comments and
// docs. No typographic quotes, dashes, arrows or dots, no symbols standing
// in for icons (those are SVG icons, Icon.svelte). Dutch letters stay:
// without them the words are wrong.

const ROOT = join(__dirname, '../..');
const PLACES = ['web/src', 'server/src', 'server/test', 'shared/src', 'e2e/tests', 'android/app/src', 'docs', 'deploy', 'scripts', 'README.md', 'CHANGELOG.md', 'CLAUDE.md'];
const TEXT = /\.(ts|svelte|css|html|kt|kts|xml|md|sh|py|json|yaml|yml|txt|sql)$/;
const LETTERS = 'áàäéèëíïóöúüçÉËÏÖÜ';
// Where another character is the point: prompt ends a shell draws, and
// tests that feed multi-byte text through a parser.
const ALLOWED: Record<string, string> = {
  'web/src/lib/complete/line.ts': '\u276f\u00bb\u279c\u03bb',
  'web/src/lib/complete/line.test.ts': '\u276f\u2502',
  'server/test/unit/docker.test.ts': '\u20ac',
  'server/test/unit/lsp.test.ts': '\u2713',
};

function walk(p: string, out: string[] = []): string[] {
  if (!existsSync(p)) return out;
  if (statSync(p).isDirectory()) {
    for (const f of readdirSync(p)) if (!['node_modules', 'build', 'dist', 'assets', 'fdroid'].includes(f)) walk(join(p, f), out);
  } else if (TEXT.test(p)) out.push(p);
  return out;
}

describe('plain ASCII', () => {
  it('in text, code, comments and docs (Dutch letters aside)', () => {
    const found: string[] = [];
    for (const place of PLACES) {
      for (const file of walk(join(ROOT, place))) {
        const rel = relative(ROOT, file);
        const ok = LETTERS + (ALLOWED[rel] ?? '');
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            const bad = [...line].filter((ch) => ch.charCodeAt(0) > 127 && !ok.includes(ch));
            if (bad.length) found.push(`${rel}:${i + 1}: ${[...new Set(bad)].join(' ')}`);
          });
      }
    }
    expect(found, found.slice(0, 40).join('\n')).toEqual([]);
  });

  it('in what the interface shows, escapes decoded (a \\u2019 in the source is still a typographic quote on screen, AUDIT2 TEST-25)', () => {
    const found = Object.entries({ ...prefixed('en', en), ...prefixed('nl', nl) })
      .filter(([, text]) => [...text].some((ch) => ch.charCodeAt(0) > 127 && !LETTERS.includes(ch)))
      .map(([key, text]) => `${key}: ${text}`);
    expect(found, found.slice(0, 40).join('\n')).toEqual([]);
  });
});

function prefixed(lang: string, dict: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(dict).map(([k, v]) => [`${lang}.${k}`, v]));
}
