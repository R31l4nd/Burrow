import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState, Invite, PasskeyInfo } from '@burrow/shared';
import * as throttle from '../../src/auth/throttle.js';
import { passkeys, users } from '../../src/db/schema.js';
import { makeApp, ORIGIN, setupAdmin, totpNow, type TestApp } from '../helpers.js';
import { SoftPasskey } from '../webauthn.js';

// Passkeys end to end through the API, with a software authenticator
// (test/webauthn.ts): registering one, signing in with it, confirming with it
// (step-up) and removing it, and every way a ceremony is refused.

let t: TestApp;
let totp: string;
beforeEach(async () => {
  vi.spyOn(throttle.timing, 'sleep').mockResolvedValue();
  t = await makeApp();
  totp = (await setupAdmin(t)).secret;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.close();
});

type RegOptions = { challengeId: string; options: { challenge: string; user: { id: string }; rp: { id: string }; excludeCredentials?: { id: string }[]; authenticatorSelection: unknown } };
type AuthOptions = { challengeId: string; options: { challenge: string; rpId: string; allowCredentials?: { id: string }[]; userVerification: string } };

const newKey = () => new SoftPasskey('localhost', ORIGIN);

async function register(key: SoftPasskey, name = 'phone'): Promise<PasskeyInfo> {
  const { challengeId, options } = await t.json<RegOptions>('POST', '/api/account/passkeys/options');
  return t.json<PasskeyInfo>('POST', '/api/account/passkeys/verify', { challengeId, response: key.create(options), name });
}

async function signInWith(key: SoftPasskey, o: Parameters<SoftPasskey['get']>[1] = {}) {
  const { challengeId, options } = await t.json<AuthOptions>('POST', '/api/auth/passkey/options');
  return t.request('POST', '/api/auth/passkey/verify', { challengeId, response: key.get(options, o) });
}

const audits = async () => (await t.json<{ action: string; details?: unknown }[]>('GET', '/api/audit')).map((e) => e.action);

/** An operator who accepted an invite: the cookie of their session, still in the setup wizard. */
async function invitee(name: string): Promise<{ cookie: string; id: number }> {
  const admin = t.cookie;
  const inv = await t.json<Invite>('POST', '/api/invites', { role: 'operator' });
  t.cookie = null;
  const state = await t.json<AuthState>('POST', `/api/invites/${inv.url!.split('/').pop()!}/accept`, { username: name });
  const cookie = t.cookie!;
  t.cookie = admin;
  return { cookie, id: state.user!.id };
}

describe('challenges waiting for an answer', () => {
  it('are capped: asking needs no account, so the oldest make room (audit 2026-11-05)', async () => {
    const { ChallengeStore, challengeLimit } = await import('../../src/auth/passkeys.js');
    expect(challengeLimit.max).toBe(10_000);
    const store = new ChallengeStore(3);
    const ids = ['a', 'b', 'c', 'd'].map((challenge) => store.put(t.ctx, { challenge, purpose: 'login', userId: null }));
    expect(store.size).toBe(3);
    expect(store.take(t.ctx, ids[0]!, 'login')).toBeNull();
    expect(ids.slice(1).map((id) => store.take(t.ctx, id, 'login')?.challenge)).toEqual(['b', 'c', 'd']);
  });

  it('the public options route does not grow them without bound (audit 2026-11-05)', async () => {
    // 10 000 for real; lowered here, so the test is quick.
    const { challengeLimit } = await import('../../src/auth/passkeys.js');
    challengeLimit.max = 20;
    try {
      const key = newKey();
      await register(key);
      await t.json('POST', '/api/auth/logout');
      const first = await t.json<AuthOptions>('POST', '/api/auth/passkey/options');
      // Each from another address it names: through a proxy Burrow was not told about, any passes (A3-SRV-02).
      for (let i = 0; i < 20; i++) expect((await t.app.inject({ method: 'POST', url: '/api/auth/passkey/options', headers: { origin: ORIGIN, 'x-forwarded-for': `10.9.0.${i}` } })).statusCode).toBe(200);
      expect((await t.request('POST', '/api/auth/passkey/verify', { challengeId: first.challengeId, response: key.get(first.options) })).statusCode).toBe(401);
      expect((await signInWith(key)).statusCode).toBe(200);
    } finally {
      challengeLimit.max = 10_000;
    }
  });
});

