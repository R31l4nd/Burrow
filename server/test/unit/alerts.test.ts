import { describe, expect, it } from 'vitest';
import { groupLines, maskText, renderGroups, template } from '@burrow/shared';
import { EventJudge, parseEvent } from '../../src/alerts/events.js';
import { covers } from '../../src/alerts/engine.js';
import { ntfyRequest } from '../../src/notify/ntfy.js';
import { isLocalUrl } from '../../src/ai/settings.js';
import { bodyLines } from '../../src/ai/stream.js';

describe('masking', () => {
  it('hides secrets always and IP addresses when asked', () => {
    const line =
      'login admin@example.com password=hunter2 token: abc123def Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U from 10.0.0.5 via postgres://app:s3cret@db:5432/app';
    const m = maskText(line, { ips: false });
    for (const secret of ['admin@example.com', 'hunter2', 'abc123def', 'eyJhbGci', 's3cret']) expect(m).not.toContain(secret);
    expect(m).toContain('password=<secret>');
    expect(m).toContain('postgres://app:<secret>@db');
    expect(m).toContain('10.0.0.5');
    expect(maskText(line, { ips: true })).not.toContain('10.0.0.5');
    expect(maskText('key ghp_abcdefghijklmnopqrstuvwxyz0123 and AKIAABCDEFGHIJKLMNOP', { ips: false })).toBe('key <secret> and <secret>');
    // Ordinary text stays.
    expect(maskText('GET /api/health 200 in 3 ms', { ips: true })).toBe('GET /api/health 200 in 3 ms');
  });

  it('also an Authorization header of another kind, pwd=, and a private key', () => {
    const leaks = [
      ['Authorization: Token 9f8e7d6c5b4a39281706', '9f8e7d6c5b4a39281706'],
      ['authorization="ApiKey QWxhZGRpbjpvcGVuIHNlc2FtZQ"', 'QWxhZGRpbjpvcGVuIHNlc2FtZQ'],
      ['connect: pwd=Winter2026! user=app', 'Winter2026!'],
      ['x-auth-token: ab12cd34ef56', 'ab12cd34ef56'],
      // Put together here, so the repository holds no key-shaped block (scripts/check-public.sh refuses one).
      [`-----BEGIN OPENSSH ${'PRIVATE'} KEY----- b3BlbnNzaC1rZXktdjEAAAAA -----END OPENSSH ${'PRIVATE'} KEY-----`, 'b3BlbnNzaC1rZXktdjEAAAAA'],
    ] as const;
    for (const [line, secret] of leaks) expect(maskText(line, { ips: false }), line).not.toContain(secret);
    // Words that merely look alike stay.
    expect(maskText('author: Jane wrote the tokenizer', { ips: false })).toBe('author: Jane wrote the tokenizer');
  });
});

describe('grouping', () => {
  it('turns repeats into templates, errors first, within a budget', () => {
    expect(template('2026-09-27T10:00:01Z request 17 took 35 ms from 10.1.2.3 id 550e8400-e29b-41d4-a716-446655440000')).toBe('<time> request <n> took <n> ms from <ip> id <uuid>');
    const lines = [
      ...Array.from({ length: 30 }, (_, i) => ({ source: 'web', ts: `t${i}`, text: `INFO request ${i} took ${i} ms` })),
      { source: 'web', ts: 't99', text: 'ERROR db down' },
      { source: 'db', ts: 't98', text: 'WARN slow query 1200 ms' },
    ];
    const { groups, total, omitted } = groupLines(lines, { ips: false, budget: 10_000 });
    expect(total).toBe(3);
    expect(omitted).toBe(0);
    expect(groups.map((g) => [g.level, g.count])).toEqual([
      ['error', 1],
      ['warn', 1],
      ['info', 30],
    ]);
    expect(groups[2]).toMatchObject({ first: 't0', last: 't29', source: 'web' });
    expect(renderGroups(groups.slice(0, 1))).toBe('[web] 1x error t99\n  ERROR db down');
    // A small budget keeps what matters most.
    expect(groupLines(lines, { ips: false, budget: 50 }).groups.map((g) => g.level)).toEqual(['error']);
  });
});

