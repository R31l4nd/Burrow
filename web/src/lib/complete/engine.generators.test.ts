import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearGeneratorCache, suggest, type CompletionContext } from './engine.js';
import { setSpecImporter, type FigSubcommand } from './specs.js';

// The completion engine against a spec of its own ("tool"), one of each
// kind Fig's specs use: generators as a script (text, a list, a function,
// an object), split or post-processed, custom ones that run commands
// themselves, options that take an argument, a subcommand loaded from
// another spec. What is checked is what the chips offer and what was run
// on the host.

const tool: FigSubcommand = {
  name: 'tool',
  options: [
    { name: ['-n', '--network'], args: { name: 'net', generators: { script: ['tool', 'networks'], splitOn: '\n' } } },
    { name: '--level', requiresSeparator: true, args: { name: 'level', suggestions: ['debug', 'info', { name: 'trace', hidden: true }] } },
    { name: '--tag', isRepeatable: true, args: { name: 'tag', isVariadic: true, suggestions: ['alpha', 'beta'] } },
    { name: '--quiet', description: 'Say less', priority: 80 },
    { name: '--secret', hidden: true },
    { name: '--global', isPersistent: true },
  ],
  subcommands: [
    { name: 'fn', args: { name: 'x', generators: { script: (tokens: string[]) => ['echo', tokens.at(-2) ?? ''], postProcess: (out: string) => out.split(' ').map((name) => ({ name })) } } },
    { name: 'obj', args: { name: 'x', generators: { script: () => ({ command: 'printf', args: ['a\\nb'] }), splitOn: '\n' } } },
    { name: 'none', args: { name: 'x', generators: [{ script: () => undefined }, {}, { script: 'true' }] } },
    { name: 'broken', args: { name: 'x', generators: { script: 'fail', postProcess: () => { throw new Error('bad output'); } } } },
    { name: 'dies', args: { name: 'x', generators: { script: 'explode', splitOn: '\n' } } },
    {
      name: 'custom',
      args: {
        name: 'x',
        generators: {
          custom: async (_tokens, exec, context) => {
            const text = await exec('list-things');
            const res = await exec({ command: 'stat', args: ['-c', '%n'], cwd: '/srv' });
            const bad = await exec({ command: 'explode' });
            return [...text.split(' ').map((name) => ({ name })), { name: `${res.stdout}-${res.status}` }, { name: `err-${bad.status}` }, { name: `in-${context.currentWorkingDirectory}` }, undefined];
          },
        },
      },
    },
    { name: 'files', args: { name: 'f', generators: { template: 'filepaths' } } },
    { name: 'dirs', args: { name: 'd', template: 'folders' } },
    { name: 'paths', args: { name: 'p', generators: { script: 'ls-like', splitOn: '\n', getQueryTerm: '/' } } },
    { name: 'query', args: { name: 'q', generators: { script: 'words', splitOn: ' ', getQueryTerm: (t: string) => t.slice(t.indexOf(':') + 1) } } },
    { name: 'hidden-sub', hidden: true },
    { name: 'plugin', loadSpec: 'tool/plugin' },
    { name: 'gone', loadSpec: 'nothing-here' },
    { name: 'run', args: { name: 'cmd', isCommand: true } },
  ],
};
const plugin: FigSubcommand = { name: 'tool-plugin', subcommands: [{ name: 'install', description: 'Add a plugin' }] };

let ran: { script: string[] | string; cwd: string | null }[] = [];
// One terminal session: its generators' answers are cached per session (its run function).
const run: CompletionContext['run'] = async (script, cwd) => {
  ran.push({ script, cwd });
  const s = Array.isArray(script) ? script.join(' ') : script;
  if (s === 'tool networks') return 'bridge\nhost\nmy net\n';
  if (s.startsWith('echo ')) return `${s.slice(5)}1 ${s.slice(5)}2`;
  if (s === 'printf a\\nb') return 'a\nb';
  if (s === 'list-things') return 'apple avocado';
  if (s === 'stat -c %n') return 'statted';
  if (s === 'ls-like') return 'usr/\netc/';
  if (s === 'words') return 'red green';
  if (s === 'explode') throw new Error('no such command');
  return '';
};
function ctx(line: string, extra: Partial<CompletionContext> = {}): CompletionContext {
  return {
    line,
    history: [],
    snippets: [],
    cwd: '/home/alice',
    run,
    ls: async (path) => {
      if (path === 'gone/') throw new Error('No such file');
      return { dir: path, entries: [{ name: 'notes.txt', dir: false }, { name: 'data', dir: true }] };
    },
    ...extra,
  };
}
const offered = async (line: string, extra?: Partial<CompletionContext>) => (await suggest(ctx(line, extra))).map((s) => `${s.label}=${s.insert}`);

beforeEach(() => {
  ran = [];
  clearGeneratorCache();
  setSpecImporter(
    async (name) => ({ default: name === 'tool' ? tool : name === 'tool/plugin' ? plugin : name === 'versioned' ? () => tool : undefined }),
    async () => ['tool', 'versioned', 'toolbox', 'nothing-here'],
  );
});