describe('registering a passkey', () => {
  it('asks for a resident key with user verification, stores it, lists it and audits it', async () => {
    const { options } = await t.json<RegOptions>('POST', '/api/account/passkeys/options');
    expect(options.rp.id).toBe('localhost');
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });

    const key = newKey();
    const pk = await register(key, 'My phone');
    expect(pk).toMatchObject({ name: 'My phone', lastUsedAt: null, createdAt: new Date(t.clock.now).toISOString() });
    expect(await t.json<PasskeyInfo[]>('GET', '/api/account/passkeys')).toEqual([pk]);
    expect((await t.json<AuthState>('GET', '/api/auth/state')).user!.hasPasskey).toBe(true);
    expect(await audits()).toContain('account.passkey_added');

    // The next registration leaves out the authenticator that has one already.
    const again = await t.json<RegOptions>('POST', '/api/account/passkeys/options');
    expect(again.options.excludeCredentials!.map((c) => c.id)).toEqual([key.credentialId]);
  });

  it('refuses a ceremony that was not for this challenge, this site or a verified person; a challenge is used once and lives five minutes', async () => {
    const refused = async (make: (o: RegOptions) => { challengeId: string; response: unknown }) => {
      const o = await t.json<RegOptions>('POST', '/api/account/passkeys/options');
      const r = await t.request('POST', '/api/account/passkeys/verify', make(o));
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ error: 'passkey_rejected' });
    };
    await refused(({ challengeId, options }) => ({ challengeId, response: newKey().create({ ...options, challenge: 'c29tZXRoaW5nIGVsc2U' }) }));
    await refused(({ challengeId, options }) => ({ challengeId, response: newKey().create(options, { origin: 'https://evil.example' }) }));
    await refused(({ challengeId, options }) => ({ challengeId, response: newKey().create(options, { verified: false }) }));
    await refused(({ options }) => ({ challengeId: 'no-such-challenge', response: newKey().create(options) }));
    // Used once: the same answer again is refused.
    const o = await t.json<RegOptions>('POST', '/api/account/passkeys/options');
    const response = newKey().create(o.options);
    expect((await t.request('POST', '/api/account/passkeys/verify', { challengeId: o.challengeId, response })).statusCode).toBe(200);
    expect((await t.request('POST', '/api/account/passkeys/verify', { challengeId: o.challengeId, response })).statusCode).toBe(400);
    // Five minutes and it is gone.
    await refused(({ challengeId, options }) => {
      t.advance(5 * 60_000 + 1);
      return { challengeId, response: newKey().create(options) };
    });
    expect(await t.json<PasskeyInfo[]>('GET', '/api/account/passkeys')).toHaveLength(1);
  });

  it("refuses a challenge given to someone else: one person's ceremony cannot add a passkey to another's account", async () => {
    const o = await t.json<RegOptions>('POST', '/api/account/passkeys/options');
    const other = await invitee('olivia');
    const r = await t.request('POST', '/api/account/passkeys/verify', { challengeId: o.challengeId, response: newKey().create(o.options) }, { cookie: other.cookie });
    expect(r.statusCode).toBe(400);
    expect(t.ctx.db.select().from(passkeys).all()).toEqual([]);
  });
});

