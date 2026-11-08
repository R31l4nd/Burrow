// Snippet variables. Free of zod so the web app can import it cheaply
// (@burrow/shared/snippets).
//
//   {{name}}          filled in each time
//   {{name=value}}    filled in with value, which can be changed
//   {{name=}}         may stay empty
//   {{name=a|b|c}}    one of these (the first to start with)
//   {{container}}     offers the running containers of the host(s)

const VARIABLE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*(?:=([^}]*))?\}\}/g;

export interface SnippetVariable {
  name: string;
  /** What it starts with ('' when none). */
  value: string;
  /** Choices ({{name=a|b}}); empty for a free value. */
  choices: string[];
  /** May stay empty ({{name=}}). */
  optional: boolean;
}

/** The variables in a snippet, each once, in order; the first to say more than its name wins. */
export function snippetVariables(command: string): SnippetVariable[] {
  const out: SnippetVariable[] = [];
  for (const m of command.matchAll(VARIABLE)) {
    const spec = m[2];
    const v: SnippetVariable =
      spec === undefined
        ? { name: m[1]!, value: '', choices: [], optional: false }
        : spec.includes('|')
          ? { name: m[1]!, value: spec.split('|')[0]!.trim(), choices: spec.split('|').map((c) => c.trim()).filter((c, i, a) => c !== '' && a.indexOf(c) === i), optional: false }
          : { name: m[1]!, value: spec.trim(), choices: [], optional: spec.trim() === '' };
    const at = out.findIndex((x) => x.name === v.name);
    if (at === -1) out.push(v);
    else if (spec !== undefined && !out[at]!.value && !out[at]!.choices.length && !out[at]!.optional) out[at] = v;
  }
  return out;
}

/** The values a snippet's form starts with. */
export const snippetDefaults = (vars: SnippetVariable[]): Record<string, string> => Object.fromEntries(vars.map((v) => [v.name, v.value]));

/** Every variable has a value (or may stay empty). */
export const snippetReady = (vars: SnippetVariable[], values: Record<string, string>): boolean => vars.every((v) => v.optional || (values[v.name] ?? '') !== '');

/** Fill in {{variables}}; unknown ones are left as they are. */
export function fillSnippet(command: string, values: Record<string, string>): string {
  return command.replace(VARIABLE, (whole, name: string) => values[name] ?? whole);
}

// Suggested snippets: commands typed often in Burrow's terminals that are
// worth keeping. What is quicker to type than to pick is left out: one word
// ("htop"), a short one ("git pull"), and looking or moving around with
// one argument ("cd /srv", "ls -la /srv/media").

/** Typed at least this often before it is suggested. */
export const SUGGEST_MIN_COUNT = 3;
const QUICK = new Set(['cd', 'ls', 'll', 'la', 'l', 'pwd', 'clear', 'exit', 'history', 'cat', 'less', 'more', 'man', 'echo', 'which', 'whoami', 'vi', 'vim', 'nano', 'mkdir', 'touch', 'top', 'htop', 'tail', 'head']);

/** Whether a command typed often is worth suggesting as a snippet. */
export function worthSuggesting(command: string): boolean {
  const c = command.trim();
  const words = c.split(/\s+/);
  if (words.length < 2 || c.length < 12) return false;
  // A quick one with its flags and one argument ("ls -la /srv"); piped or
  // chained it is more than that.
  const args = words.slice(1).filter((w) => !w.startsWith('-'));
  return !(QUICK.has(words[0]!) && args.length <= 1 && !/[|;&]/.test(c));
}

/** A first name for a suggested snippet: its first words. */
export function suggestedName(command: string): string {
  const words = command.trim().split(/\s+/).slice(0, 4).join(' ');
  return words.length > 60 ? `${words.slice(0, 59)}...` : words;
}