describe('generators', () => {
  it("an option's argument: the generator's lines, split, escaped as one word", async () => {
    expect(await offered('tool --network ')).toEqual(['bridge=bridge ', 'host=host ', 'my net=my\\ net ']);
    expect(ran).toEqual([{ script: ['tool', 'networks'], cwd: '/home/alice' }]);
    // Given inline (--network=x), the option takes no more: the next word is the command's.
    expect(await offered('tool --network=host q')).toEqual(['query=uery ']);
  });

  it('a script made from the words typed, its output post-processed', async () => {
    expect(await offered('tool fn ')).toEqual(['fn1=fn1 ', 'fn2=fn2 ']);
  });

  it('a script given as a command and its arguments', async () => {
    expect(await offered('tool obj ')).toEqual(['a=a ', 'b=b ']);
    expect(ran[0]!.script).toEqual(['printf', 'a\\nb']);
  });

  it('no script, an empty one, or output it cannot read: nothing offered, nothing broken', async () => {
    expect(await offered('tool none ')).toEqual([]);
    expect(await offered('tool broken ')).toEqual([]);
    expect(await offered('tool dies ')).toEqual([]);
  });

  it('a custom generator runs its commands on the host, in the folder it names, failures as a status', async () => {
    expect(await offered('tool custom a')).toEqual(['apple=pple ', 'avocado=vocado ']);
    expect(await offered('tool custom ')).toEqual(['apple=apple ', 'avocado=avocado ', 'err-1=err-1 ', 'in-/home/alice=in-/home/alice ', 'statted-0=statted-0 ']);
    expect(ran.find((r) => Array.isArray(r.script) && r.script[0] === 'stat')).toEqual({ script: ['stat', '-c', '%n'], cwd: '/srv' });
    // Asked again within its time: from the cache, not run again; only the one that failed is.
    const before = ran.length;
    await offered('tool custom av');
    expect(ran.slice(before).map((r) => r.script)).toEqual([['explode']]);
  });

  it('a cached answer goes after its time and is asked again; a failed one is not kept', async () => {
    vi.useFakeTimers();
    try {
      await offered('tool --network ');
      await offered('tool --network ');
      expect(ran).toHaveLength(1);
      vi.advanceTimersByTime(10_001);
      await offered('tool --network ');
      expect(ran).toHaveLength(2);
      await offered('tool dies ');
      await offered('tool dies ');
      expect(ran.filter((r) => r.script === 'explode')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('paths: from the listing for files, folders only where only folders go; a listing that fails offers nothing', async () => {
    expect(await offered('tool files ')).toEqual(['data/=data/', 'notes.txt=notes.txt ']);
    expect(await offered('tool dirs ')).toEqual(['data/=data/']);
    expect(await offered('tool files gone/')).toEqual([]);
  });

  it("a generator's query term: only what follows it is matched; one that is a path keeps its slash", async () => {
    expect(await offered('tool paths u')).toEqual(['usr/=sr/']);
    expect(await offered('tool query color:gr')).toEqual(['green=een ']);
  });
});

describe('options', () => {
  it('the ones that fit what is typed, ranked by priority; hidden and used ones not offered again, repeatable ones are', async () => {
    const all = await suggest(ctx('tool --'));
    expect(all.map((s) => s.label)).toEqual(['--quiet', '--global', '--level', '--network', '--tag']);
    expect(all[0]).toMatchObject({ description: 'Say less', kind: 'option' });
    // An option that needs "=" gets it, not a space.
    expect(all.find((s) => s.label === '--level')!.insert).toBe('level=');
    expect((await offered('tool --quiet --tag a --')).map((s) => s.split('=')[0])).toEqual(['--global', '--level', '--network', '--tag']);
    expect((await offered('tool --tag a --quiet --')).map((s) => s.split('=')[0])).toEqual(['--global', '--level', '--network', '--tag']);
    // Under a subcommand, its parent's persistent option still.
    expect(await offered('tool fn --g')).toEqual(['--global=lobal ']);
  });

  it("an option's fixed values; a hidden one not offered", async () => {
    expect(await offered('tool --level ')).toEqual(['debug=debug ', 'info=info ']);
    // Variadic: after one value, still values.
    expect(await offered('tool --tag alpha b')).toEqual(['beta=eta ']);
  });
});

describe('subcommands and specs', () => {
  it('hidden ones are not offered; one loaded from another spec has its own subcommands', async () => {
    const subs = (await suggest(ctx('tool '))).map((s) => s.label);
    expect(subs).toContain('plugin');
    expect(subs).not.toContain('hidden-sub');
    expect(await suggest(ctx('tool plugin '))).toEqual([{ label: 'install', insert: 'install ', kind: 'subcommand', description: 'Add a plugin' }]);
    // A spec that is not there: the subcommand as it is in the parent.
    expect(await offered('tool gone ')).toEqual([]);
  });

  it('a command argument goes on as a command of its own', async () => {
    expect(await offered('tool run tool fn ')).toEqual(['fn1=fn1 ', 'fn2=fn2 ']);
  });

  it('a spec that is a function of the version is skipped; then a word like a path is completed as one', async () => {
    expect(await offered('versioned ./')).toEqual(['notes.txt=notes.txt ', 'data/=data/']);
    expect(await offered('versioned x')).toEqual([]);
  });

  it('command names: the ones used before first, by how often', async () => {
    const history = [
      { command: 'toolbox up', score: 1 },
      { command: 'tool fn', score: 5 },
      { command: 'toolbox down', score: 1 },
    ];
    expect((await suggest(ctx('too', { history }))).filter((s) => s.kind === 'command').map((s) => s.label)).toEqual(['tool', 'toolbox']);
    // History boosts a subcommand used often.
    expect((await suggest(ctx('tool ', { history }))).filter((s) => s.kind === 'subcommand')[0]!.label).toBe('fn');
  });
});
