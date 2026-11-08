import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SystemSettings } from '@burrow/shared';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Settings that were only in the .env file, set in Settings -> System: nothing set is the .env's
// value, a value set applies at once (no restart) and stays over a restart.
const dir = mkdtempSync(join(tmpdir(), 'burrow-system-'));
const dbFile = join(dir, 'burrow.db');
const env = { TERMINAL_MAX_SESSIONS: '7', TERMINAL_IDLE_MINUTES: '30', UPDATE_CHECK_EXCLUDE: '^registry\\.example\\.com/', REGISTRY_ENDPOINTS: 'localhost:5000=http://172.17.0.1:5000', APPS_BASE_DOMAIN: 'example.org' };
let t: TestApp;

beforeAll(async () => {
  t = await makeApp({ dbFile, env });
  await setupAdmin(t);
});
afterAll(async () => {
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});

const none = { terminalMaxSessions: null, terminalIdleMinutes: null, statusIntervalSeconds: null, updateCheckExclude: null, registryEndpoints: null, appsBaseDomain: null, heartbeatUrl: null };

describe('Settings -> System', () => {
  it("nothing set: the .env's values, said as such", async () => {
    const s = await t.json<SystemSettings>('GET', '/api/settings/system');
    expect(s.saved).toEqual(none);
    expect(s.env).toEqual({ terminalMaxSessions: 7, terminalIdleMinutes: 30, statusIntervalSeconds: 0, updateCheckExclude: '^registry\\.example\\.com/', registryEndpoints: 'localhost:5000=http://172.17.0.1:5000', appsBaseDomain: 'example.org', heartbeatUrl: '' });
    expect(s.effective).toEqual(s.env);
  });

  it('a value set applies at once, the others stay the .env\'s; cleared, the .env\'s again', async () => {
    const s = await t.json<SystemSettings>('PUT', '/api/settings/system', { ...none, terminalMaxSessions: 3, updateCheckExclude: '', registryEndpoints: 'reg.lan:5000=https://10.0.0.5:5000' });
    expect(s.effective).toMatchObject({ terminalMaxSessions: 3, terminalIdleMinutes: 30, updateCheckExclude: '', registryEndpoints: 'reg.lan:5000=https://10.0.0.5:5000', appsBaseDomain: 'example.org' });
    // What the running parts read: the new values.
    expect(t.ctx.config.terminalMaxSessions).toBe(3);
    expect(t.ctx.config.updateCheckExclude).toBeNull();
    expect(t.ctx.config.registryEndpoints).toEqual({ 'reg.lan:5000': 'https://10.0.0.5:5000' });
    const back = await t.json<SystemSettings>('PUT', '/api/settings/system', none);
    expect(back.effective).toEqual(back.env);
    expect(t.ctx.config.updateCheckExclude?.test('registry.example.com/app:1')).toBe(true);
    expect(t.ctx.config.registryEndpoints).toEqual({ 'localhost:5000': 'http://172.17.0.1:5000' });
  });

  it('refused: a broken pattern, an address that is not one, an interval too short; and without a fresh step-up', async () => {
    for (const bad of [{ updateCheckExclude: '^(' }, { registryEndpoints: 'reg.lan=ftp://x' }, { registryEndpoints: 'no-equals-sign' }, { statusIntervalSeconds: 3 }, { terminalMaxSessions: 0 }, { appsBaseDomain: 'not a domain' }, { heartbeatUrl: 'ftp://x' }]) {
      expect((await t.request('PUT', '/api/settings/system', { ...none, ...bad })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    t.advance(60 * 60_000);
    expect((await t.request('PUT', '/api/settings/system', none)).json()).toMatchObject({ error: 'step_up_required' });
  });

  it('kept over a restart: the next start reads it before anything uses the values', async () => {
    const t2 = await makeApp({ dbFile, env });
    try {
      // Written by the first app, straight into the shared database file.
      t2.ctx.db.$client.prepare("insert or replace into app_settings (key, value, updated_at) values ('system', ?, 0)").run(JSON.stringify({ ...none, terminalIdleMinutes: 5 }));
    } finally {
      await t2.close();
    }
    const t3 = await makeApp({ dbFile, env });
    try {
      expect(t3.ctx.config.terminalIdleMinutes).toBe(5);
      expect(t3.ctx.config.terminalMaxSessions).toBe(7);
    } finally {
      await t3.close();
    }
  });
});
