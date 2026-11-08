import { parseLine } from './tokenize.js';
import {
  asArray,
  knownSpecs,
  loadSpec,
  names,
  type ExecResult,
  type Executor,
  type FigArg,
  type FigGenerator,
  type FigOption,
  type FigSubcommand,
  type FigSuggestion,
} from './specs.js';

// Auto-complete: given the text on the input line, what could come next.
// Sources, in order of weight: the host's history (whole lines), the
// command's completion spec (subcommands, options, arguments, generators that
// ask the host, paths), and snippets. Everything here runs in the browser;
// only generators and path listings go to the server.

export type SuggestionKind = 'history' | 'command' | 'subcommand' | 'option' | 'arg' | 'path' | 'snippet';

export interface Suggestion {
  // Shown on the chip.
  label: string;
  // Typed after the cursor when chosen (never deletes: completions extend).
  insert: string;
  description?: string;
  kind: SuggestionKind;
}

export interface HistoryItem {
  command: string;
  score: number;
  /** How often, and when last (the server's list says; an older one did not). */
  count?: number;
  lastAt?: string;
  /** What usually followed this command on the host (most often first). */
  next?: string[];
}

/**
 * Worth suggesting from history: used `minUses` times or more, or within the
 * hour (what was just typed comes back at once); a one-off is not a
 * prediction (report 94c9eb: one use filled the suggestions).
 */
export function suggestable(h: HistoryItem, minUses: number, now: number): boolean {
  if (h.count === undefined) return true;
  return h.count >= minUses || (!!h.lastAt && now - Date.parse(h.lastAt) < 3_600_000);
}

export interface CompletionContext {
  line: string;
  history: HistoryItem[];
  snippets: { name: string; command: string }[];
  // Runs a generator on the host; returns stdout.
  run: (script: string[] | string, cwd: string | null) => Promise<string>;
  // Lists a directory on the host.
  ls: (path: string) => Promise<{ dir: string; entries: { name: string; dir: boolean }[] }>;
  cwd: string | null;
  /** The quote the word being typed is open in (set by suggest). */
  quote?: '"' | "'" | null;
}

const MAX = 15;
const GENERATOR_TTL_MS = 10_000;
// Per session (its run function): two hosts with the same script and
// directory shared one answer, host A's names offered on host B (audit WL-01).
let genCaches = new WeakMap<CompletionContext['run'], Map<string, { at: number; out: Promise<string> }>>();

/** The suggestion's text to type, given what is already typed of the word. */
// Exactly what is typed: a completion only adds, so "pr" never becomes "Prod.conf" (it became
// "prod.conf", another file on a host that tells case apart, AUDIT2 TERM-10).
function extend(full: string, typed: string, trailer: string): string | null {
  if (!full.startsWith(typed) || full.length < typed.length) return null;
  const rest = full.slice(typed.length);
  if (!rest && !trailer) return null;
  return rest + trailer;
}

/**
 * A spec suggestion as a chip: the name is the label (Fig's displayName can be
 * long), a directory keeps no trailing space, dotfiles only when asked for.
 */
function fromFig(s: FigSuggestion, query: string, kind: SuggestionKind): Suggestion | null {
  if (s.hidden) return null;
  for (const n of names(s)) {
    if (n.startsWith('.') && !query.startsWith('.') && n !== '..' && n !== '.') continue;
    const value = (s.insertValue ?? n).replace(/\{cursor\}/g, '');
    const insert = extend(value, query, value.endsWith('/') ? '' : ' ');
    if (insert === null) continue;
    const description = s.description ?? (s.displayName && s.displayName !== n ? s.displayName : undefined);
    return { label: n, insert, kind, ...(description ? { description } : {}) };
  }
  return null;
}

// ---- walking the spec

interface Position {
  node: FigSubcommand;
  // Options of this node and persistent ones of its parents.
  options: FigOption[];
  args: FigArg[];
  argIndex: number;
  // Waiting for the argument of this option.
  optionArg: FigArg | null;
  usedOptions: Set<string>;
  // A token was an argument that starts a new command (sudo, watch, ...).
  subLine: string[] | null;
}

async function resolveLoad(node: FigSubcommand): Promise<FigSubcommand> {
  if (typeof node.loadSpec === 'string') {
    const loaded = await loadSpec(node.loadSpec);
    if (loaded) return { ...loaded, name: node.name };
  }
  return node;
}

