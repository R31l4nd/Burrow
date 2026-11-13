import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Burrow's own error messages in the app's language (A3-WEB-13): a known
// code with exactly the words the catalogue holds is said from the
// catalogue; anything else stays as the server said it.
vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' } } });
});
const { ApiFailure, errorMessage, transportWords } = await import('./api.js');
const { setLocale } = await import('./i18n/index.svelte.js');
const { en } = await import('./i18n/en.js');


// The server's errors: every new HttpError(status, 'code', message), with the
// messages it can send as samples (a template's parts as "x7", both sides of a
// choice, an expression of the host's or a library's words as HOST_WORDS).
const HOST_WORDS = 'some words of the host';
function serverSource(): string {
  const root = join(import.meta.dirname, '..', '..', '..', 'server', 'src');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  };
  walk(root);
  return files.map((f) => `//@file ${f.slice(root.length + 1)}\n${readFileSync(f, 'utf8')}`).join('\n');
}
/** The end of a bracketed or quoted part starting at i (its closing character's index). */
function closing(src: string, i: number): number {
  const open = src[i]!;
  if (open === "'" || open === '"') {
    for (let j = i + 1; j < src.length; j++) if (src[j] === '\\') j++;
    else if (src[j] === open) return j;
  }
  if (open === '`') {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '$' && src[j + 1] === '{') j = closing(src, j + 1);
      else if (src[j] === '`') return j;
    }
  }
  const close = { '(': ')', '{': '}', '[': ']' }[open]!;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j]!;
    if (c === close) return j;
    if ('\'"`({['.includes(c)) j = closing(src, j);
  }
  return src.length;
}
/** Splits at a separator outside brackets and quotes. */
function splitTop(src: string, sep: RegExp): string[] {
  const out: string[] = [];
  let from = 0;
  for (let j = 0; j < src.length; j++) {
    const c = src[j]!;
    if ('\'"`({['.includes(c)) j = closing(src, j);
    else {
      const m = sep.exec(src.slice(j));
      if (m && m.index === 0) {
        out.push(src.slice(from, j));
        j += m[0].length - 1;
        from = j + 1;
      }
    }
  }
  out.push(src.slice(from));
  return out.map((x) => x.trim());
}
function samples(expr: string): string[] {
  expr = expr.trim();
  if (!expr) return [];
  const either = splitTop(expr, /\|\||\?\?/);
  if (either.length > 1) return either.flatMap(samples);
  const choice = splitTop(expr, /\?/);
  if (choice.length === 2) {
    const [yes, no] = splitTop(choice[1]!, /:/);
    return [...samples(yes ?? ''), ...samples(no ?? '')];
  }
  if (/^'(?:[^'\\]|\\.)*'$/.test(expr) || /^"(?:[^"\\]|\\.)*"$/.test(expr)) return [expr.slice(1, -1).replace(/\\(.)/g, '$1')];
  if (expr.startsWith('`') && closing(expr, 0) === expr.length - 1) {
    let out = [''];
    const body = expr.slice(1, -1);
    for (let j = 0; j < body.length; j++) {
      if (body[j] === '$' && body[j + 1] === '{') {
        const end = closing(body, j + 1);
        const inner = body.slice(j + 2, end);
        const parts = splitTop(inner, /\?/).length === 2 ? samples(inner) : ['x7'];
        out = out.flatMap((o) => parts.map((p) => o + (p.includes(HOST_WORDS) ? 'x7' : p)));
        j = end;
      } else out = out.map((o) => o + body[j]);
    }
    return out;
  }
  return [HOST_WORDS];
}
function serverErrors(): { code: string; samples: string[]; file: string }[] {
  const src = serverSource();
  const out: { code: string; samples: string[]; file: string }[] = [];
  for (const m of src.matchAll(/new HttpError\(/g)) {
    const end = closing(src, m.index + m[0].length - 1);
    // A trailing comma (a call over several lines) is no argument.
    const args = splitTop(src.slice(m.index + m[0].length, end), /,/).filter((a) => a.trim());
    // Either quote: files/service.ts says its codes in double quotes, and these went unchecked ("No permission" in English in the Dutch app).
    const code = /^\s*(['"])([a-z_0-9]+)\1\s*$/.exec(args[1] ?? '')?.[2];
    if (!code) continue;
    const file = /\/\/@file (\S+)/.exec(src.slice(src.lastIndexOf('//@file ', m.index)))![1]!;
    out.push({ code, samples: args[2] ? samples(args.slice(2).join(', ')) : [code], file });
  }
  return out;
}

describe('server errors in the Dutch UI', () => {
  it('a known code with its usual words is said in Dutch; other words for that code stay as they came', async () => {
    await setLocale('nl');
    expect(errorMessage(new ApiFailure(409, 'last_admin', 'There must be at least one admin.'))).toBe('Er moet minstens één beheerder zijn.');
    expect(errorMessage(new ApiFailure(409, 'last_admin', 'Something else, with a detail: web-1.'))).toBe('Something else, with a detail: web-1.');
    expect(errorMessage(new ApiFailure(500, 'internal', 'internal'))).toBe('Er ging iets mis in Burrow.');
    expect(errorMessage(new ApiFailure(403, 'invalid_setup_token', 'invalid_setup_token'))).toBe('Ongeldige setup-token: kopieer hem opnieuw uit het log van Burrow.');
    await setLocale('en');
    expect(errorMessage(new ApiFailure(409, 'last_admin', 'There must be at least one admin.'))).toBe('There must be at least one admin.');
  });

  it('the catalogue has words for what the server sends, not codes it no longer sends (they drift apart otherwise)', () => {
    const server = serverSource();
    const sent = new Set([...serverErrors().map((e) => e.code), ...[...server.matchAll(/error: '([a-z_0-9]+)'/g)].map((m) => m[1]!), 'unknown_host_key', 'host_key_mismatch']);
    const stale = Object.keys(en)
      .filter((k) => k.startsWith('error.') && !k.startsWith('error.net.'))
      .filter((k) => !sent.has(k.slice(6).split('.')[0]!));
    expect(stale).toEqual([]);
  });

  it('every error the server sends reads in Dutch in the Dutch app: none of its English, no raw code (W-FUNC-06)', async () => {
    const errors = serverErrors();
    expect(errors.length).toBeGreaterThan(150);
    await setLocale('nl');
    const english = errors.flatMap((e) => e.samples.filter((m) => [m, e.code.replace(/_/g, ' ')].includes(errorMessage(new ApiFailure(400, e.code, m)))).map((m) => `${e.code}: ${m} (${e.file})`));
    await setLocale('en');
    // And in English the server's own sentence, as it wrote it (the catalogue mirrors it).
    // (Or within a sentence of ours: a host's "git exited with 1" as "git said: git exited with 1".)
    const changed = errors.flatMap((e) => e.samples.filter((m) => !m.includes(HOST_WORDS) && m !== e.code && !errorMessage(new ApiFailure(400, e.code, m)).includes(m)).map((m) => `${e.code}: ${m} -> ${errorMessage(new ApiFailure(400, e.code, m))}`));
    expect(english, english.join('\n')).toEqual([]);
    expect(changed, changed.join('\n')).toEqual([]);
  });

  it("a library's or the network's own words said in Burrow's", async () => {
    await setLocale('en');
    expect(errorMessage(new ApiFailure(502, 'send_failed', 'connect ECONNREFUSED 172.23.0.7:2525'))).toBe('Not sent: Nothing answered on 172.23.0.7 port 2525.');
    expect(errorMessage(new ApiFailure(502, 'host_unreachable', 'Timed out while waiting for handshake'))).toBe('The host could not be reached: The host did not answer the SSH connection in time.');
    expect(errorMessage(new ApiFailure(502, 'host_unreachable', 'getaddrinfo ENOTFOUND nas.lan'))).toBe('The host could not be reached: The name nas.lan is not known (DNS).');
    // The whole address, not cut at its first dot (report 8b783c: "No way to reach 10 from here..0.0.9:22").
    expect(transportWords('connect EHOSTUNREACH 10.0.0.9:22')).toBe('No way to reach 10.0.0.9 from here.');
    expect(transportWords('connect EHOSTUNREACH nas.lan')).toBe('No way to reach nas.lan from here.');
    await setLocale('nl');
    expect(errorMessage(new ApiFailure(403, 'no_file_access', 'No access to /home/tester on this host. Folders you may open here: /home/tester/shared.'))).toBe('Geen toegang tot /home/tester op deze host. Mappen die je hier mag openen: /home/tester/shared.');
    await setLocale('en');
  });
});