describe('signing in with a passkey', () => {
  it('signs in without a username, in a new session, and notes when the passkey was used', async () => {
    const key = newKey();
    await register(key);
    const before = t.cookie;
    await t.json('POST', '/api/auth/logout');
    t.advance(60_000);

    const { options } = await t.json<AuthOptions>('POST', '/api/auth/passkey/options');
    // Discoverable: the authenticator offers what it has, none named here.
    expect(options.allowCredentials ?? []).toEqual([]);
    expect(options.userVerification).toBe('required');
    const r = await signInWith(key);
    expect(r.statusCode).toBe(200);
    expect(r.json<AuthState>().user).toMatchObject({ username: 'admin', hasPasskey: true });
    expect(t.cookie).not.toBe(before);
    expect((await t.json<PasskeyInfo[]>('GET', '/api/account/passkeys'))[0]!.lastUsedAt).toBe(new Date(t.clock.now).toISOString());
    expect(t.ctx.db.select().from(passkeys).get()!.counter).toBe(key.counter);
    expect(await audits()).toContain('auth.login');
  });

  it('refuses a replayed, forged or cloned assertion, an unknown passkey and an unverified person, each counted as a failed sign-in', async () => {
    const key = newKey();
    await register(key);
    const admin = t.cookie;
    t.cookie = null;

    const expectRefused = async (r: Awaited<ReturnType<typeof signInWith>>) => {
      expect(r.statusCode).toBe(401);
      expect(r.json()).toMatchObject({ error: 'invalid_credentials' });
      expect(t.cookie).toBeNull();
    };
    await expectRefused(await signInWith(key, { forge: true }));
    await expectRefused(await signInWith(newKey()));
    await expectRefused(await signInWith(key, { verified: false }));
    await expectRefused(await signInWith(key, { origin: 'https://evil.example' }));
    // Replayed: the same assertion for the same (now used) challenge.
    const { challengeId, options } = await t.json<AuthOptions>('POST', '/api/auth/passkey/options');
    const response = key.get(options);
    expect((await t.request('POST', '/api/auth/passkey/verify', { challengeId, response })).statusCode).toBe(200);
    t.cookie = null;
    await expectRefused(await t.request('POST', '/api/auth/passkey/verify', { challengeId, response }));
    // A copy of the key whose counter is behind the server's: a clone.
    await expectRefused(await signInWith(key, { counter: 1 }));
    // A step-up challenge does not sign in.
    t.cookie = admin;
    const stepUp = await t.json<AuthOptions>('POST', '/api/auth/step-up/passkey/options');
    t.cookie = null;
    await expectRefused(await t.request('POST', '/api/auth/passkey/verify', { challengeId: stepUp.challengeId, response: key.get(stepUp.options) }));

    t.cookie = admin;
    const failed = (await t.json<{ action: string }[]>('GET', '/api/audit')).filter((e) => e.action === 'auth.login_failed');
    expect(failed).toHaveLength(7);
  });

  it('an account still in its setup wizard does not sign in with its passkey', async () => {
    const o = await invitee('olivia');
    const admin = t.cookie;
    t.cookie = o.cookie;
    const key = newKey();
    await register(key);
    t.cookie = null;
    expect((await signInWith(key)).statusCode).toBe(401);
    // Once set up, it does.
    t.ctx.db.update(users).set({ incomplete: false }).where(eq(users.id, o.id)).run();
    expect((await signInWith(key)).statusCode).toBe(200);
    t.cookie = admin;
  });
});

describe('step-up with a passkey', () => {
  it("confirms with one of the person's own passkeys, never another's", async () => {
    const mine = newKey();
    await register(mine);
    const o = await invitee('olivia');
    const admin = t.cookie;
    t.cookie = o.cookie;
    const theirs = newKey();
    await register(theirs);
    t.cookie = admin;

    t.advance(16 * 60_000);
    expect((await t.request('POST', '/api/account/recovery-codes')).json()).toMatchObject({ error: 'step_up_required' });
    const opts = await t.json<AuthOptions>('POST', '/api/auth/step-up/passkey/options');
    expect(opts.options.allowCredentials!.map((c) => c.id)).toEqual([mine.credentialId]);
    // Another person's passkey, signed for this very challenge.
    const other = await t.request('POST', '/api/auth/step-up/passkey/verify', { challengeId: opts.challengeId, response: theirs.get(opts.options) });
    expect(other.statusCode).toBe(401);
    expect((await t.json<AuthState>('GET', '/api/auth/state')).stepUpUntil).toBeNull();

    const again = await t.json<AuthOptions>('POST', '/api/auth/step-up/passkey/options');
    const state = await t.json<AuthState>('POST', '/api/auth/step-up/passkey/verify', { challengeId: again.challengeId, response: mine.get(again.options) });
    expect(state.stepUpUntil).toBe(new Date(t.clock.now + 15 * 60_000).toISOString());
    const actions = await audits();
    expect(actions).toContain('auth.step_up');
    expect(actions).toContain('auth.step_up_failed');
  });
});

