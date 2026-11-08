// Every page of Burrow, as the tour sees it (a hash with its numbers and
// names replaced): the tour fails when one of these was never looked at.
// web/src/pages.test.ts checks that App.svelte has no page missing here.
export const PAGES = [
  'login',
  'setup',
  'invite/:name',
  'hosts',
  'hosts/new',
  'hosts/:id/edit',
  'hosts/:id/stats',
  'hosts/:id/journal',
  'hosts/:id/docker',
  'groups/new',
  'groups/:id/edit',
  'import',
  'files',
  'files/:id',
  // The phone's own files, in the Android app (workspace-android.spec.ts, with a stand-in for the app).
  'files/phone',
  'term',
  'term/:name',
  'edit/:id',
  'edit/phone',
  'ws/:id',
  'containers',
  'containers/:id/:name',
  'stacks/:id/:name',
  'logs',
  'alerts',
  'reports',
  'reports/:id',
  'apps',
  'apps/:id',
  'share',
  'watch/:name',
  'recordings/:id',
  // Parts of Settings now: 'keys', 'snippets' and 'recordings' (the list) lead to #/settings/<part>
  // (report e34ebd; workspace-extras.spec.ts checks the old addresses), 'groups/all' to #/settings/hosts (report 5c1209).
  'settings',
  'settings/audit',
  'settings/:name',
];

// The parts of Settings, each a page of its own (#/settings/<part>).
export const SETTINGS_PARTS = ['appearance', 'terminal', 'shortcuts', 'notify', 'ai', 'channels', 'updates', 'users', 'sso', 'hosts', 'keys', 'snippets', 'scheduled', 'recordings', 'android', 'security', 'backups', 'system', 'about', 'report'] as const;

// Dialogs that live outside the web app's pages and no e2e test can open.
// The direct route's (the Android app's) were here: workspace-direct.spec.ts
// and mobile-direct.spec.ts look at them now, with a stand-in for the app (UIA-17).
export const DIALOGS_ELSEWHERE: Record<string, string> = {};

/** "#/hosts/12/edit" -> "hosts/:id/edit"; "#/containers/3/web" -> "containers/:id/:name". */
export function pageOf(hash: string, signedIn: boolean): string {
  const path = hash.replace(/^#\/?/, '').split('?')[0]!;
  if (!path) return signedIn ? 'hosts' : 'login';
  const [first, ...rest] = path.split('/');
  const words = new Set(['new', 'edit', 'stats', 'docker', 'journal', 'audit', 'all', 'phone']);
  return [first, ...rest.map((x) => (/^\d+$/.test(x) ? ':id' : words.has(x) ? x : ':name'))].join('/');
}

/** What a page's numbers and names stand for: real records of the run, by name. */
export interface PageIds {
  /** The test host (sshd), and the one with real Docker (its containers and stacks). */
  sshd: number;
  docker: number;
  group?: number | string;
  session?: number | string;
  workspace?: number | string;
  report?: number | string;
  app?: number | string;
  /** A terminal recording (F3), and a session to show the watching page for. */
  recording?: number | string;
  container: string;
  stack: string;
  /** A file the editor opens on the test host. */
  file: string;
  /** The logs page's targets (?t=...), if any. */
  logs?: string;
}

/**
 * Every signed-in page with its numbers and names filled in, each with the
 * page it must show (pageOf): a page with an id missing is left out by name,
 * one that cannot be filled in fails (AUDIT2 TEST-01: hosts//docker, and
 * settings/:name as "settings/burrowtest", were visited instead).
 */
export function concretePages(ids: PageIds): { page: string; url: string; missing?: string }[] {
  const out: { page: string; url: string; missing?: string }[] = [];
  const hostIdOf = (p: string) => (p === 'hosts/:id/docker' || p.startsWith('containers/') || p.startsWith('stacks/') ? ids.docker : ids.sshd);
  const byPage: Record<string, () => string | number | undefined> = {
    'groups/:id/edit': () => ids.group,
    'term/:name': () => ids.session,
    'ws/:id': () => ids.workspace,
    'reports/:id': () => ids.report,
    'apps/:id': () => ids.app,
    'watch/:name': () => ids.session,
    'recordings/:id': () => ids.recording,
  };
  for (const p of PAGES) {
    // Shown only in the Android app (its bridge): the share target, the phone's own files.
    if (['login', 'setup', 'invite/:name', 'share', 'files/phone', 'edit/phone'].includes(p)) continue;
    if (p === 'settings/:name') {
      for (const x of SETTINGS_PARTS) out.push({ page: p, url: `/#/settings/${x}` });
      continue;
    }
    const own = byPage[p];
    if (own && own() === undefined) {
      out.push({ page: p, url: '', missing: `no record for ${p}` });
      continue;
    }
    let url = p;
    if (own) url = url.replace(/:id|:name/, String(own()));
    url = url.replace(':id', String(hostIdOf(p))).replace(':name', p.startsWith('containers/') ? ids.container : ids.stack);
    if (/:\w+/.test(url)) throw new Error(`cannot fill in ${p}: ${url}`);
    const query = p === 'files/:id' ? '?p=%2Fhome%2Ftester' : p === 'edit/:id' ? `?p=${encodeURIComponent(ids.file)}` : p === 'logs' && ids.logs ? `?t=${ids.logs}` : '';
    out.push({ page: p, url: `/#/${url}${query}` });
  }
  return out;
}
