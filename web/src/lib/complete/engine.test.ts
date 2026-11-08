import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearGeneratorCache, shellWord, suggest, suggestable, type CompletionContext } from './engine.js';
import { setSpecImporter } from './specs.js';
import { parseLine } from './tokenize.js';

// Fixture tests against the real Fig specs from node_modules.
const FIG = new URL('../../../../node_modules/@withfig/autocomplete/build/', import.meta.url);

beforeAll(() => {
  setSpecImporter(
    (name) => import(/* @vite-ignore */ new URL(`${name}.js`, FIG).href) as Promise<{ default: unknown }>,
    async () => ((await import(/* @vite-ignore */ new URL('index.js', FIG).href)) as { default: string[] }).default,
  );
});
beforeEach(() => clearGeneratorCache());

const DOCKER_PS = ['{"Names":"radarr","Image":"linuxserver/radarr"}', '{"Names":"sonarr","Image":"linuxserver/sonarr"}'].join('\n');

function ctx(line: string, extra: Partial<CompletionContext> = {}): CompletionContext & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    line,
    history: [],
    snippets: [],
    cwd: '/home/alice',
    calls,
    run: async (script) => {
      calls.push(script);
      const s = Array.isArray(script) ? script.join(' ') : script;
      if (s.startsWith('docker ps')) return DOCKER_PS;
      // Fig's path generator lists with ls -1ApL (directories end in /).
      if (s === 'ls -1ApL') return 'data/\nnotes.txt\n.hidden\n';
      return '';
    },
    ls: async (path) => {
      calls.push(['ls', path]);
      if (path === '/et' || path === '/') return { dir: '/', entries: [{ name: 'etc', dir: true }, { name: 'etcd.conf', dir: false }, { name: 'home', dir: true }] };
      return { dir: path, entries: [{ name: 'notes.txt', dir: false }, { name: 'data', dir: true }, { name: '.hidden', dir: false }] };
    },
    ...extra,
  };
}

const labels = async (c: CompletionContext) => (await suggest(c)).map((s) => s.label);

describe('parseLine', () => {
  it('splits words, honours quotes and takes the last command', () => {
    expect(parseLine('docker logs -f ')).toEqual({ tokens: ['docker', 'logs', '-f'], partial: '', commandStart: 0, quote: null });
    expect(parseLine('echo "a b" c')).toMatchObject({ tokens: ['echo', 'a b'], partial: 'c' });
    expect(parseLine('cat x | grep -i fo')).toMatchObject({ tokens: ['grep', '-i'], partial: 'fo' });
    expect(parseLine('FOO=1 BAR=2 docker lo')).toMatchObject({ tokens: ['docker'], partial: 'lo' });
    expect(parseLine('cd my\\ dir/su')).toMatchObject({ tokens: ['cd'], partial: 'my dir/su' });
  });
});

describe('the phase 2 criterion', () => {
  it('`docker lo` suggests logs, then container names from the host', async () => {
    const first = await suggest(ctx('docker lo'));
    expect(first.map((s) => s.label)).toContain('logs');
    expect(first.find((s) => s.label === 'logs')).toMatchObject({ insert: 'gs ', kind: 'subcommand' });

    const c = ctx('docker logs ');
    const second = await suggest(c);
    expect(second.map((s) => s.label)).toEqual(expect.arrayContaining(['radarr', 'sonarr']));
    expect(c.calls).toContainEqual(['docker', 'ps', '--format', '{{ json . }}']);

    expect((await suggest(ctx('docker logs -f so'))).find((s) => s.label === 'sonarr')).toMatchObject({ insert: 'narr ' });
  });
});

describe('generator answers', () => {
  it("are kept per session: host B never gets host A's container names (audit WL-01)", async () => {
    const on = (names: string) => async (script: string[] | string) => (String(script).startsWith('docker,ps') || String(script).startsWith('docker ps') ? names : '');
    const a = ctx('docker logs ', { run: on('{"Names":"only-on-a","Image":"x"}') });
    const b = ctx('docker logs ', { run: on('{"Names":"only-on-b","Image":"x"}') });
    expect((await suggest(a)).map((s) => s.label)).toContain('only-on-a');
    const fromB = (await suggest(b)).map((s) => s.label);
    expect(fromB).toContain('only-on-b');
    expect(fromB).not.toContain('only-on-a');
  });
});

