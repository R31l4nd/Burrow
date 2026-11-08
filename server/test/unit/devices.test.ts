import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthState } from '@burrow/shared';
import { makeApp, ORIGIN, setupAdmin, type TestApp } from '../helpers.js';

// The Android app's key, as the Keystore would make it: EC P-256, public
// half as X.509 SPKI.
function deviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    sign: (message: string) => sign('sha256', Buffer.from(message, 'utf8'), { key: privateKey, dsaEncoding: 'der' }).toString('base64'),
  };
}

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await setupAdmin(t);
});
afterEach(async () => {
  await t.close();
});

async function pair(key = deviceKey()) {
  const { code } = await t.json<{ code: string }>('POST', '/api/account/devices/pair-code');
  const browser = t.cookie;
  t.cookie = null;
  const r = await t.json<{ deviceId: number; state: AuthState }>('POST', '/api/auth/pair', { code: code.toLowerCase(), name: 'Pixel', publicKey: key.publicKey });
  return { key, deviceId: r.deviceId, state: r.state, browser };
}

describe('pairing', () => {
  it('signs the app in with a one-time code and remembers the device', async () => {
    const { deviceId, state } = await pair();
    expect(state).toMatchObject({ user: { username: 'admin' }, deviceId });
    const list = await t.json<{ id: number; current: boolean }[]>('GET', '/api/account/devices');
    expect(list).toEqual([expect.objectContaining({ id: deviceId, name: 'Pixel', current: true })]);
  });

  it('a code works once, and only for five minutes', async () => {
    const { code } = await t.json<{ code: string }>('POST', '/api/account/devices/pair-code');
    t.cookie = null;
    const key = deviceKey();
    expect((await t.request('POST', '/api/auth/pair', { code, name: 'a', publicKey: key.publicKey })).statusCode).toBe(200);
    t.cookie = null;
    expect((await t.request('POST', '/api/auth/pair', { code, name: 'b', publicKey: key.publicKey })).statusCode).toBe(401);
  });

  it('a code of an account deleted since does not sign in a new account that got its number (AUDIT2 AUTH-02)', async () => {
    const { users } = await import('../../src/db/schema.js');
    const { eq } = await import('drizzle-orm');
    const { code } = await t.json<{ code: string }>('POST', '/api/account/devices/pair-code');
    const old = t.ctx.db.select().from(users).where(eq(users.id, 1)).get()!;
    // The account goes; another one is made and gets the same number (SQLite reuses the highest).
    t.ctx.db.delete(users).where(eq(users.id, 1)).run();
    t.advance(1000);
    t.ctx.db.insert(users).values({ ...old, username: 'someone-else', createdAt: t.ctx.now() }).run();
    t.cookie = null;
    const r = await t.request('POST', '/api/auth/pair', { code, name: 'a', publicKey: deviceKey().publicKey });
    expect(r.statusCode).toBe(401);
  });

  it('expires codes', async () => {
    const { code } = await t.json<{ code: string }>('POST', '/api/account/devices/pair-code');
    t.advance(6 * 60_000);
    t.cookie = null;
    expect((await t.request('POST', '/api/auth/pair', { code, name: 'a', publicKey: deviceKey().publicKey })).json()).toMatchObject({ error: 'invalid_code' });
  });

  it('refuses keys that are not EC P-256', async () => {
    const { code } = await t.json<{ code: string }>('POST', '/api/account/devices/pair-code');
    t.cookie = null;
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    expect((await t.request('POST', '/api/auth/pair', { code, name: 'a', publicKey: rsa })).json()).toMatchObject({ error: 'invalid_key' });
  });

  it('needs a fresh step-up to hand out a code', async () => {
    t.advance(16 * 60_000);
    expect((await t.request('POST', '/api/account/devices/pair-code')).json()).toMatchObject({ error: 'step_up_required' });
  });
});

