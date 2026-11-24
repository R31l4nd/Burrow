import type { Page } from '@playwright/test';

// The main pages at their addresses on this run, for the sizes (workspace-sizes.spec.ts) and the
// sweep over every width (workspace-sweep.spec.ts). A terminal session is opened for the terminal
// page; `done` closes it again.

async function api<T>(page: Page, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ([p, b]) => (await fetch(p, b === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json(),
    [path, body] as const,
  ) as Promise<T>;
}

export async function mainViews(page: Page): Promise<{ views: [string, string][]; done: () => Promise<void> }> {
  const hosts = await api<{ id: number; name: string }[]>(page, '/api/hosts');
  const real = hosts.find((h) => h.name === 'docker-real') ?? hosts[0]!;
  const sshd = hosts.find((h) => h.name === 'test-sshd') ?? hosts[0]!;
  const term = await api<{ id: string }>(page, '/api/terminal/sessions', { hostId: sshd.id, cols: 80, rows: 24 });
  const views: [string, string][] = [
    ['hosts', '/#/hosts'],
    ['host-stats', `/#/hosts/${real.id}/stats`],
    ['host-journal', `/#/hosts/${sshd.id}/journal`],
    ['host-edit', `/#/hosts/${real.id}/edit`],
    ['files', `/#/files/${real.id}?p=/etc`],
    ['terminal', `/#/term/${term.id}`],
    ['containers', '/#/containers'],
    ['alerts', '/#/alerts'],
    ['reports', '/#/reports'],
    ['apps', '/#/apps'],
    ['logs', '/#/logs'],
    ['snippets', '/#/snippets'],
    ['keys', '/#/keys'],
    ['settings', '/#/settings'],
    ['settings-security', '/#/settings/security'],
    ['settings-report', '/#/settings/report'],
  ];
  return { views, done: () => page.evaluate((id) => void fetch(`/api/terminal/sessions/${id}`, { method: 'DELETE' }), term.id) };
}
