import type { AuthMethod, ConnectionDefaults, Group, Host, TmuxMode } from './schemas.js';

export interface EffectiveConnection {
  port: number;
  username: string | null;
  authMethod: AuthMethod | null;
  keyId: number | null;
  startupCommand: string | null;
  tmux: TmuxMode;
  term: string;
  encoding: string;
}

export const BUILTIN_DEFAULTS = {
  port: 22,
  tmux: 'auto' as TmuxMode,
  term: 'xterm-256color',
  encoding: 'utf-8',
};

type Field = keyof ConnectionDefaults;

/**
 * Walk from the group up to the root and return the chain, nearest first.
 * A cycle (which the server refuses to store) ends the walk instead of
 * looping forever.
 */
export function groupChain(groupId: number | null, groups: Map<number, Group>): Group[] {
  const chain: Group[] = [];
  const seen = new Set<number>();
  let id = groupId;
  while (id != null && !seen.has(id)) {
    seen.add(id);
    const g = groups.get(id);
    if (!g) break;
    chain.push(g);
    id = g.parentId;
  }
  return chain;
}

/**
 * The settings a connection actually uses: the host's own value, else the
 * nearest group that sets it, else what is set for all hosts, else the
 * built-in default.
 */
export function effectiveConnection(
  host: Pick<Host, Field | 'groupId'>,
  groups: Map<number, Group>,
  allHosts: ConnectionDefaults = {},
): EffectiveConnection {
  const layers: ConnectionDefaults[] = [host, ...groupChain(host.groupId, groups).map((g) => g.defaults), allHosts];
  const pick = <K extends Field>(k: K): ConnectionDefaults[K] => {
    for (const layer of layers) {
      const v = layer[k];
      if (v !== null && v !== undefined && v !== '') return v;
    }
    return undefined;
  };
  return {
    port: pick('port') ?? BUILTIN_DEFAULTS.port,
    username: pick('username') ?? null,
    authMethod: pick('authMethod') ?? null,
    keyId: pick('keyId') ?? null,
    startupCommand: pick('startupCommand') ?? null,
    tmux: pick('tmux') ?? BUILTIN_DEFAULTS.tmux,
    term: pick('term') ?? BUILTIN_DEFAULTS.term,
    encoding: pick('encoding') ?? BUILTIN_DEFAULTS.encoding,
  };
}

/**
 * Where a field comes from when the host (or group) leaves it empty: the
 * nearest group that sets it (its name), "all" for the settings of all
 * hosts, or null for Burrow's built-in default.
 */
export function inheritedFrom(groupId: number | null, groups: Map<number, Group>, allHosts: ConnectionDefaults, field: Field): string | 'all' | null {
  const set = (v: unknown) => v !== null && v !== undefined && v !== '';
  for (const g of groupChain(groupId, groups)) if (set(g.defaults[field])) return g.name;
  return set(allHosts[field]) ? 'all' : null;
}
