import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthState, Invite, PushDevice } from '@burrow/shared';
import { users } from '../../src/db/schema.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// A push address belongs to the person who turned it on.
let t: TestApp;
let adminCookie: string | null;
let opCookie: string | null;

beforeAll(async () => {
  t = await makeApp();
  await setupAdmin(t);
  adminCookie = t.cookie;
  const inv = await t.json<Invite>('POST', '/api/invites', { role: 'operator' });
  t.cookie = null;
  const state = await t.json<AuthState>('POST', `/api/invites/${inv.url!.split('/').pop()!}/accept`, { username: 'olivia' });
  t.ctx.db.update(users).set({ incomplete: false }).where(eq(users.id, state.user!.id)).run();
  opCookie = t.cookie;
});
afterAll(async () => {
  await t.close();
});

describe('push devices', () => {
  it("another person's device is not moved to oneself by its address (A3-SRV-10)", async () => {
    const body = { kind: 'webpush', label: 'Firefox', endpoint: 'https://push.example.net/wpush/v2/abc', p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg', lang: 'en' };
    t.cookie = adminCookie;
    const mine = await t.json<PushDevice>('POST', '/api/push/devices', body);
    // The same device again (new keys): still one, still the admin's.
    expect(await t.json<PushDevice>('POST', '/api/push/devices', { ...body, label: 'Firefox 2' })).toMatchObject({ id: mine.id, label: 'Firefox 2' });
    t.cookie = opCookie;
    const r = await t.request('POST', '/api/push/devices', { ...body, label: 'taken' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('device_taken');
    expect(await t.json<PushDevice[]>('GET', '/api/push/devices')).toEqual([]);
    t.cookie = adminCookie;
    expect((await t.json<PushDevice[]>('GET', '/api/push/devices')).map((d) => [d.id, d.label])).toEqual([[mine.id, 'Firefox 2']]);
  });
});
