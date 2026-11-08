import { inBackground } from './ui.svelte.js';
import type { ConnectionDefaults, Group, Host, HostStatus, PackageSummary, SshKey } from '@burrow/shared';
import { android } from './android.js';
import { errorMessage, get } from './api.js';
import { session } from './session.svelte.js';

// Hosts, groups, keys and reachability, loaded once and refreshed after
// every change. Small enough to keep entirely in memory.

export const data = $state<{
  hosts: Host[];
  groups: Group[];
  keys: SshKey[];
  /** "All hosts": what every host gets when neither it nor a group sets a field. */
  hostDefaults: ConnectionDefaults;
  status: Record<number, HostStatus>;
  /** Each host's last package check (marked on the host list). */
  packages: Record<number, PackageSummary>;
  loaded: boolean;
}>({ hosts: [], groups: [], keys: [], hostDefaults: {}, status: {}, packages: {}, loaded: false });

// The newest read wins: two overlapping (a page and a refresh) put back no older list (AUDIT2 WEB-11).
let allAsked = 0;
let statusAsked = 0;

export async function loadAll(): Promise<void> {
  const mine = ++allAsked;
  const [hosts, groups, keys, hostDefaults] = await Promise.all([
    get<Host[]>('/api/hosts'),
    get<Group[]>('/api/groups'),
    // Keys are the admin's; an operator's list is empty.
    session.state?.user?.role === 'admin' ? get<SshKey[]>('/api/keys') : Promise.resolve([] as SshKey[]),
    get<ConnectionDefaults>('/api/host-defaults'),
  ]);
  if (mine !== allAsked) return;
  data.hosts = hosts;
  data.hostDefaults = hostDefaults;
  data.groups = groups;
  data.keys = keys;
  data.loaded = true;
  inBackground(loadStatus());
  // Home screen shortcuts of the Android app: favourites, then recent hosts.
  if (android) {
    const pick = [...hosts.filter((h) => h.favorite), ...hosts.filter((h) => !h.favorite && h.lastUsedAt).sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))];
    void android.shortcuts(pick.slice(0, 4).map((h) => ({ id: h.id, name: h.name }))).catch(() => {});
  }
}

/** Why the hosts could not be read, for a page to say with Try again (A3-WEB-01: Containers looked empty). */
export const dataLoad = $state({ error: '' });
/** The hosts, groups and keys read when they are not yet; a failure is kept in dataLoad, not only a toast. */
export function ensureLoaded(): void {
  if (data.loaded) return;
  dataLoad.error = '';
  loadAll().catch((err: unknown) => (dataLoad.error = errorMessage(err)));
}

export async function loadStatus(): Promise<void> {
  const mine = ++statusAsked;
  // The package checks with it; their failure leaves the marks as they were, the dots still come.
  const [list, packages] = await Promise.all([get<HostStatus[]>('/api/hosts/status'), get<PackageSummary[]>('/api/hosts/packages').catch(() => null)]);
  if (mine !== statusAsked) return;
  data.status = Object.fromEntries(list.map((s) => [s.hostId, s]));
  if (packages) data.packages = Object.fromEntries(packages.map((p) => [p.hostId, p]));
}

export async function loadKeys(): Promise<void> {
  data.keys = await get<SshKey[]>('/api/keys');
}

/** "Home / Servers" for a group id. */
export function groupPath(id: number | null): string {
  const names: string[] = [];
  const seen = new Set<number>();
  for (let g = data.groups.find((x) => x.id === id); g && !seen.has(g.id); g = data.groups.find((x) => x.id === g!.parentId)) {
    seen.add(g.id);
    names.unshift(g.name);
  }
  return names.join(' / ');
}
