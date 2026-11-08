import { and, desc, eq, gt, gte } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/index.js';
import { alerts, containerSamples, hostDiskSamples, hostSamples } from '../../src/db/schema.js';

// Queries that run often (every log line that matches a rule, every poll)
// look their rows up by an index, not by reading the whole table (#149: the
// bundling of alerts read 90 days of them for every matching line).

describe('query plans of hot queries', () => {
  const db = openDb(':memory:');
  const plan = (q: { toSQL(): { sql: string; params: unknown[] } }) => {
    const { sql, params } = q.toSQL();
    return (db.$client.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join('; ');
  };

  it.each([
    ['an alert of the last ten minutes to add to (alerts/engine.ts fire)', () => db.select().from(alerts).where(and(eq(alerts.ruleId, 1), eq(alerts.hostId, 1), eq(alerts.container, 'web'), gt(alerts.updatedAt, 0))).orderBy(desc(alerts.id))],
    ["a host's statistics over time", () => db.select().from(hostSamples).where(and(eq(hostSamples.hostId, 1), gte(hostSamples.at, 0)))],
    ["a host's disks over time", () => db.select().from(hostDiskSamples).where(and(eq(hostDiskSamples.hostId, 1), gte(hostDiskSamples.at, 0)))],
    ["a container's history", () => db.select().from(containerSamples).where(and(eq(containerSamples.hostId, 1), eq(containerSamples.name, 'web'), gte(containerSamples.at, 0)))],
  ])('%s', (_name, query) => {
    const p = plan(query());
    expect(p).toMatch(/USING (COVERING )?INDEX/);
    expect(p).not.toMatch(/^SCAN \w+$|SCAN \w+(;|$)/);
  });
});
