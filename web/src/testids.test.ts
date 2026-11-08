import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every control a test can find by its test id (a button, link, field or
// choice with data-testid) is used by some test: the end-to-end tests, or
// the Android app's. A new button without a test fails here; a control that
// no test can reach is listed below, with why.

const ROOT = join(__dirname, '..', '..');
const UNREACHABLE: Record<string, string> = {
  'stepup-sso': 'goes to the identity provider for a step-up; the e2e provider does sign-in and invites only',
  'keep-open': "only shown for a direct session through the app's WireGuard; WireGuardTest.w3 tests what it sets (KeepAlive, its notification, the tunnel staying up)",
};

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) files(p, ext, out);
    else if (ext.test(f)) out.push(p);
  }
  return out;
}

describe('test ids', () => {
  it('every control with a test id is pressed or filled by a test', () => {
    const controls = new Set<string>();
    for (const f of files(join(ROOT, 'web', 'src'), /\.svelte$/)) {
      // A literal test id on a tag that is a control: the tag is the last
      // one opened before it (attributes hold "=>", so no [^>]* here).
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\sdata-testid="([a-z0-9-]+)"/g)) {
        const tag = [...src.slice(0, m.index).matchAll(/<([a-zA-Z][\w-]*)/g)].pop()?.[1];
        if (tag && /^(button|a|input|select|textarea)$/.test(tag)) controls.add(m[1]!);
      }
    }
    const tests = [...files(join(ROOT, 'e2e', 'tests'), /\.ts$/), ...files(join(ROOT, 'android', 'app', 'src', 'androidTest'), /\.kt$/)].map((f) => readFileSync(f, 'utf8')).join('\n');
    const untested = [...controls].filter((id) => !(id in UNREACHABLE) && !tests.includes(`'${id}'`) && !tests.includes(`=${id}]`)).sort();
    expect(untested, untested.join(" ")).toEqual([]);
    expect(controls.size).toBeGreaterThan(100);
  });
});
