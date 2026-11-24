// Every page of Burrow by name: a hash with its numbers and names replaced.
// The tour (e2e/tests/pages.ts) fails when one of these was never looked at,
// web/src/pages.test.ts checks that App.svelte has no page missing here, and
// Settings -> Usage counts how often each is opened by the same names, so no
// host, container or file name is ever kept.

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
export const SETTINGS_PARTS = ['appearance', 'terminal', 'shortcuts', 'notify', 'ai', 'channels', 'updates', 'users', 'sso', 'hosts', 'keys', 'snippets', 'scheduled', 'recordings', 'android', 'security', 'backups', 'system', 'usage', 'about', 'report'] as const;

/** "#/hosts/12/edit?x=1" -> "hosts/12/edit". */
export const pathOf = (hash: string): string => hash.replace(/^#\/?/, '').split('?')[0]!;

/** "#/hosts/12/edit" -> "hosts/:id/edit"; "#/containers/3/web" -> "containers/:id/:name". */
export function pageOf(hash: string, signedIn: boolean): string {
  const path = pathOf(hash);
  if (!path) return signedIn ? 'hosts' : 'login';
  const [first, ...rest] = path.split('/');
  const words = new Set(['new', 'edit', 'stats', 'docker', 'journal', 'audit', 'all', 'phone']);
  return [first, ...rest.map((x) => (/^\d+$/.test(x) ? ':id' : words.has(x) ? x : ':name'))].join('/');
}


// Every dialog by its tour name (each <Dialog tour="...">): Settings -> Usage counts them by these
// names, and lists the ones never opened. web/src/pages.test.ts checks the list against the app.
export const DIALOGS = ['alert-menu', 'alert-mute', 'alert-rule', 'analysis-view', 'analyze', 'app-form', 'apps-bulk', 'apps-discover', 'bug-report', 'bulk', 'bulk-menu', 'changelog', 'changelogs', 'channel-form', 'channel-kind', 'channel-menu', 'command-palette', 'compare-saved', 'confirm', 'container-inspect', 'container-menu', 'containers-sort', 'container-update', 'device-menu', 'direct-forward', 'direct-host-key', 'direct-hosts', 'direct-menu', 'direct-snippets', 'disk-activity', 'editor-conflict', 'editor-problems', 'editor-tools', 'file-access', 'file-ask', 'file-sheet', 'files-new', 'files-search', 'fix-run', 'git-branches', 'git-diff', 'git-identity', 'history', 'host-sheet', 'key-form', 'key-menu', 'logfiles', 'markdown-preview', 'nginx-test', 'op-log', 'panel-logs', 'panel-new', 'password', 'paste-clash', 'phone-archive-entry', 'phone-file-menu', 'phone-name', 'phone-pick-folder', 'phone-properties', 'problem-report', 'processes', 'pve-menu', 'quick-open', 'report-schedule', 'resources-prune', 'sched-form', 'sched-menu', 'sched-runs', 'schedule-menu', 'shortcuts', 'snippet-form', 'snippet-menu', 'snippet-run', 'stack-review', 'step-up', 'sudo-password', 'terminal-ai', 'terminal-new', 'terminal-sessions', 'terminal-share', 'terminal-snippets', 'term-layout', 'totp', 'updates-menu', 'user-menu', 'ws-compare', 'ws-problems'] as const;