describe('specs', () => {
  it('suggests options after a dash and skips ones already used', async () => {
    const l = await labels(ctx('docker logs --ta'));
    expect(l).toContain('--tail');
    expect(await labels(ctx('docker logs --tail 10 --ta'))).not.toContain('--tail');
  });

  it('after the values of an option that takes several (npm install -w a b), a dash offers options again', async () => {
    expect(await labels(ctx('npm install -w web --sav'))).toContain('--save-dev');
    expect(await labels(ctx('npm install -w web -w server --save-d'))).toContain('--save-dev');
    // The option after them is taken as one: used, so not offered again.
    expect(await labels(ctx('npm install -w web --save-dev --sav'))).not.toContain('--save-dev');
  });

  it('suggests command names from the spec index', async () => {
    expect(await labels(ctx('systemc'))).toContain('systemctl');
  });

  it('follows sudo to the real command', async () => {
    expect(await labels(ctx('sudo docker lo'))).toContain('logs');
  });

  it('completes paths with the host listing', async () => {
    const s = await suggest(ctx('cat no'));
    expect(s.find((x) => x.label === 'notes.txt')).toMatchObject({ insert: 'tes.txt ', kind: 'path' });
    const dirs = await suggest(ctx('cd '));
    expect(dirs.map((x) => x.label)).toEqual(['data/']);
    expect(await labels(ctx('ls /et'))).toEqual(expect.arrayContaining(['etc/', 'etcd.conf']));
  });

  it("a file's name goes in as one word: shell syntax escaped, control characters never", async () => {
    const evil = ['a; rm -rf ~', 'b\nreboot', 'c$(id)', "d 'q'", 'e\x1b[2J', 'plain.txt'];
    const c = (line: string) => ctx(line, { ls: async (path) => ({ dir: path, entries: evil.map((name) => ({ name, dir: false })) }) });
    const all = await suggest(c('cat '));
    expect(all.map((s) => s.insert).sort()).toEqual(['a\\;\\ rm\\ -rf\\ \\~ ', 'c\\$\\(id\\) ', "d\\ \\'q\\' ", 'plain.txt '].sort());
    // Typed in part already: the rest escaped, what was typed left as it is.
    expect((await suggest(c('cat a\\;'))).map((s) => s.insert)).toEqual(['\\ rm\\ -rf\\ \\~ ']);
    for (const s of all) expect([...s.insert].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)).toBe(false);
  });

  it('a name in an open quote goes on in that quote: escaped for it, the quote closed after (AUDIT2 TERM-09)', async () => {
    const names = ['my file 2.txt', "it's.txt", 'a"b$c.txt', 'docs'];
    const c = (line: string) => ctx(line, { ls: async (path) => ({ dir: path, entries: names.map((name) => ({ name, dir: name === 'docs' })) }) });
    expect(parseLine('cat "my fi')).toMatchObject({ partial: 'my fi', quote: '"' });
    expect((await suggest(c('cat "my f'))).map((s) => s.insert)).toEqual(['ile 2.txt" ']);
    expect((await suggest(c("cat 'it"))).map((s) => s.insert)).toEqual(["'\\''s.txt' "]);
    expect((await suggest(c('cat "a'))).map((s) => s.insert)).toEqual(['\\"b\\$c.txt" ']);
    // A folder: the quote stays open, the path goes on.
    expect((await suggest(c('cat "do'))).map((s) => s.insert)).toEqual(['cs/']);
    // Not in a quote: escaped as one word, as before.
    expect((await suggest(c('cat my'))).map((s) => s.insert)).toEqual(['\\ file\\ 2.txt ']);
  });

  it('a name differing only in case is not changed into another: what is typed is kept, so only exact prefixes (AUDIT2 TERM-10)', async () => {
    const c = (line: string) => ctx(line, { ls: async (path) => ({ dir: path, entries: ['Prod.conf', 'prod.conf'].map((name) => ({ name, dir: false })) }) });
    expect((await suggest(c('cat pr'))).map((s) => [s.label, s.insert])).toEqual([['prod.conf', 'od.conf ']]);
    expect((await suggest(c('cat Pr'))).map((s) => [s.label, s.insert])).toEqual([['Prod.conf', 'od.conf ']]);
  });

  it('shows hidden files only when asked for', async () => {
    expect(await labels(ctx('cat '))).not.toContain('.hidden');
    expect(await labels(ctx('cat .h'))).toContain('.hidden');
  });

  it('ranks subcommands the user actually uses first', async () => {
    const history = [{ command: 'git checkout main', score: 5 }];
    const l = await labels(ctx('git ch', { history }));
    expect(l[1]).toBe('checkout');
  });
});

describe('history and snippets', () => {
  it('offers whole lines from history first', async () => {
    const history = [
      { command: 'docker compose -f /data/docker-compose.yml up -d', score: 3 },
      { command: 'docker ps', score: 1 },
    ];
    const s = await suggest(ctx('docker comp', { history }));
    expect(s[0]).toMatchObject({ kind: 'history', insert: 'ose -f /data/docker-compose.yml up -d' });
  });

  it('offers snippets whose command starts with the line', async () => {
    const s = await suggest(ctx('docker sys', { snippets: [{ name: 'clean up', command: 'docker system df' }] }));
    expect(s[0]).toMatchObject({ kind: 'snippet', insert: 'tem df' });
  });

  it('suggests nothing for an empty line', async () => {
    expect(await suggest(ctx('   '))).toEqual([]);
  });
});

describe('suggestable', () => {
  it('a command from history is suggested once used often enough, or used within the hour (report 94c9eb)', () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    const at = (min: number) => new Date(now - min * 60_000).toISOString();
    expect(suggestable({ command: 'a', score: 1, count: 1, lastAt: at(120) }, 2, now)).toBe(false);
    expect(suggestable({ command: 'a', score: 1, count: 2, lastAt: at(120) }, 2, now)).toBe(true);
    expect(suggestable({ command: 'a', score: 1, count: 1, lastAt: at(30) }, 2, now)).toBe(true);
    expect(suggestable({ command: 'a', score: 1, count: 1, lastAt: at(120) }, 1, now)).toBe(true);
    // An older Burrow's list without counts: as before.
    expect(suggestable({ command: 'a', score: 1 }, 2, now)).toBe(true);
  });
});

describe('a name from the host, as one shell word', () => {
  it('an emoji in it stays whole: one backslash before it, not one per half (AUDIT2 TERM-08)', () => {
    expect(shellWord('a\u{1F600}b')).toBe('a\\\u{1F600}b');
    expect(shellWord('my file')).toBe('my\\ file');
  });
});
