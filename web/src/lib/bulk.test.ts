import { describe, expect, it } from 'vitest';
import { plan, runAll, type BulkRow } from './bulk.js';

const row = (o: Partial<BulkRow>): BulkRow => ({ hostId: 1, hostName: 'debian', name: 'web', running: true, self: false, project: 'media', service: 'web', image: 'nginx:1', hasUpdate: false, ...o });

describe('several containers at once', () => {
  it('starts only what is stopped, stops only what runs', () => {
    const rows = [row({ name: 'a', running: true }), row({ name: 'b', running: false })];
    expect(plan('start', rows).act.map((r) => r.name)).toEqual(['b']);
    expect(plan('start', rows).skip).toEqual([{ row: rows[0], reason: 'running' }]);
    expect(plan('stop', rows).act.map((r) => r.name)).toEqual(['a']);
    expect(plan('stop', rows).skip[0]!.reason).toBe('stopped');
  });

  it('never stops Burrow itself, but restarts it as asked', () => {
    const me = row({ name: 'burrow', self: true });
    expect(plan('stop', [me])).toMatchObject({ act: [], skip: [{ reason: 'self' }] });
    expect(plan('restart', [me]).act).toHaveLength(1);
  });

  it('updates per stack, each service once, and leaves what has no update', () => {
    const p = plan('update', [
      row({ name: 'media-web-1', service: 'web', hasUpdate: true }),
      row({ name: 'media-web-2', service: 'web', hasUpdate: true }),
      row({ name: 'media-db-1', service: 'db', image: 'postgres:16', hasUpdate: true }),
      row({ name: 'other', project: 'home', service: 'ha', hasUpdate: false }),
      row({ name: 'loose', project: null, service: null, hasUpdate: true }),
    ]);
    expect(p.stacks).toEqual([{ hostId: 1, hostName: 'debian', project: 'media', services: ['web', 'db'], images: ['nginx:1', 'postgres:16'] }]);
    expect(p.skip.map((s) => s.reason)).toEqual(['noUpdate', 'noStack']);
  });

  it('runs the first alone, then a few at a time per host, and goes on past a failure', async () => {
    const log: string[] = [];
    const busy = new Map<number, number>();
    const most = new Map<number, number>();
    const items = [1, 1, 1, 1, 2, 2].map((hostId, i) => ({ hostId, i }));
    await runAll(items, async (x) => {
      busy.set(x.hostId, (busy.get(x.hostId) ?? 0) + 1);
      most.set(x.hostId, Math.max(most.get(x.hostId) ?? 0, busy.get(x.hostId)!));
      log.push(`start ${x.i}`);
      await new Promise((r) => setTimeout(r, 5));
      busy.set(x.hostId, busy.get(x.hostId)! - 1);
      if (x.i === 2) throw new Error('boom');
      log.push(`done ${x.i}`);
    });
    expect(log[0]).toBe('start 0');
    expect(log[1]).toBe('done 0');
    // Every one tried, the failing one too; two at once on each host, never more (AUDIT2 TEST-23: only the total was checked).
    expect(log.filter((l) => l.startsWith('start')).length).toBe(6);
    expect(log).not.toContain('done 2');
    expect([...most.entries()].sort()).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});
