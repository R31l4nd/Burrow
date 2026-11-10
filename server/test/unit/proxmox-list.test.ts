import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Host } from '@burrow/shared';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

describe("a Proxmox node's guest list cut off (audit 2026-11-09)", () => {
  it('reads as failed, not as a node without containers: the connection went between the two lists', async () => {
    const h = await t.json<Host>('POST', '/api/hosts', { name: 'pve', address: 'pve.lan', username: 'root' });
    const cut = '@@burrow-pve qm\n      VMID NAME STATUS MEM(MB) BOOTDISK(GB) PID\n       100 web running 2048 32.00 1234\n@@burrow-exit 0\n';
    vi.spyOn(t.files, 'with').mockResolvedValue({ code: null, stdout: cut, stderr: '', truncated: false } as never);
    const r = await t.json<{ guests: unknown[]; error: string | null }>('GET', `/api/hosts/${h.id}/guests`);
    expect(r.error).not.toBeNull();
    // A list cut inside one part as well.
    vi.spyOn(t.files, 'with').mockResolvedValue({ code: null, stdout: '@@burrow-pve qm\n      VMID NAME STATUS\n       100 web running\n', stderr: '', truncated: false } as never);
    expect((await t.json<{ error: string | null }>('GET', `/api/hosts/${h.id}/guests`)).error).not.toBeNull();
  });
});
