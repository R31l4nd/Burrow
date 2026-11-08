// Each section of the navigation keeps its place (report d6ea6c: a folder
// open, a look at the terminal, and Files began again at its start). Its
// button goes back to the last page seen in it; pressed while there, to the
// section's start. As a phone's tab bar keeps each tab's place.

export type NavId = 'hosts' | 'term' | 'files' | 'containers' | 'settings';

/** The section a page (a hash path, '/files/2?p=/data') belongs to, or null. */
export function navOf(path: string): NavId | null {
  const [p, qs = ''] = path.split('?', 2) as [string, string?];
  const first = p.split('/').filter(Boolean)[0] ?? 'hosts';
  // A host's system logs (targets "2::unit") are the host's; a container's the containers'.
  const hostLogs = first === 'logs' && (new URLSearchParams(qs).get('t') ?? '').split(',').every((x) => /^\d+::/.test(x.trim()));
  if (first === 'hosts' || first === 'groups' || first === 'import' || (first === 'logs' && hostLogs)) return 'hosts';
  if (first === 'term' || first === 'sessions') return 'term';
  if (first === 'files' || first === 'edit') return 'files';
  if (['containers', 'apps', 'stacks', 'alerts', 'reports', 'logs'].includes(first)) return 'containers';
  if (['settings', 'keys', 'snippets', 'audit'].includes(first)) return 'settings';
  return null;
}

/** Where a section's button leads from the page `here`, given the last page seen in each section. */
export function navTarget(id: NavId, here: string, last: Partial<Record<NavId, string>>): string {
  if (navOf(here) === id) return `/${id}`;
  return last[id] ?? `/${id}`;
}

const KEY = 'burrow.nav.last';

/** The last page seen in each section, this tab (sessionStorage); a page from another account is not kept (signing out clears it). */
export function lastPages(): Partial<Record<NavId, string>> {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Partial<Record<NavId, string>>;
  } catch {
    return {};
  }
}

export function notePage(path: string): void {
  // The start page is no place to go back to (it is Hosts' start anyway).
  if (path === '/' || path === '') return;
  const id = navOf(path);
  if (!id) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...lastPages(), [id]: path }));
  } catch {
    // Storage off: the buttons go to each section's start, as before.
  }
}

export function forgetPages(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing kept.
  }
}