async function walk(root: FigSubcommand, tokens: string[]): Promise<Position> {
  let node = await resolveLoad(root);
  let persistent: FigOption[] = (node.options ?? []).filter((o) => o.isPersistent);
  const pos: Position = {
    node,
    options: node.options ?? [],
    args: asArray(node.args),
    argIndex: 0,
    optionArg: null,
    usedOptions: new Set(),
    subLine: null,
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (pos.optionArg) {
      // One value: this token, whatever it looks like. Several: until an option comes (npm install -w a -w b --save-dev).
      if (!pos.optionArg.isVariadic || !tok.startsWith('-')) {
        if (!pos.optionArg.isVariadic) pos.optionArg = null;
        continue;
      }
      pos.optionArg = null;
    }
    if (tok.startsWith('-') && tok !== '-' && tok !== '--') {
      const [flag, inline] = tok.split('=', 2) as [string, string | undefined];
      const opt = pos.options.find((o) => names(o).includes(flag));
      if (opt) {
        names(opt).forEach((n) => pos.usedOptions.add(n));
        const oargs = asArray(opt.args);
        if (oargs.length && inline === undefined && !oargs[0]!.isOptional) pos.optionArg = oargs[0]!;
      }
      continue;
    }
    const sub = (pos.node.subcommands ?? []).find((s) => names(s).includes(tok));
    if (sub && pos.argIndex === 0) {
      node = await resolveLoad(sub);
      persistent = [...persistent, ...(node.options ?? []).filter((o) => o.isPersistent)];
      pos.node = node;
      pos.options = [...(node.options ?? []), ...persistent.filter((p) => !(node.options ?? []).includes(p))];
      pos.args = asArray(node.args);
      pos.argIndex = 0;
      pos.usedOptions = new Set();
      continue;
    }
    const arg = pos.args[pos.argIndex];
    if (arg?.isCommand) {
      pos.subLine = tokens.slice(i);
      return pos;
    }
    if (!arg?.isVariadic) pos.argIndex++;
  }
  return pos;
}

// ---- producing suggestions for one argument

async function runGenerator(gen: FigGenerator, tokens: string[], ctx: CompletionContext): Promise<FigSuggestion[]> {
  const exec = ((input: string | { command: string; args?: string[]; cwd?: string }) => {
    if (typeof input === 'string') return cachedRun(input, ctx.cwd, ctx);
    const script = [input.command, ...(input.args ?? [])];
    return cachedRun(script, input.cwd ?? ctx.cwd, ctx).then(
      (stdout): ExecResult => ({ stdout, stderr: '', status: 0 }),
      (err: unknown): ExecResult => ({ stdout: '', stderr: String(err), status: 1 }),
    );
  }) as Executor;

  if (gen.custom) {
    const out = await gen.custom(tokens, exec, {
      currentWorkingDirectory: ctx.cwd ?? '~',
      searchTerm: tokens[tokens.length - 1] ?? '',
      currentProcess: 'bash',
      sshPrefix: '',
      environmentVariables: {},
    });
    return out.filter((x): x is FigSuggestion => !!x && typeof x === 'object');
  }
  if (!gen.script) return [];
  let script = typeof gen.script === 'function' ? gen.script(tokens) : gen.script;
  if (!script) return [];
  if (typeof script === 'object' && !Array.isArray(script)) script = [script.command, ...(script.args ?? [])];
  const out = await cachedRun(script, ctx.cwd, ctx);
  if (gen.postProcess) {
    let items: (FigSuggestion | null | undefined)[];
    try {
      items = gen.postProcess(out, tokens);
    } catch {
      return [];
    }
    return items.filter((x): x is FigSuggestion => !!x && typeof x === 'object' && x.name !== undefined);
  }
  if (gen.splitOn !== undefined) {
    return out
      .split(gen.splitOn)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => ({ name }));
  }
  return [];
}

function cachedRun(script: string[] | string, cwd: string | null, ctx: CompletionContext): Promise<string> {
  let cache = genCaches.get(ctx.run);
  if (!cache) genCaches.set(ctx.run, (cache = new Map()));
  const now = Date.now();
  // The old ones go, asked again or not.
  for (const [k, v] of cache) if (now - v.at >= GENERATOR_TTL_MS) cache.delete(k);
  const key = JSON.stringify([script, cwd]);
  const hit = cache.get(key);
  if (hit) return hit.out;
  const out = ctx.run(script, cwd);
  cache.set(key, { at: now, out });
  out.catch(() => cache.delete(key));
  return out;
}