describe('docker events', () => {
  const ev = (action: string, name: string, extra: Record<string, string> = {}, sec = 1000) =>
    JSON.stringify({ Type: 'container', Action: action, Actor: { ID: `id-${name}`, Attributes: { name, ...extra } }, time: sec, timeNano: sec * 1e9 });

  it('reads crashes, OOM and health', () => {
    expect(parseEvent(ev('die', 'web', { exitCode: '3', 'com.docker.compose.project': 'shop' }))).toMatchObject({ container: 'web', project: 'shop', action: 'die', exitCode: 3, at: '1970-01-01T00:16:40.000Z' });
    expect(parseEvent(ev('health_status: unhealthy', 'web'))?.action).toBe('unhealthy');
    expect(parseEvent(ev('start', 'web'))).toBeNull();
    // Labelled to be left alone (throwaway and test containers): no alert.
    expect(parseEvent(ev('die', 'probe', { exitCode: '1', 'burrow.ignore': 'true' }))).toBeNull();
    expect(parseEvent('not json')).toBeNull();
  });

  it('a stop is no crash; a clean exit is none; three exits are a loop', () => {
    const j = new EventJudge();
    const p = (line: string) => j.judge(parseEvent(line)!).map((h) => h.event);
    expect(p(ev('die', 'a', { exitCode: '1' }))).toEqual(['crash']);
    expect(p(ev('kill', 'b', { signal: '15' }, 2000))).toEqual([]);
    expect(p(ev('die', 'b', { exitCode: '143' }, 2001))).toEqual([]);
    expect(p(ev('die', 'c', { exitCode: '0' }, 3000))).toEqual([]);
    expect(p(ev('die', 'c', { exitCode: '0' }, 3060))).toEqual([]);
    expect(p(ev('die', 'c', { exitCode: '0' }, 3120))).toEqual(['restart_loop']);
    expect(p(ev('oom', 'd'))).toEqual(['oom']);
  });

  it('a rule covers a host, stack or container', () => {
    const r = { hostId: null, container: null, project: 'shop' } as never;
    expect(covers(r, 1, 'web', 'shop')).toBe(true);
    expect(covers(r, 1, 'web', 'blog')).toBe(false);
    expect(covers({ hostId: 2, container: 'web', project: null } as never, 1, 'web', null)).toBe(false);
  });
});

describe('push', () => {
  it('builds the ntfy request', () => {
    const { url, init } = ntfyRequest(
      { url: 'https://ntfy.example', topic: 'burrow-x', token: 'tk' },
      // Beyond ASCII on purpose: ntfy's headers must carry it encoded.
      { title: 'web on nas: exited with code 1 \u2014 \u2717', body: 'boom', priority: 4, tags: ['rotating_light'], click: 'https://b/#/logs', actions: [{ label: 'Analyse', url: 'https://b/#/logs&analyze=1' }] },
    );
    expect(url).toBe('https://ntfy.example/burrow-x');
    const hd = init.headers as Record<string, string>;
    expect(hd.title).toMatch(/^=\?UTF-8\?B\?/);
    expect(Buffer.from(hd.title!.slice(10, -2), 'base64').toString()).toBe('web on nas: exited with code 1 \u2014 \u2717');
    expect(hd).toMatchObject({ priority: '4', tags: 'rotating_light', click: 'https://b/#/logs', actions: 'view, Analyse, https://b/#/logs&analyze=1', authorization: 'Bearer tk' });
    expect(init.body).toBe('boom');
  });
});

describe('models', () => {
  it('knows which servers are on this network', () => {
    for (const u of ['http://ollama:11434', 'http://localhost:8000/v1', 'http://10.0.0.20:11434', 'http://nas.local:1', 'http://[::1]:8000']) expect(isLocalUrl(u), u).toBe(true);
    for (const u of ['https://api.openai.com/v1', 'https://llm.example.com', 'http://8.8.8.8']) expect(isLocalUrl(u), u).toBe(false);
    // A public IPv6 address has no dot, and a name may start like a private address: neither is local.
    for (const u of ['https://[2001:4860:4860::8888]', 'https://10.public.example', 'https://192.168.attacker.example', 'http://172.16.example.com']) expect(isLocalUrl(u), u).toBe(false);
    for (const u of ['http://[fd00::5]:11434', 'http://[fe80::1]', 'http://172.20.0.5', 'http://ai.home.arpa']) expect(isLocalUrl(u), u).toBe(true);
  });

  it('splits a streamed body into lines', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const part of ['data: {"a"', ':1}\n\ndata: [DO', 'NE]\n']) c.enqueue(enc.encode(part));
        c.close();
      },
    });
    const out: string[] = [];
    for await (const l of bodyLines(body)) out.push(l);
    expect(out).toEqual(['data: {"a":1}', '', 'data: [DONE]']);
  });
});

