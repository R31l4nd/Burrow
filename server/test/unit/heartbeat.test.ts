import { describe, expect, it } from 'vitest';
import { Heartbeat } from '../../src/heartbeat.js';
import { makeApp } from '../helpers.js';

describe('the heartbeat (a dead-man switch, 2026-11-07)', () => {
  it('calls the address only while Burrow runs well, and says a failure once', async () => {
    const t = await makeApp();
    const calls: string[] = [];
    let status = 200;
    let healthy = true;
    const warned: string[] = [];
    const warn = t.ctx.log.warn.bind(t.ctx.log);
    t.ctx.log.warn = ((m: string) => (warned.push(m), warn(m))) as typeof t.ctx.log.warn;
    const h = new Heartbeat(t.ctx, { fetch: async (url: string) => (calls.push(url), new Response('', { status })), healthy: () => healthy });
    expect(await h.beat()).toBe('off');
    t.ctx.config.heartbeatUrl = 'https://hc-ping.example.com/abc';
    expect(await h.beat()).toBe('sent');
    healthy = false;
    expect(await h.beat()).toBe('unwell');
    healthy = true;
    status = 503;
    expect(await h.beat()).toBe('failed');
    expect(await h.beat()).toBe('failed');
    expect(calls).toEqual(Array(3).fill('https://hc-ping.example.com/abc'));
    // Said once, and without the address (it can hold a token).
    expect(warned.filter((m) => m.startsWith('heartbeat'))).toEqual(['heartbeat: calling the heartbeat address failed: answered 503']);
    await t.close();
  });

  it('is set in Settings -> System, before the .env', async () => {
    const t = await makeApp();
    const { setupAdmin } = await import('../helpers.js');
    await setupAdmin(t);
    const r = (await t.json('PUT', '/api/settings/system', { terminalMaxSessions: null, terminalIdleMinutes: null, statusIntervalSeconds: null, updateCheckExclude: null, registryEndpoints: null, appsBaseDomain: null, heartbeatUrl: 'https://kuma.example.com/api/push/x' })) as { effective: { heartbeatUrl: string } };
    expect(r.effective.heartbeatUrl).toBe('https://kuma.example.com/api/push/x');
    expect(t.ctx.config.heartbeatUrl).toBe('https://kuma.example.com/api/push/x');
    expect((await t.request('PUT', '/api/settings/system', { terminalMaxSessions: null, terminalIdleMinutes: null, statusIntervalSeconds: null, updateCheckExclude: null, registryEndpoints: null, appsBaseDomain: null, heartbeatUrl: 'ftp://x' })).statusCode).toBe(400);
    await t.close();
  });
});
