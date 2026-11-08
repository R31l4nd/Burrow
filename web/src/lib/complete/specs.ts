// Completion specs from @withfig/autocomplete (MIT): one ES module per CLI,
// served under /fig/ and loaded on first use. Only the structure Burrow uses
// is typed here; the specs are plain data plus a few functions.

type Named = { name: string | string[] };

export interface FigSuggestion extends Named {
  description?: string;
  insertValue?: string;
  priority?: number;
  hidden?: boolean;
  displayName?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  status: number;
}

export type Executor = {
  (command: string): Promise<string>;
  (input: { command: string; args?: string[]; cwd?: string }): Promise<ExecResult>;
};

export interface FigGenerator {
  template?: string | string[];
  script?: string | string[] | ((tokens: string[]) => string | string[] | { command: string; args?: string[] } | undefined);
  postProcess?: (out: string, tokens: string[]) => (FigSuggestion | undefined | null)[];
  splitOn?: string;
  custom?: (
    tokens: string[],
    exec: Executor,
    context: { currentWorkingDirectory: string; searchTerm: string; currentProcess: string; sshPrefix: string; environmentVariables: Record<string, string> },
  ) => Promise<(FigSuggestion | undefined)[]>;
  getQueryTerm?: string | ((token: string) => string);
  filterTemplateSuggestions?: (s: FigSuggestion[]) => FigSuggestion[];
  trigger?: unknown;
}

export interface FigArg {
  name?: string;
  description?: string;
  isOptional?: boolean;
  isVariadic?: boolean;
  isCommand?: boolean;
  suggestions?: (string | FigSuggestion)[];
  template?: string | string[];
  generators?: FigGenerator | FigGenerator[];
  loadSpec?: string;
}

export interface FigOption extends Named {
  description?: string;
  args?: FigArg | FigArg[];
  isPersistent?: boolean;
  isRepeatable?: boolean | number;
  priority?: number;
  hidden?: boolean;
  requiresSeparator?: boolean | string;
}

export interface FigSubcommand extends Named {
  description?: string;
  subcommands?: FigSubcommand[];
  options?: FigOption[];
  args?: FigArg | FigArg[];
  loadSpec?: string | unknown;
  priority?: number;
  hidden?: boolean;
}

export type SpecImporter = (name: string) => Promise<{ default: unknown }>;

// In the browser: /fig/<name>.js, served next to the app. Tests replace it.
let importer: SpecImporter = (name) => import(/* @vite-ignore */ `/fig/${name}.js`) as Promise<{ default: unknown }>;
const INDEX_URL = '/fig/index.js';
let indexImporter: () => Promise<string[]> = async () =>
  ((await import(/* @vite-ignore */ INDEX_URL)) as { default: string[] }).default;

export function setSpecImporter(fn: SpecImporter, index: () => Promise<string[]>): void {
  importer = fn;
  indexImporter = index;
  cache.clear();
  specIndex = null;
}

const cache = new Map<string, Promise<FigSubcommand | null>>();
let specIndex: Promise<Set<string>> | null = null;

export function knownSpecs(): Promise<Set<string>> {
  // Failed (offline, a deploy in between): not kept, asked again next time (AUDIT2 TERM-11).
  specIndex ??= indexImporter()
    .then((l) => new Set(l))
    .catch(() => {
      specIndex = null;
      const none = new Set<string>();
      unread.add(none);
      return none;
    });
  return specIndex;
}

// An index that could not be read: a name missing from it is not "no spec".
const unread = new WeakSet<Set<string>>();

/** Load a spec by name ("docker", "aws/s3"); null if there is none. */
export function loadSpec(name: string): Promise<FigSubcommand | null> {
  if (!/^[@a-z0-9._/+-]+$/i.test(name) || name.includes('..')) return Promise.resolve(null);
  let p = cache.get(name);
  if (!p) {
    p = (async () => {
      const known = await knownSpecs();
      if (!name.includes('/') && !known.has(name)) {
        if (unread.has(known)) throw new Error('no spec index');
        return null;
      }
      const mod = await importer(name);
      const spec = mod.default;
      // A few specs export a function of the version; those are skipped.
      return spec && typeof spec === 'object' ? (spec as FigSubcommand) : null;
    })().catch(() => {
      // A spec that failed to load is tried again, not remembered as none.
      cache.delete(name);
      return null;
    });
    cache.set(name, p);
  }
  return p;
}

export const names = (x: Named): string[] => (Array.isArray(x.name) ? x.name : [x.name]);
export const asArray = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