describe('fingerprint sign-in and step-up', () => {
  it('asking for challenges without end keeps only the newest (audit 2026-11-05)', async () => {
    // 10 000 for real; lowered here, so the test is quick.
    const { challengeLimit } = await import('../../src/auth/passkeys.js');
    challengeLimit.max = 20;
    try {
      const { key, deviceId } = await pair();
      t.cookie = null;
      const first = await t.json<{ challengeId: string; message: string }>('POST', '/api/auth/device/challenge', { deviceId, purpose: 'login' });
      // Each from another address it names: through a proxy Burrow was not told about, any passes (A3-SRV-02).
      const ask = (i: number) => t.app.inject({ method: 'POST', url: '/api/auth/device/challenge', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': `10.9.0.${i}` }, payload: JSON.stringify({ deviceId, purpose: 'login' }) });
      let last = first;
      for (let i = 0; i < 20; i++) last = (await ask(i)).json<{ challengeId: string; message: string }>();
      expect((await t.request('POST', '/api/auth/device/verify', { challengeId: first.challengeId, signature: key.sign(first.message) })).statusCode).toBe(401);
      t.cookie = null;
      expect((await t.request('POST', '/api/auth/device/verify', { challengeId: last.challengeId, signature: key.sign(last.message) })).statusCode).toBe(200);
    } finally {
      challengeLimit.max = 10_000;
    }
  });

  it('signs in again with a signature, once per challenge', async () => {
    const { key, deviceId } = await pair();
    t.cookie = null;
    const ch = await t.json<{ challengeId: string; message: string }>('POST', '/api/auth/device/challenge', { deviceId, purpose: 'login' });
    expect(ch.message.split('\n').slice(0, 3)).toEqual(['burrow-device-v1', 'login', 'http://localhost:8080']);
    const state = await t.json<AuthState>('POST', '/api/auth/device/verify', { challengeId: ch.challengeId, signature: key.sign(ch.message) });
    expect(state.deviceId).toBe(deviceId);
    // Replay: the challenge is gone.
    t.cookie = null;
    expect((await t.request('POST', '/api/auth/device/verify', { challengeId: ch.challengeId, signature: key.sign(ch.message) })).statusCode).toBe(401);
  });

  it('refuses another key, and a login signature used for step-up', async () => {
    const { deviceId } = await pair();
    const ch = await t.json<{ challengeId: string; message: string }>('POST', '/api/auth/device/challenge', { deviceId, purpose: 'step-up' });
    expect((await t.request('POST', '/api/auth/device/verify', { challengeId: ch.challengeId, signature: deviceKey().sign(ch.message) })).statusCode).toBe(401);
  });

  it("the device's own signature of a login challenge does not confirm a step-up (AUDIT ST-21)", async () => {
    const { key, deviceId } = await pair();
    t.advance(16 * 60_000);
    const login = await t.json<{ challengeId: string; message: string }>('POST', '/api/auth/device/challenge', { deviceId, purpose: 'login' });
    const step = await t.json<{ challengeId: string; message: string }>('POST', '/api/auth/device/challenge', { deviceId, purpose: 'step-up' });
    // The right key, the other purpose's message: refused, and no confirmation.
    expect((await t.request('POST', '/api/auth/device/verify', { challengeId: step.challengeId, signature: key.sign(login.message) })).statusCode).toBe(401);
    expect((await t.request('POST', '/api/hosts', { name: 'x', address: 'x' })).json()).toMatchObject({ error: 'step_up_required' });
    // And the step-up challenge is used up by the try: its own signature now comes too late.
    expect((await t.request('POST', '/api/auth/device/verify', { challengeId: step.challengeId, signature: key.sign(step.message) })).statusCode).toBe(401);
  });

  it('confirms (step-up) the app session with the device key', async () => {
    const { key, deviceId } = await pair();
    t.advance(16 * 60_000);
    expect((await t.request('POST', '/api/hosts', { name: 'x', address: 'x' })).json()).toMatchObject({ error: 'step_up_required' });
    const ch = await t.json<{ challengeId: string; message: string }>('POST', '/api/auth/device/challenge', { deviceId, purpose: 'step-up' });
    const state = await t.json<AuthState>('POST', '/api/auth/device/verify', { challengeId: ch.challengeId, signature: key.sign(ch.message) });
    expect(state.stepUpUntil).not.toBeNull();
    expect((await t.request('POST', '/api/hosts', { name: 'x', address: 'x' })).statusCode).toBe(200);
  });

  it('only the session of that device can use its step-up', async () => {
    const { deviceId, browser } = await pair();
    t.cookie = browser;
    expect((await t.request('POST', '/api/auth/device/challenge', { deviceId, purpose: 'step-up' })).json()).toMatchObject({ error: 'wrong_device' });
  });

  it('a paired phone can be renamed by its owner only, with a fresh step-up; two of the same model told apart (UIA-15)', async () => {
    const first = await pair();
    t.cookie = first.browser;
    const second = await pair();
    t.cookie = second.browser;
    const before = await t.json<{ id: number; name: string; createdAt: string }[]>('GET', '/api/account/devices');
    expect(before.map((d) => d.name)).toEqual(['Pixel', 'Pixel']);
    expect(await t.json('PATCH', `/api/account/devices/${first.deviceId}`, { name: '  Old Pixel  ' })).toMatchObject({ id: first.deviceId, name: 'Old Pixel' });
    const after = await t.json<{ id: number; name: string }[]>('GET', '/api/account/devices');
    expect(after.find((d) => d.id === first.deviceId)?.name).toBe('Old Pixel');
    expect(after.find((d) => d.id === second.deviceId)?.name).toBe('Pixel');
    // Empty or too long: refused; another account's phone or none: not found.
    expect((await t.request('PATCH', `/api/account/devices/${first.deviceId}`, { name: ' ' })).statusCode).toBe(400);
    expect((await t.request('PATCH', `/api/account/devices/${first.deviceId}`, { name: 'x'.repeat(61) })).statusCode).toBe(400);
    expect((await t.request('PATCH', '/api/account/devices/999999', { name: 'x' })).statusCode).toBe(404);
    t.advance(16 * 60_000);
    expect((await t.request('PATCH', `/api/account/devices/${first.deviceId}`, { name: 'Late' })).json()).toMatchObject({ error: 'step_up_required' });
  });

  it('unpairing ends the device sessions immediately', async () => {
    const { deviceId, browser } = await pair();
    const appCookie = t.cookie;
    t.cookie = browser;
    await t.json('DELETE', `/api/account/devices/${deviceId}`);
    expect((await t.request('GET', '/api/hosts', undefined, { cookie: appCookie })).statusCode).toBe(401);
  });
});
