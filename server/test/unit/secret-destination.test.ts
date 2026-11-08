import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiSettings, Channel } from '@burrow/shared';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// A stored secret goes only where it was given for: a new address without the secret again
// drops it (A3-SRV-07, A3-SRV-17).
const sent: { url: string; headers: Record<string, string> }[] = [];
let t: TestApp;

beforeAll(async () => {
  t = await makeApp({
    send: {
      fetch: async (url, init) => {
        sent.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
        return new Response(null, { status: 200 });
      },
    },
  });
  await setupAdmin(t);
});
afterAll(async () => {
  await t.close();
});

const ntfy = (url: string, token?: string) => ({ kind: 'ntfy', name: 'phone', enabled: true, topics: ['alerts'], lang: 'en', ntfy: { url, topic: 'burrow', openIn: 'app', ...(token !== undefined ? { token } : {}) } });

describe('stored secrets and their destination', () => {
  it('an ntfy token does not follow the channel to another server (A3-SRV-07)', async () => {
    const c = await t.json<Channel>('POST', '/api/channels', ntfy('https://ntfy.example.net', 'tk_secret'));
    expect(c.ntfy!.hasToken).toBe(true);
    // Same server, another path: kept.
    expect((await t.json<Channel>('PUT', `/api/channels/${c.id}`, ntfy('https://ntfy.example.net/'))).ntfy!.hasToken).toBe(true);
    const moved = await t.json<Channel>('PUT', `/api/channels/${c.id}`, ntfy('http://127.0.0.1:18502'));
    expect(moved.ntfy!.hasToken).toBe(false);
    sent.length = 0;
    await t.json('POST', `/api/channels/${c.id}/test`);
    expect(sent.map((s) => s.url)).toEqual([expect.stringContaining('127.0.0.1:18502')]);
    expect(JSON.stringify(sent[0]!.headers)).not.toContain('tk_secret');
    // Given again with the new address: kept there.
    expect((await t.json<Channel>('PUT', `/api/channels/${c.id}`, ntfy('http://127.0.0.1:18502', 'tk_other'))).ntfy!.hasToken).toBe(true);
  });

  it('an SMTP password does not follow to another mail server or onto a connection without TLS (A3-SRV-07)', async () => {
    const mail = (host: string, port: number, secure: boolean, password?: string) => ({
      kind: 'email',
      name: 'mail',
      enabled: true,
      topics: ['alerts'],
      lang: 'en',
      email: { host, port, secure, user: 'me', from: 'burrow@example.com', to: 'me@example.com', ...(password !== undefined ? { password } : {}) },
    });
    const c = await t.json<Channel>('POST', '/api/channels', mail('smtp.example.com', 465, true, 'app-password'));
    expect((await t.json<Channel>('PUT', `/api/channels/${c.id}`, mail('SMTP.example.com', 465, true))).email!.hasPassword).toBe(true);
    expect((await t.json<Channel>('PUT', `/api/channels/${c.id}`, mail('smtp.example.com', 465, false))).email!.hasPassword).toBe(false);
    await t.json<Channel>('PUT', `/api/channels/${c.id}`, mail('smtp.example.com', 465, true, 'app-password'));
    expect((await t.json<Channel>('PUT', `/api/channels/${c.id}`, mail('mail.attacker.example', 465, true))).email!.hasPassword).toBe(false);
  });

  it("an OpenAI-compatible key and the provider's client secret do not follow a new address either (A3-SRV-17)", async () => {
    const ai = (url: string, apiKey?: string) => ({ provider: 'openai', ollama: { url: 'http://ollama:11434', model: '' }, anthropic: { model: '' }, openai: { url, model: 'm', ...(apiKey !== undefined ? { apiKey } : {}) } });
    expect((await t.json<AiSettings>('PUT', '/api/settings/ai', ai('https://llm.example.net/v1', 'sk-key'))).openai.hasKey).toBe(true);
    expect((await t.json<AiSettings>('PUT', '/api/settings/ai', ai('https://llm.example.net/v2'))).openai.hasKey).toBe(true);
    expect((await t.json<AiSettings>('PUT', '/api/settings/ai', ai('https://elsewhere.example'))).openai.hasKey).toBe(false);
    const sso = (issuer: string, clientSecret?: string) => ({ enabled: false, issuer, clientId: 'burrow', label: 'SSO', claim: 'preferred_username', ...(clientSecret !== undefined ? { clientSecret } : {}) });
    expect((await t.json<{ hasSecret: boolean }>('PUT', '/api/settings/oidc', sso('https://id.example.net/app', 'cs'))).hasSecret).toBe(true);
    expect((await t.json<{ hasSecret: boolean }>('PUT', '/api/settings/oidc', sso('https://id.example.net/app/'))).hasSecret).toBe(true);
    expect((await t.json<{ hasSecret: boolean }>('PUT', '/api/settings/oidc', sso('https://evil.example/app'))).hasSecret).toBe(false);
  });
});
