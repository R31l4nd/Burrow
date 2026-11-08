import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Alert, Analysis, AuthState, Invite } from '@burrow/shared';
import { alerts, analyses, logFiles, users } from '../../src/db/schema.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// What an operator reads of others' work, and what their reading changes for others (A3-SRV-11).
let t: TestApp;
let admin: string | null;
let operator: string | null;
let hostId = 0;

beforeAll(async () => {
  t = await makeApp();
  await setupAdmin(t);
  admin = t.cookie;
  hostId = (await t.json<{ id: number }>('POST', '/api/hosts', { name: 'h', address: 'h.lan' })).id;
  const inv = await t.json<Invite>('POST', '/api/invites', { role: 'operator' });
  t.cookie = null;
  const state = await t.json<AuthState>('POST', `/api/invites/${inv.url!.split('/').pop()!}/accept`, { username: 'olivia' });
  t.ctx.db.update(users).set({ incomplete: false }).where(eq(users.id, state.user!.id)).run();
  operator = t.cookie;
});
afterAll(async () => {
  await t.close();
});

describe('an operator and the admins', () => {
  it("sees an admin's analyses only of what an operator may read itself (A3-SRV-11)", async () => {
    const now = t.clock.now;
    const add = (targets: object[]) =>
      t.ctx.db.insert(analyses).values({ userId: 1, targets: JSON.stringify(targets), lines: 3, provider: 'ollama:x', status: 'done', text: 'answer', createdAt: now }).returning().get().id;
    t.ctx.db.insert(logFiles).values({ hostId, container: 'web', path: '/var/log/app.log', createdAt: now }).run();
    const container = add([{ hostId, container: 'web' }]);
    const source = add([{ hostId, container: 'web', file: '/var/log/app.log' }]);
    const secret = add([{ hostId, container: '', file: '/root/.bash_history' }]);
    t.cookie = operator;
    expect((await t.json<Analysis[]>('GET', '/api/ai/analyses')).map((a) => a.id).sort()).toEqual([container, source].sort());
    expect((await t.request('GET', `/api/ai/analyses/${secret}`)).statusCode).toBe(404);
    expect((await t.request('GET', `/api/ai/analyses/${source}`)).statusCode).toBe(200);
    t.cookie = admin;
    expect((await t.json<Analysis[]>('GET', '/api/ai/analyses')).map((a) => a.id)).toContain(secret);
  });

  it("never reads an admin's question about a file, not even about a log file it may read (report 76bcda)", async () => {
    const asked = t.ctx.db.insert(analyses).values({ userId: 1, kind: 'file', targets: JSON.stringify([{ hostId, container: '', file: '/var/log/app.log' }]), lines: 3, provider: 'ollama:x', status: 'done', text: 'answer', prompt: 'the file', createdAt: t.clock.now }).returning().get().id;
    t.ctx.db.insert(logFiles).values({ hostId, container: '', path: '/var/log/app.log', createdAt: t.clock.now }).run();
    t.cookie = operator;
    expect((await t.request('GET', `/api/ai/analyses/${asked}`)).statusCode).toBe(404);
    expect((await t.json<Analysis[]>('GET', `/api/ai/analyses?kind=file&hostId=${hostId}&file=${encodeURIComponent('/var/log/app.log')}`)).map((a) => a.id)).not.toContain(asked);
    expect((await t.request('POST', `/api/ai/analyses/${asked}/ask`, { question: 'and?', lang: 'en' })).statusCode).toBe(404);
    t.cookie = admin;
    expect((await t.request('GET', `/api/ai/analyses/${asked}`)).statusCode).toBe(200);
  });

  it("an operator's look at the alerts marks them read for that operator only (A3-SRV-11)", async () => {
    const now = t.clock.now + 1000;
    t.ctx.db.insert(alerts).values({ ruleName: 'r', hostId, container: 'web', title: 'boom', at: new Date(now).toISOString(), count: 1, read: false, pushed: 'no', createdAt: now, updatedAt: now }).run();
    t.advance(5000);
    t.cookie = admin;
    expect((await t.json<{ n: number }>('GET', '/api/alerts/unread')).n).toBe(1);
    t.cookie = operator;
    expect((await t.json<{ n: number }>('GET', '/api/alerts/unread')).n).toBe(1);
    await t.json('POST', '/api/alerts/read');
    expect((await t.json<{ n: number }>('GET', '/api/alerts/unread')).n).toBe(0);
    expect((await t.json<Alert[]>('GET', '/api/alerts'))[0]!.read).toBe(true);
    t.cookie = admin;
    expect((await t.json<{ n: number }>('GET', '/api/alerts/unread')).n).toBe(1);
    expect((await t.json<Alert[]>('GET', '/api/alerts'))[0]!.read).toBe(false);
    await t.json('POST', '/api/alerts/read');
    expect((await t.json<{ n: number }>('GET', '/api/alerts/unread')).n).toBe(0);
  });
});
