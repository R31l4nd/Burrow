import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Conventions of the interface that a look at one screen does not catch.

const SRC = __dirname;
function files(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) files(p, out);
    else if (f.endsWith('.svelte')) out.push(p);
  }
  return out;
}
const sources = files(SRC).map((f) => ({ f: f.slice(SRC.length + 1), src: readFileSync(f, 'utf8') }));

describe('interface conventions', () => {
  it('a pattern with braces is an expression: in quotes Svelte fills them in ("\\d{6}" became "\\d6", no code was ever accepted)', () => {
    const wrong = sources.flatMap(({ f, src }) => [...src.matchAll(/\spattern="[^"]*\{[^"]*"/g)].map((m) => `${f}: ${m[0].trim()}`));
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('a progress bar says what it is the progress of (a screen reader heard only "progress bar", AUDIT WC-17)', () => {
    const wrong = sources.flatMap(({ f, src }) => [...src.matchAll(/<progress\b[^>]*>/g)].filter((m) => !/aria-label(ledby)?=/.test(m[0])).map((m) => `${f}: ${m[0]}`));
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('lines cut off after a few (line-clamp) have no padding above or below: it showed half of the next line (live alerts)', () => {
    const wrong = sources.flatMap(({ f, src }) =>
      [...src.matchAll(/\{[^{}]*line-clamp[^{}]*\}/g)]
        .filter((m) => {
          const rule = m[0].replace(/\/\*[\s\S]*?\*\//g, '');
          const v = (re: RegExp) => re.exec(rule)?.[1]?.trim().split(/\s+/) ?? null;
          const all = v(/(?:^|[\s;{])padding\s*:\s*([^;]+);/);
          // The top and bottom of padding: one value is all four, two or more say top first and bottom third (or first again).
          const vertical = all ? [all[0], all[2] ?? all[0]] : [];
          const sides = [v(/padding-top\s*:\s*([^;]+);/), v(/padding-bottom\s*:\s*([^;]+);/), v(/padding-block\s*:\s*([^;]+);/)].flatMap((x) => x ?? []);
          return [...vertical, ...sides].some((x) => !/^0(px)?$/.test(x!));
        })
        .map((m) => `${f}: ${m[0].replace(/\s+/g, ' ').slice(0, 100)}`),
    );
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('a text link goes somewhere; an action that changes things is a button', () => {
    const wrong = sources.flatMap(({ f, src }) =>
      [...src.matchAll(/<button class="link[\w-]*[" ][^\n]*?onclick=\{([^\n]*?)\}[^\n]*?>/g)]
        // Going to a page, or opening what is written (release notes).
        .filter((m) => !/\bgo\(|notesFor = /.test(m[1]!))
        .map((m) => `${f}: ${m[0].slice(0, 100)}`),
    );
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('motion uses the tokens (--dur-*, --ease), so "less motion" turns all of it off', () => {
    // Every transition and animation, in the components and app.css; a spinner's
    // endless turn is the one exception (each stops itself with less motion).
    const css = [...sources, { f: 'app.css', src: readFileSync(join(SRC, 'app.css'), 'utf8') }];
    const wrong = css.flatMap(({ f, src }) =>
      [...src.matchAll(/^\s*(transition|animation)(?:-duration)?:([^;]*);/gm)]
        .filter((m) => !/^\s*none(\s*!important)?\s*$/.test(m[2]!) && !/\binfinite\b/.test(m[2]!))
        .filter((m) => /\d(ms|s)\b/.test(m[2]!.replace(/var\([^)]*\)/g, '')) || !/var\(--dur-/.test(m[2]!))
        .map((m) => `${f}: ${m[0].trim()}`),
    );
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('reactive state is copied with $state.snapshot: structuredClone throws on its proxies', () => {
    // Only module constants (UPPER_CASE) are plain objects for certain.
    const wrong = sources.flatMap(({ f, src }) => [...src.matchAll(/structuredClone\((?![A-Z][A-Z0-9_]*\b)[^)]*\)/g)].map((m) => `${f}: ${m[0]}`));
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it("an event's currentTarget is read before the first await", () => {
    // After an await the browser has cleared it: "Cannot set properties of
    // null (setting 'value')" when a picture was added to a problem report.
    const wrong: string[] = [];
    for (const { f, src } of sources) {
      for (const m of src.matchAll(/async function (\w+)\([^)]*\)[^{]*\{/g)) {
        let depth = 1;
        let i = m.index! + m[0].length;
        const start = i;
        for (; i < src.length && depth; i++) depth += src[i] === '{' ? 1 : src[i] === '}' ? -1 : 0;
        const body = src.slice(start, i).replace(/\/\/.*$/gm, '');
        const firstAwait = body.search(/\bawait\b/);
        const lastTarget = body.lastIndexOf('currentTarget');
        if (firstAwait >= 0 && lastTarget > firstAwait) wrong.push(`${f}: ${m[1]}`);
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('hover looks only where there is a hover: a tapped help "?" stayed accent-green on the dark title bar (UIA-13)', () => {
    const styles = [...sources.flatMap(({ f, src }) => [...src.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => ({ f, css: m[1]! }))), { f: 'app.css', css: readFileSync(join(SRC, 'app.css'), 'utf8') }];
    const wrong: string[] = [];
    for (const { f, css } of styles) {
      const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
      const stack: string[] = [];
      let from = 0;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') {
          const prelude = text.slice(from, i).trim();
          if (prelude.includes(':hover') && !stack.some((x) => /@media[^{]*\(hover:\s*hover\)/.test(x))) wrong.push(`${f}: ${prelude.replace(/\s+/g, ' ')}`);
          stack.push(prelude);
          from = i + 1;
        } else if (text[i] === '}') {
          stack.pop();
          from = i + 1;
        } else if (text[i] === ';') from = i + 1;
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('a pattern compiles as browsers compile it, with the v flag: [\\w-] did not, and was not checked at all (W-FUNC-13)', () => {
    const wrong = sources.flatMap(({ f, src }) =>
      [...src.matchAll(/\spattern=\{?(['"])((?:\\.|(?!\1).)*)\1\}?/g)].flatMap((m) => {
        const p = m[0].includes('{') ? (JSON.parse(`"${m[2]!.replace(/"/g, '\\"')}"`) as string) : m[2]!;
        try {
          new RegExp(`^(?:${p})$`, 'v');
          return [];
        } catch (e) {
          return [`${f}: ${p} (${(e as Error).message})`];
        }
      }),
    );
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('a comment starts its own line, not after a closing brace', () => {
    // "}  // Pulled down..." came from edits that lost a line break.
    const wrong = sources.flatMap(({ f, src }) => [...src.matchAll(/^\s*\} {2,}\/\/.*$/gm)].map((m) => `${f}: ${m[0].trim()}`));
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('text that starts with a space inside a block keeps it', () => {
    // Svelte drops the whitespace at the start of a block: "{name}{#if x} (optional){/if}"
    // showed "tail(optional)". Write the space as an expression instead.
    const wrong = sources.flatMap(({ f, src }) => [...src.matchAll(/\{(?:#if [^}]*|:else[^}]*)\} +[^\s<{]/g)].map((m) => `${f}: ${m[0]}`));
    expect(wrong, wrong.join('\n')).toEqual([]);
  });
});

describe('e2e conventions', () => {
  it('every spec takes its test from fixtures.ts, so its coverage and presses are counted', () => {
    const dir = join(SRC, '..', '..', 'e2e', 'tests');
    const direct = readdirSync(dir)
      .filter((f) => f.endsWith('.spec.ts'))
      .filter((f) => /import \{[^}]*\btest\b[^}]*\} from '@playwright\/test'/.test(readFileSync(join(dir, f), 'utf8')));
    expect(direct).toEqual([]);
  });
});