describe('removing a passkey', () => {
  it("needs a fresh step-up, only removes the person's own, and never the last way in", async () => {
    const key = newKey();
    const pk = await register(key);
    const o = await invitee('olivia');
    const admin = t.cookie;
    t.cookie = o.cookie;
    const theirs = await register(newKey());
    t.ctx.db.update(users).set({ incomplete: false }).where(eq(users.id, o.id)).run();
    // Their only way in.
    const last = await t.request('DELETE', `/api/account/passkeys/${theirs.id}`);
    expect(last.statusCode).toBe(409);
    expect(last.json()).toMatchObject({ error: 'last_login_method' });
    // Not theirs to remove.
    expect((await t.request('DELETE', `/api/account/passkeys/${pk.id}`)).statusCode).toBe(404);
    t.cookie = admin;

    t.advance(16 * 60_000);
    expect((await t.request('DELETE', `/api/account/passkeys/${pk.id}`)).json()).toMatchObject({ error: 'step_up_required' });
    await t.json('POST', '/api/auth/step-up/totp', { code: await totpNow(totp, t) });
    // The admin keeps password and TOTP.
    expect((await t.request('DELETE', `/api/account/passkeys/${pk.id}`)).statusCode).toBe(204);
    expect(await t.json<PasskeyInfo[]>('GET', '/api/account/passkeys')).toEqual([]);
    expect(await audits()).toContain('account.passkey_removed');
  });
});

describe('recovery codes and invites', () => {
  it('new recovery codes replace the old ones, after a step-up', async () => {
    const before = await t.json<{ remaining: number }>('GET', '/api/account/recovery-codes');
    const { recoveryCodes } = await t.json<{ recoveryCodes: string[] }>('POST', '/api/account/recovery-codes');
    expect(recoveryCodes).toHaveLength(before.remaining);
    expect(await audits()).toContain('account.recovery_codes_regenerated');
  });

  it('an old recovery code no longer signs in once new ones were made', async () => {
    const { recoveryCodes: old } = await t.json<{ recoveryCodes: string[] }>('POST', '/api/account/recovery-codes');
    const { recoveryCodes: fresh } = await t.json<{ recoveryCodes: string[] }>('POST', '/api/account/recovery-codes');
    await t.json('POST', '/api/auth/logout');
    expect((await t.request('POST', '/api/auth/recovery', { username: 'admin', code: old[0] })).statusCode).toBe(401);
    expect((await t.request('POST', '/api/auth/recovery', { username: 'admin', code: fresh[0] })).statusCode).toBe(200);
  });

  it('an invite link says what it is for; a wrong one is refused and counted', async () => {
    const inv = await t.json<Invite>('POST', '/api/invites', { role: 'operator' });
    const token = inv.url!.split('/').pop()!;
    const admin = t.cookie;
    t.cookie = null;
    expect(await t.json('GET', `/api/invites/${token}`)).toEqual({ role: 'operator', expiresAt: inv.expiresAt });
    const bad = await t.request('POST', '/api/invites/not-a-token/accept', { username: 'mallory' });
    expect(bad.statusCode).toBe(404);
    expect(bad.json()).toMatchObject({ error: 'invite_invalid' });
    expect(t.cookie).toBeNull();
    // Used once.
    await t.json('POST', `/api/invites/${token}/accept`, { username: 'olivia' });
    expect((await t.request('GET', `/api/invites/${token}`)).statusCode).toBe(404);
    t.cookie = admin;
    expect(await audits()).toContain('invite.rejected');
  });
});
