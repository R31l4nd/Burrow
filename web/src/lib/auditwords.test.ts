import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTAINER_ACTIONS, GUEST_ACTIONS, STACK_OPS } from '@burrow/shared';
import en from './i18n/en.json';
import nl from './i18n/nl.json';

// The audit log in words: every action the server writes has a label in
// both languages (UIA-07, UIB-11: "auth.login", "terminal.open" raw).
const SERVER = join(__dirname, '..', '..', '..', 'server', 'src');
function files(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) files(p, out);
    else if (f.endsWith('.ts')) out.push(p);
  }
  return out;
}
/** The actions of each audit(ctx, actor, 'x.y', ...) call, a choice of two ("ok ? 'auth.login' : 'auth.login_failed'") too. */
const actions = [
  ...new Set(
    files(SERVER).flatMap((f) => {
      const src = readFileSync(f, 'utf8');
      return [...src.matchAll(/\baudit\(/g)].flatMap((m) => [...src.slice(m.index + 6, m.index + 400).split(');')[0]!.matchAll(/'([a-z_]+\.[a-z_]+(?:\.[a-z_]+)?)'/g)].map((x) => x[1]!));
    }),
  ),
  // Made from a choice: `container.${action}` (and _failed), `stack.${op}`, `git.${op}`, `pve.${action}`.
  ...CONTAINER_ACTIONS.flatMap((a) => [`container.${a}`, `container.${a}_failed`]),
  ...STACK_OPS.map((o) => `stack.${o}`),
  'git.pull',
  'git.push',
  ...GUEST_ACTIONS.map((a) => `pve.${a}`),
].sort();

describe('audit log words', () => {
  it('finds the actions the server writes', () => {
    expect(actions.length).toBeGreaterThan(80);
    expect(actions).toContain('auth.login');
  });
  it('every action has a label in English and Dutch', () => {
    const missing = actions.filter((a) => !(`audit.action.${a}` in en) || !(`audit.action.${a}` in nl));
    expect(missing, missing.join('\n')).toEqual([]);
  });
});
