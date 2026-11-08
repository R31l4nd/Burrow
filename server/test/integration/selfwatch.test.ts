import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Channel, ConnectResult, Host, HostContainers } from '@burrow/shared';
import { selfContainerId } from '../../src/docker/stacks.js';
import { exec } from '../../src/ssh/connect.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// Burrow telling about itself (2026-11-07), wired as it runs: the daily
// version check goes over SSH to a real checkout on the test sshd, the
// notices go through the real channels (their HTTP calls caught here), a
// failing channel is the notifier's own record, an error is one Burrow
// logged. The rules themselves are in test/unit/selfwatch.test.ts.
const SSHD_HOST = process.env.SSHD_HOST ?? '127.0.0.1';
const SSHD_PORT = Number(process.env.SSHD_PORT ?? 2299);
const DIR = `/tmp/burrow-selfwatch-${process.pid}`;
const HOUR = 3600_000;
const BEAT = 'https://hc.example.invalid/ping/abc';

let t: TestApp;
let h: Host;
/** What each ntfy topic received: its title header, in order. */
const got: { topic: string; title: string; body: string }[] = [];
let brokenFails = true;
const beats: string[] = [];
let beatFails = false;

async function channelFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const topic = String(url).split('/').pop()!;
  if (topic === 'broken' && brokenFails) return new Response('unauthorized', { status: 401 });
  const headers = init?.headers as Record<string, string>;
  got.push({ topic, title: headers.title ?? '', body: String(init?.body ?? '') });
  return new Response('{}', { status: 200 });
}

const sh = (cmd: string) => t.files.with(h.id, ({ client }) => exec(client, cmd, 30_000));
const titles = (topic: string) => got.filter((g) => g.topic === topic).map((g) => g.title);

beforeAll(async () => {
  t = await makeApp({
    env: { HEARTBEAT_URL: BEAT },
    send: { fetch: channelFetch as typeof fetch },
    fetch: (async (url: string) => {
      beats.push(url);
      return new Response(beatFails ? 'gone' : 'OK', { status: beatFails ? 404 : 200 });
    }) as typeof fetch,
  });
  await setupAdmin(t);
  h = await t.json<Host>('POST', '/api/hosts', { name: 'burrow-home', address: SSHD_HOST, port: SSHD_PORT, username: 'tester', authMethod: 'password', password: 'burrow-test-password' });
  const r = await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`);
  if (r.status === 'unknown_host_key') await t.json('POST', `/api/hosts/${h.id}/trust`, { fingerprint: r.fingerprint });
  // Connected once trusted: its facts say it has Docker, where Burrow looks for its own container.
  expect(await t.json<ConnectResult>('POST', `/api/hosts/${h.id}/test`)).toMatchObject({ status: 'ok' });
  // A checkout of a newer Burrow with a breaking change, where Burrow's own container says it runs from.
  const changelog = '# Changelog\n\n## [99.0.0] - 2026-12-01\n\n### Breaking\n\n- The app has a new id.\n\n## [2.0.0] - 2026-09-01\n';
  const out = await sh(
    [
      `rm -rf ${DIR} && mkdir -p ${DIR}/server && cd ${DIR}`,
      `printf '{\\n  "name": "@burrow/server",\\n  "version": "99.0.0"\\n}\\n' > server/package.json`,
      `printf '%s' '${changelog}' > CHANGELOG.md`,
      'git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm "release 99.0.0" && echo ok',
    ].join('\n'),
  );
  expect(out.stdout).toContain('ok');
  const me = selfContainerId();
  vi.spyOn(t.docker, 'recent').mockImplementation(async (hostId) => ({
    hostId,
    at: new Date(t.clock.now).toISOString(),
    error: null,
    containers: hostId === h.id ? [{ id: me ?? 'c0ffee', name: 'burrow', service: 'burrow', project: 'burrow', workingDir: DIR, configFiles: `${DIR}/compose.yaml` }] : [],
  }) as unknown as HostContainers);
  const ntfy = (name: string, topic: string, topics: string[]) => t.json<Channel>('POST', '/api/channels', { kind: 'ntfy', name, enabled: true, topics, lang: 'en', ntfy: { url: 'https://ntfy.example.invalid', topic, openIn: 'browser' } });
  await ntfy('phone', 'phone', ['alerts', 'updates']);
  await ntfy('broken', 'broken', ['alerts']);
});

afterAll(async () => {
  await sh(`rm -rf ${DIR}`).catch(() => {});
  vi.restoreAllMocks();
  await t.close();
});

describe('Burrow tells about itself, as it runs', () => {
  it('a new version found over SSH, a failing channel, an error in its own log: each told once through the channels that work, the channel once more when it works again', async () => {
    // A channel that fails: the notifier keeps it.
    await t.notifier.notify({ topic: 'alerts', title: 'a host is down', body: 'x', page: '/', priority: 4 });
    expect(t.notifier.failing.get('broken')?.error).toContain('401');
    t.ctx.log.error('database is locked');
    got.length = 0;

    const keys = await t.selfWatch.tick();
    expect(keys).toEqual(expect.arrayContaining(['channel:broken', 'errors', 'version:99.0.0']));
    expect(titles('phone')).toEqual(expect.arrayContaining(['Burrow: the notification channel "broken" fails', 'Burrow logged 1 new error', 'Burrow 99.0.0 is available']));
    const version = got.find((g) => g.title === 'Burrow 99.0.0 is available')!;
    expect(version.body).toContain('99.0.0: The app has a new id.');
    expect(got.find((g) => g.title.startsWith('Burrow logged'))!.body).toContain('database is locked');

    // Nothing new: nothing told, also not the version (checked once a day).
    got.length = 0;
    t.advance(HOUR);
    expect(await t.selfWatch.tick()).toEqual([]);
    expect(got).toEqual([]);

    // The channel works again: told once more, through every channel for alerts, itself too.
    brokenFails = false;
    await t.notifier.notify({ topic: 'alerts', title: 'a host is up', body: 'x', page: '/', priority: 2 });
    expect(t.notifier.failing.has('broken')).toBe(false);
    got.length = 0;
    expect(await t.selfWatch.tick()).toEqual(['fine:channel:broken']);
    expect(titles('broken')).toEqual(['Fine again: Burrow: the notification channel "broken" fails']);
  });

  it('a week on: "Burrow runs" on every channel, with its hosts and the last backup; the version not told again', async () => {
    got.length = 0;
    t.advance(7 * 24 * HOUR);
    const keys = await t.selfWatch.tick();
    expect(keys).toEqual(['weekly']);
    expect(titles('phone')).toEqual(['Burrow runs']);
    expect(titles('broken')).toEqual(['Burrow runs']);
    expect(got[0]!.body).toMatch(/1 host\. Last backup: none\./);
  });

  it('the heartbeat calls its address while Burrow runs well, and logs a failing call once', async () => {
    expect(await t.heartbeat.beat()).toBe('sent');
    expect(beats.at(-1)).toBe(BEAT);
    beatFails = true;
    expect(await t.heartbeat.beat()).toBe('failed');
    expect(await t.heartbeat.beat()).toBe('failed');
    const logged = t.logEvents.list().filter((e) => e.example.includes('heartbeat'));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.count).toBe(1);
    beatFails = false;
    expect(await t.heartbeat.beat()).toBe('sent');
  });
});