export function clearGeneratorCache(): void {
  genCaches = new WeakMap();
}

/** A control character (a newline ran the line, ESC moves the screen): such a name is never offered. */
// eslint-disable-next-line no-control-regex -- control characters are what it looks for
const CONTROL = /[\x00-\x1f\x7f]/;

/** Shell syntax in a name from the host (a file called "a; rm -rf ~"), escaped: one word, as typed by hand. */
// By whole characters (u): an emoji's two halves each got a backslash, and the name broke (AUDIT2 TERM-08).
export const shellWord = (s: string): string => s.replace(/[^\w./+@%=:,-]/gu, (c) => `\\${c}`);

/** The rest of a name as it goes on in the word being typed: as one word, or inside the quote it is open in (AUDIT2 TERM-09). */
function wordIn(s: string, quote: CompletionContext['quote']): string {
  if (quote === "'") return s.replace(/'/g, "'\\''");
  if (quote === '"') return s.replace(/["\\$`]/g, (c) => `\\${c}`);
  return shellWord(s);
}

/** After a whole name: its quote closed, then the space. */
const wordEnd = (quote: CompletionContext['quote']): string => `${quote ?? ''} `;

async function pathSuggestions(partial: string, foldersOnly: boolean, ctx: CompletionContext): Promise<Suggestion[]> {
  const slash = partial.lastIndexOf('/');
  const dir = slash >= 0 ? partial.slice(0, slash + 1) : '';
  const base = slash >= 0 ? partial.slice(slash + 1) : partial;
  const listing = await ctx.ls(dir || '.').catch(() => null);
  if (!listing) return [];
  const out: Suggestion[] = [];
  for (const e of listing.entries) {
    if (foldersOnly && !e.dir) continue;
    // Hidden files only when asked for with a leading dot.
    if (e.name.startsWith('.') && !base.startsWith('.')) continue;
    if (CONTROL.test(e.name)) continue;
    const rest = extend(e.name, base, '');
    if (rest === null) continue;
    const insert = wordIn(rest, ctx.quote) + (e.dir ? '/' : wordEnd(ctx.quote));
    out.push({ label: e.dir ? `${e.name}/` : e.name, insert, kind: 'path' });
  }
  return out;
}

async function argSuggestions(arg: FigArg, tokens: string[], partial: string, ctx: CompletionContext): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  const add = (s: FigSuggestion, query: string) => {
    const x = fromFig(s, query, 'arg');
    if (x) out.push(x);
  };
  for (const s of arg.suggestions ?? []) add(typeof s === 'string' ? { name: s } : s, partial);

  const templates = asArray(arg.template);
  if (templates.includes('filepaths') || templates.includes('folders')) {
    out.push(...(await pathSuggestions(partial, !templates.includes('filepaths'), ctx)));
  }
  const gens = asArray(arg.generators);
  const results = await Promise.all(
    gens.map(async (g) => {
      const gt = asArray(g.template);
      if (gt.includes('filepaths') || gt.includes('folders')) return pathSuggestions(partial, !gt.includes('filepaths'), ctx);
      try {
        const items = await runGenerator(g, [...tokens, partial], ctx);
        const query =
          typeof g.getQueryTerm === 'function' ? g.getQueryTerm(partial) : typeof g.getQueryTerm === 'string' ? partial.slice(partial.lastIndexOf(g.getQueryTerm) + 1) : partial;
        const pathLike = g.getQueryTerm === '/';
        // What a generator printed on the host is a name too: escaped, like a file's.
        return items
          .map((s) => fromFig(s, query, pathLike ? 'path' : 'arg'))
          .filter((x): x is Suggestion => x !== null && !CONTROL.test(x.insert) && !CONTROL.test(x.label))
          .map((x) => {
            const trailer = /[ /]$/.exec(x.insert)?.[0] ?? '';
            return { ...x, insert: wordIn(x.insert.slice(0, x.insert.length - trailer.length), ctx.quote) + (trailer === ' ' ? wordEnd(ctx.quote) : trailer) };
          });
      } catch {
        return [];
      }
    }),
  );
  for (const r of results) out.push(...r);
  return out;
}

// ---- the entry point

/** Word frequencies from history: how often `word` followed `prefix`. */
function historyBoost(history: HistoryItem[], before: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const h of history) {
    const p = parseLine(`${h.command} `);
    const toks = p.tokens;
    if (toks.length <= before.length) continue;
    if (before.every((b, i) => toks[i] === b)) {
      const w = toks[before.length]!;
      m.set(w, (m.get(w) ?? 0) + h.score);
    }
  }
  return m;
}

export async function suggest(ctx: CompletionContext): Promise<Suggestion[]> {
  const line = ctx.line;
  if (!line.trim()) return [];
  const out: Suggestion[] = [];

  // Whole lines from history that start with what is typed.
  for (const h of ctx.history) {
    if (out.length >= 3) break;
    if (h.command.length > line.length && h.command.startsWith(line) && !h.command.includes('\n')) {
      out.push({ label: h.command, insert: h.command.slice(line.length), kind: 'history' });
    }
  }
  for (const s of ctx.snippets) {
    if (s.command.length > line.length && s.command.startsWith(line)) {
      out.push({ label: s.name, insert: s.command.slice(line.length), kind: 'snippet', description: s.command });
    }
  }

  const parsed = parseLine(line.slice(0));
  const { partial } = parsed;
  ctx = { ...ctx, quote: parsed.quote };
  let tokens = parsed.tokens;
  const spec: Suggestion[] = [];

  // Follow argument commands (sudo, watch, time ...) down to the real one.
  for (let depth = 0; depth < 4; depth++) {
    if (tokens.length === 0) {
      // Typing the command name itself.
      if (!partial) break;
      const boost = historyBoost(ctx.history, []);
      const known = await knownSpecs();
      const seen = new Set<string>();
      const fromHistory = [...boost.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
      for (const name of [...fromHistory, ...[...known].filter((n) => !n.includes('/')).sort()]) {
        if (seen.has(name)) continue;
        seen.add(name);
        const insert = extend(name, partial, ' ');
        if (insert !== null) spec.push({ label: name, insert, kind: 'command' });
        if (spec.length >= MAX) break;
      }
      break;
    }
    const root = await loadSpec(tokens[0]!);
    if (!root) break;
    const pos = await walk(root, tokens.slice(1));
    if (pos.subLine) {
      tokens = pos.subLine;
      continue;
    }
    const boost = historyBoost(ctx.history, tokens);
    const ranked: (Suggestion & { rank: number })[] = [];
    const push = (s: Suggestion, priority = 50, word = '') => ranked.push({ ...s, rank: priority + (boost.get(word) ?? 0) * 20 });

    // A dash after the values of an option that takes several: an option, not another value.
    if (pos.optionArg && !(pos.optionArg.isVariadic && partial.startsWith('-'))) {
      for (const s of await argSuggestions(pos.optionArg, tokens, partial, ctx)) push(s);
    } else if (partial.startsWith('-')) {
      for (const o of pos.options) {
        if (o.hidden) continue;
        if (!o.isRepeatable && names(o).some((n) => pos.usedOptions.has(n))) continue;
        for (const n of names(o)) {
          const hasArg = asArray(o.args).length > 0;
          const insert = extend(n, partial, hasArg && o.requiresSeparator ? '=' : ' ');
          if (insert === null) continue;
          push({ label: n, insert, kind: 'option', ...(o.description ? { description: o.description } : {}) }, o.priority ?? 50, n);
          break;
        }
      }
    } else {
      if (pos.argIndex === 0) {
        for (const s of pos.node.subcommands ?? []) {
          if (s.hidden) continue;
          for (const n of names(s)) {
            const insert = extend(n, partial, ' ');
            if (insert === null) continue;
            push({ label: n, insert, kind: 'subcommand', ...(s.description ? { description: s.description } : {}) }, s.priority ?? 50, n);
            break;
          }
        }
      }
      const arg = pos.args[Math.min(pos.argIndex, pos.args.length - 1)];
      if (arg && (pos.argIndex < pos.args.length || arg.isVariadic)) {
        for (const s of await argSuggestions(arg, tokens, partial, ctx)) push(s, 50, s.label);
      }
    }
    ranked.sort((a, b) => b.rank - a.rank || a.label.localeCompare(b.label));
    spec.push(...ranked.map(({ rank: _rank, ...s }) => s));
    break;
  }

  // Nothing from a spec for a word that looks like a path: offer paths.
  if (!spec.length && tokens.length > 0 && /^(\.{0,2}\/|~\/)/.test(partial)) {
    spec.push(...(await pathSuggestions(partial, false, ctx)));
  }

  const seen = new Set(out.map((s) => s.insert));
  for (const s of spec) {
    if (seen.has(s.insert)) continue;
    seen.add(s.insert);
    out.push(s);
    if (out.length >= MAX) break;
  }
  return out;
}