describe('alert titles', () => {
  it('in Dutch for the page and the push', async () => {
    const { alertTitle } = await import('@burrow/shared');
    expect(alertTitle('exited with code 3', 'nl')).toBe('gestopt met code 3');
    expect(alertTitle('stopped 3 times in 5 minutes', 'nl')).toBe('3 keer gestopt in 5 minuten');
    expect(alertTitle('log matches "timeout"', 'nl')).toBe('log past bij "timeout"');
    expect(alertTitle('exited with code 3', 'en')).toBe('exited with code 3');
    expect(alertTitle('something new', 'nl')).toBe('something new');
    // One is singular, in both languages (old titles said "1 ... sectors").
    expect(alertTitle('1 reallocated sector (was 0)', 'nl')).toBe('1 verplaatste sector (was 0)');
    expect(alertTitle('1 reallocated sectors (was 0)', 'nl')).toBe('1 verplaatste sector (was 0)');
    expect(alertTitle('2 errors in 5 min', 'nl')).toBe('2 fouten in 5 min');
    const { reasonText } = await import('@burrow/shared');
    expect(reasonText({ code: 'errors', n: 1 }, 'en')).toBe('1 error');
    expect(reasonText({ code: 'warnings', n: 1 }, 'nl')).toBe('1 waarschuwing');
  });
});

describe('similar lines', () => {
  it('merge when they differ in a few words, like Drain', async () => {
    const { groupLines, mergeTemplate, renderGroups } = await import('@burrow/shared');
    expect(mergeTemplate('INFO user alice logged in from web', 'INFO user bob logged in from web')).toBe('INFO user <*> logged in from web');
    expect(mergeTemplate('INFO user alice logged in', 'WARN user alice logged in')).toBeNull();
    expect(mergeTemplate('GET /a', 'GET /b')).toBeNull();
    const names = ['alice', 'bob', 'carol', 'dave', 'erin'];
    const lines = names.flatMap((n) => [
      { source: 'web', ts: null, text: `INFO user ${n} logged in from the web client` },
      { source: 'web', ts: null, text: `INFO cache miss for /home/${n}/avatar.png` },
    ]);
    const { groups, total } = groupLines(lines, { ips: false, budget: 10_000 });
    expect(total).toBe(2);
    expect(groups.map((g) => g.count)).toEqual([5, 5]);
    expect(renderGroups(groups)).toContain('pattern: INFO user <*> logged in from the web client');
  });
});

describe('patterns from people against lines from elsewhere', () => {
  it('take time in step with the line: "(a+)+$" held up the whole server', async () => {
    const { linearMatcher } = await import('../../src/linear.js');
    const m = linearMatcher('^(a+)+$');
    if (m instanceof Error) throw m;
    const t0 = performance.now();
    expect(m('a'.repeat(5000) + '!')).toBe(false);
    // Backtracking would take minutes; 2 s leaves room for a machine under load (622 ms seen in a gate).
    expect(performance.now() - t0).toBeLessThan(2000);
    const err = linearMatcher('(?<=x)y');
    expect(err).toBeInstanceOf(Error);
    const ok = linearMatcher('ERROR|fatal');
    expect(ok instanceof Error ? null : ok('a Fatal one')).toBe(true);
  });

  it('a rule with a pattern RE2 cannot run is refused when saved', async () => {
    const { makeApp, setupAdmin } = await import('../helpers.js');
    const t = await makeApp();
    await setupAdmin(t);
    const r = await t.request('POST', '/api/alerts/rules', { name: 'x', kind: 'pattern', hostId: null, container: null, project: null, pattern: '(?<=user )admin' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid_pattern');
    expect((await t.request('POST', '/api/alerts/rules', { name: 'y', kind: 'pattern', hostId: null, container: null, project: null, pattern: 'out of memory' })).statusCode).toBe(200);
    await t.close();
  });
});
