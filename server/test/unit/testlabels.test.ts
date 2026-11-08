import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The live Burrow on this machine watches its Docker; the tests start
// containers there too. Without the label burrow.ignore=true each one that
// crashes on purpose is a live alert (an integration stack did: two days of
// "burrowtest-upd-app-1 exited" on the live Alerts page).

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const files = ['server/test/integration', 'e2e/tests'].flatMap((d) =>
  readdirSync(join(ROOT, d))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ f: `${d}/${f}`, src: readFileSync(join(ROOT, d, f), 'utf8') })),
);

describe('containers the tests start carry burrow.ignore=true', () => {
  it('docker run', () => {
    const wrong = files.flatMap(({ f, src }) => [...src.matchAll(/docker run [^`'"\n]*/g)].filter((m) => !/--label burrow\.ignore=true/.test(m[0])).map((m) => `${f}: ${m[0].slice(0, 80)}`));
    expect(wrong, wrong.join('\n')).toEqual([]);
  });

  it('a compose file a test starts (one with a restart policy), on every service', () => {
    const wrong = files.flatMap(({ f, src }) =>
      [...src.matchAll(/printf '(services:[^']*)'/g)]
        .filter((m) => /restart:/.test(m[1]!))
        .filter((m) => (m[1]!.match(/burrow\.ignore/g) ?? []).length < (m[1]!.match(/\\{1,2}n {2}\w[\w-]*:\\{1,2}n/g) ?? []).length)
        .map((m) => `${f}: ${m[1]!.slice(0, 80)}`),
    );
    expect(wrong, wrong.join('\n')).toEqual([]);
  });
});
