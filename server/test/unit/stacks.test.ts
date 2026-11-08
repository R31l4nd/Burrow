import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContainerInfo } from '@burrow/shared';
import { judge, recovered, Updater } from '../../src/docker/autoupdate.js';
import { releaseFlags, type ImageCheck } from '@burrow/shared';
import { BUSY_EXIT, composeArgs, detachScript, followScript, opScript, parseRunningOps, rollbackScript } from '../../src/docker/ops.js';
import { listTags, localDigest, parseChallenge, parseEndpoints, parseImageRef, registryBase, remoteDigest, type FetchFn } from '../../src/docker/registry.js';
import { markSelf, saveStackRow, selfContainerId, stackHistory } from '../../src/docker/stacks.js';
import { decide, DEFAULT_UPDATE_SETTINGS, getUpdateState, inWindow, localImages, nextWindow, parseInspect, setUpdateSettings, setUpdateState } from '../../src/docker/updates.js';

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;

describe('image references', () => {
  it("follows Docker's rules for registry, repository and tag", () => {
    expect(parseImageRef('nginx')).toEqual({ registry: 'docker.io', repo: 'library/nginx', tag: 'latest', digest: null });
    expect(parseImageRef('linuxserver/radarr:5.2')).toMatchObject({ registry: 'docker.io', repo: 'linuxserver/radarr', tag: '5.2' });
    expect(parseImageRef('lscr.io/linuxserver/swag:latest')).toMatchObject({ registry: 'lscr.io', repo: 'linuxserver/swag' });
    expect(parseImageRef('localhost:5001/app')).toMatchObject({ registry: 'localhost:5001', repo: 'app', tag: 'latest' });
    expect(parseImageRef('ghcr.io/a/b/c:v1')).toMatchObject({ registry: 'ghcr.io', repo: 'a/b/c', tag: 'v1' });
    expect(parseImageRef(`nginx@${D1}`)).toMatchObject({ tag: null, digest: D1 });
    expect(parseImageRef(`nginx:1.27@${D1}`)).toMatchObject({ tag: '1.27', digest: D1 });
    expect(parseImageRef('Upper/Case')).toBeNull();
    // A container made from an image id has no name to look up.
    expect(parseImageRef(D1)).toBeNull();
  });

  it('finds the digest an image was pulled with', () => {
    const ref = parseImageRef('nginx:latest')!;
    expect(localDigest(ref, [`docker.io/library/nginx@${D2}`])).toBe(D2);
    expect(localDigest(ref, [`nginx@${D1}`])).toBe(D1);
    expect(localDigest(ref, [`other@${D1}`])).toBeNull();
  });

  it('knows where registries are', () => {
    expect(registryBase('docker.io')).toBe('https://registry-1.docker.io');
    expect(registryBase('localhost:5000')).toBe('http://localhost:5000');
    expect(registryBase('ghcr.io')).toBe('https://ghcr.io');
    expect(registryBase('localhost:5000', parseEndpoints('localhost:5000=http://reg:5000/'))).toBe('http://reg:5000');
  });

  it('reads a bearer challenge', () => {
    expect(parseChallenge('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"')).toEqual({
      realm: 'https://auth.docker.io/token',
      params: { service: 'registry.docker.io', scope: 'repository:library/nginx:pull' },
    });
    expect(parseChallenge('Basic realm="x"')).toBeNull();
  });

  it('asks the registry with a HEAD, getting an anonymous token when asked to', async () => {
    const calls: string[] = [];
    const f: FetchFn = async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}${(init?.headers as Record<string, string> | undefined)?.authorization ? ' +auth' : ''}`);
      if (url.startsWith('https://auth')) return Response.json({ token: 't' });
      if (!(init?.headers as Record<string, string>).authorization)
        return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="reg"' } });
      return new Response(null, { status: 200, headers: { 'docker-content-digest': D2 } });
    };
    expect(await remoteDigest(parseImageRef('nginx')!, { fetch: f })).toBe(D2);
    expect(calls).toEqual([
      'HEAD https://registry-1.docker.io/v2/library/nginx/manifests/latest',
      'GET https://auth.docker.io/token?service=reg&scope=repository%3Alibrary%2Fnginx%3Apull',
      'HEAD https://registry-1.docker.io/v2/library/nginx/manifests/latest +auth',
    ]);
    const limited: FetchFn = async () => new Response(null, { status: 429 });
    await expect(remoteDigest(parseImageRef('nginx')!, { fetch: limited })).rejects.toMatchObject({ rateLimited: true });
  });

  it('asks a token only of the registry or its own auth service, over https, and follows no redirect there (A3-SRV-14)', async () => {
    const asked: string[] = [];
    const registry = (realm: string): FetchFn => async (url, init) => {
      asked.push(url);
      if (url.startsWith('https://lscr.io/')) return new Response(null, { status: 307, headers: { location: url.replace('https://lscr.io/', 'https://ghcr.io/') } });
      if (!(init?.headers as Record<string, string> | undefined)?.authorization && !url.includes('token')) return new Response(null, { status: 401, headers: { 'www-authenticate': `Bearer realm="${realm}",service="x"` } });
      if (url.includes('token')) return Response.json({ token: 't' });
      return new Response(null, { status: 200, headers: { 'docker-content-digest': D2 } });
    };
    // Inside Burrow's networks, another scheme, another domain: never asked.
    for (const realm of ['http://socket-proxy:2375/containers/json', 'https://10.0.0.20/admin', 'file:///etc/passwd', 'https://evil.example/token', 'http://ghcr.io/token']) {
      asked.length = 0;
      await expect(remoteDigest(parseImageRef('ghcr.io/a/b:1')!, { fetch: registry(realm) }), realm).rejects.toThrow(/token service Burrow does not ask/);
      expect(asked, realm).toEqual(['https://ghcr.io/v2/a/b/manifests/1']);
    }
    // lscr.io sends everything to ghcr.io, whose token service is its own.
    asked.length = 0;
    expect(await remoteDigest(parseImageRef('lscr.io/linuxserver/radarr:5')!, { fetch: registry('https://ghcr.io/token') })).toBe(D2);
    expect(asked[0]).toBe('https://lscr.io/v2/linuxserver/radarr/manifests/5');
    expect(asked).toContain('https://ghcr.io/token?service=x&scope=repository%3Alinuxserver%2Fradarr%3Apull');
    // A token service that redirects, or fails, says only that there is no token.
    const redirecting: FetchFn = async (url, init) =>
      url.includes('/token')
        ? new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } })
        : (init?.headers as Record<string, string> | undefined)?.authorization
          ? new Response(null, { status: 200 })
          : new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://ghcr.io/token"' } });
    await expect(remoteDigest(parseImageRef('ghcr.io/a/b:1')!, { fetch: redirecting })).rejects.toThrow(/^the registry gave no token$/);
    // A registry that redirects to plain http elsewhere is not followed.
    const downgrade: FetchFn = async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:2375/v2/' } });
    await expect(remoteDigest(parseImageRef('ghcr.io/a/b:1')!, { fetch: downgrade })).rejects.toThrow(/redirected elsewhere/);
  });

  it('lists every tag, page by page, with one token for all pages', async () => {
    const calls: string[] = [];
    const f: FetchFn = async (url, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      calls.push(`${url}${auth ? ' +auth' : ''}`);
      if (url.startsWith('https://auth')) return Response.json({ token: 't' });
      if (!auth) return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="reg"' } });
      if (url.includes('last=1.25')) return Response.json({ tags: ['1.26', '1.27', 'bad tag'] });
      return Response.json({ tags: ['1.24', '1.25'] }, { headers: { link: '</v2/library/nginx/tags/list?last=1.25&n=1000>; rel="next"' } });
    };
    expect(await listTags(parseImageRef('nginx:1.25')!, { fetch: f })).toEqual(['1.24', '1.25', '1.26', '1.27']);
    expect(calls).toEqual([
      'https://registry-1.docker.io/v2/library/nginx/tags/list?n=1000',
      'https://auth.docker.io/token?service=reg&scope=repository%3Alibrary%2Fnginx%3Apull',
      'https://registry-1.docker.io/v2/library/nginx/tags/list?n=1000 +auth',
      'https://registry-1.docker.io/v2/library/nginx/tags/list?last=1.25&n=1000 +auth',
    ]);
    // A next page somewhere else is not followed.
    const away: FetchFn = async () => Response.json({ tags: ['1'] }, { headers: { link: '<https://evil.example/v2/x>; rel="next"' } });
    expect(await listTags(parseImageRef('nginx:1')!, { fetch: away })).toEqual(['1']);
  });
});

const container = (over: Partial<ContainerInfo>): ContainerInfo => ({
  id: 'c1',
  name: 'web',
  image: 'nginx',
  imageId: 'sha256:aaa',
  state: 'running',
  health: null,
  restarts: 0,
  startedAt: null,
  finishedAt: null,
  exitCode: 0,
  oomKilled: false,
  createdAt: '',
  project: 'p',
  service: 'web',
  configFiles: null,
  workingDir: null,
  ...over,
});

describe('update check', () => {
  it('reads docker image inspect per image', () => {
    const m = parseInspect(
      `@@img nginx\tsha256:aaa\t["nginx@${D1}"]\t{"org.opencontainers.image.version":"1.27"}\n@@img gone\t\n@@img local\tsha256:bbb\t[]\tnull\n`,
    );
    expect(m.get('nginx')).toEqual({ id: 'sha256:aaa', repoDigests: [`nginx@${D1}`], labels: { 'org.opencontainers.image.version': '1.27' } });
    expect(m.has('gone')).toBe(false);
    expect(m.get('local')?.repoDigests).toEqual([]);
  });

  it('an image docker could not inspect is unknown, with why, not one built here (AUDIT2 DO-09)', () => {
    const ins = parseInspect('@@img nginx\t\t@@failed\n');
    const [nginx] = localImages([container({})], ins);
    expect(nginx).toMatchObject({ unread: true, localDigest: null });
    expect(decide(nginx!, D1, null)).toEqual({ status: 'unknown', error: 'docker image inspect failed for it on this host' });
  });

  it('an image missing from the answer (cut off at its size limit, the connection gone halfway) is unknown too, not one built here (audit 2026-11-05)', () => {
    const cut = parseInspect(`@@img nginx\tsha256:aaa\t["nginx@${D1}"]\tnull\n@@img redis\tsha256:bbb\t["redis@${D1}"]\t{"org.opencon`);
    const [nginx, redis, mine] = localImages([container({}), container({ id: 'c2', image: 'redis' }), container({ id: 'c3', image: 'zz-mine' })], cut);
    expect(decide(nginx!, D1, null).status).toBe('current');
    expect(decide(redis!, D1, null).status).toBe('unknown');
    expect(decide(mine!, D1, null).status).toBe('unknown');
  });

  it('decides per image', () => {
    const ins = parseInspect(`@@img nginx\tsha256:aaa\t["nginx@${D1}"]\t{"org.opencontainers.image.source":"https://github.com/nginx/docker-nginx"}\n@@img mine\tsha256:ccc\t[]\tnull\n`);
    const [mine, nginx, pinned] = localImages(
      [container({}), container({ id: 'c2', image: 'mine', imageId: 'sha256:ccc' }), container({ id: 'c3', image: `redis@${D1}` })],
      ins,
    );
    expect(nginx).toMatchObject({ source: 'https://github.com/nginx/docker-nginx', version: null });
    expect(decide(nginx!, D1, null).status).toBe('current');
    expect(decide(nginx!, D2, null).status).toBe('update');
    expect(decide(nginx!, null, 'offline')).toEqual({ status: 'unknown', error: 'offline' });
    expect(decide(mine!, D2, null).status).toBe('local');
    // Two digests for one image (a pull found a new manifest list for it):
    // the tag's digest being either one means current (nginx:alpine was
    // reported as an update right after updating).
    const [both] = localImages([container({})], parseInspect(`@@img nginx\tsha256:aaa\t["nginx@${D1}","nginx@${D2}"]\tnull\n`));
    expect(decide(both!, D2, null).status).toBe('current');
    expect(decide(both!, D1, null).status).toBe('current');
    expect(decide(both!, `sha256:${'3'.repeat(64)}`, null).status).toBe('update');
    expect(decide(pinned!, D2, null).status).toBe('pinned');
    // Pulled already, but the container still runs the old image.
    const [stale] = localImages([container({ imageId: 'sha256:old' })], ins);
    expect(decide(stale!, D1, null).status).toBe('update');
  });

  it('the version is the one that runs: v2 pulled while the container still runs v1 reads as v1, so the notes of v2 count (AUDIT2 DO-06)', () => {
    const ins = parseInspect(`@@img app\tsha256:new\t["app@${D1}"]\t{"org.opencontainers.image.version":"2.0.0"}\n`);
    const [running] = localImages([container({ image: 'app', imageId: 'sha256:old', version: '1.0.0' })], ins);
    expect(running).toMatchObject({ stale: true, version: '1.0.0' });
    // Running the tag's own image: its label, or the container's when the image has none.
    const [fresh] = localImages([container({ image: 'app', imageId: 'sha256:new', version: '2.0.0' })], ins);
    expect(fresh!.version).toBe('2.0.0');
  });

  it('knows the maintenance window, also across midnight and in a time zone', () => {
    const s = { enabled: true, autoUpdate: true, autoLevel: 'major' as const, kind: 'daily' as const, day: 1, cron: null, windowStart: '04:00', windowHours: 1, timeZone: 'Europe/Amsterdam' };
    // 02:30 UTC = 04:30 in Amsterdam (summer time).
    expect(inWindow(Date.UTC(2026, 8, 27, 2, 30), s)).toEqual({ inside: true, day: '2026-09-27' });
    expect(inWindow(Date.UTC(2026, 8, 27, 3, 30), s).inside).toBe(false);
    const late = { ...s, windowStart: '23:30', windowHours: 2, timeZone: 'UTC' };
    expect(inWindow(Date.UTC(2026, 8, 28, 0, 45), late)).toEqual({ inside: true, day: '2026-09-27' });
    expect(new Date(nextWindow(Date.UTC(2026, 8, 27, 10, 0), s)!).toISOString()).toBe('2026-09-28T02:00:00.000Z');
  });

  it('opens the window weekly or by cron, like a report schedule', () => {
    // Weekly on Sunday (2026-09-27 is one) at 04:00 Amsterdam.
    const weekly = { enabled: true, autoUpdate: true, autoLevel: 'major' as const, kind: 'weekly' as const, day: 0, cron: null, windowStart: '04:00', windowHours: 2, timeZone: 'Europe/Amsterdam' };
    expect(inWindow(Date.UTC(2026, 8, 27, 3, 30), weekly)).toEqual({ inside: true, day: '2026-09-27' });
    expect(inWindow(Date.UTC(2026, 8, 28, 2, 30), weekly).inside).toBe(false);
    expect(new Date(nextWindow(Date.UTC(2026, 8, 27, 10, 0), weekly)!).toISOString()).toBe('2026-10-04T02:00:00.000Z');
    // Every six hours: two windows on one day are two windows.
    const cron = { ...weekly, kind: 'cron' as const, cron: '0 */6 * * *', windowHours: 1, timeZone: 'UTC' };
    expect(inWindow(Date.UTC(2026, 8, 27, 6, 20), cron)).toEqual({ inside: true, day: '2026-09-27 06:00' });
    expect(inWindow(Date.UTC(2026, 8, 27, 12, 59), cron)).toEqual({ inside: true, day: '2026-09-27 12:00' });
    expect(inWindow(Date.UTC(2026, 8, 27, 13, 0), cron).inside).toBe(false);
    expect(new Date(nextWindow(Date.UTC(2026, 8, 27, 13, 0), cron)!).toISOString()).toBe('2026-09-27T18:00:00.000Z');
    expect(nextWindow(0, { ...cron, cron: 'not cron' })).toBeNull();
  });
});

describe('after an update', () => {
  it('judges the updated services', () => {
    expect(judge([container({})], ['web'], false)).toEqual({ ok: true });
    expect(judge([container({})], ['web'], true)).toEqual({ ok: true });
    expect(judge([container({ state: 'exited', exitCode: 1 })], ['web'], false)).toEqual({ ok: false, why: 'web: exited (exit code 1)' });
    expect(judge([container({ restarts: 2 })], ['web'], false)).toMatchObject({ ok: false });
    expect(judge([container({ health: 'unhealthy' })], ['web'], false)).toMatchObject({ ok: false });
    expect(judge([container({ health: 'starting' })], ['web'], false)).toBeNull();
    expect(judge([container({ health: 'starting' })], ['web'], true)).toMatchObject({ ok: false });
    expect(judge([], ['web'], false)).toMatchObject({ ok: false, why: 'web: no container' });
  });

  it('judges every replica, and how many there are', () => {
    const one = container({ id: 'c1', name: 'p-web-1' });
    const two = container({ id: 'c2', name: 'p-web-2', state: 'exited', exitCode: 3 });
    expect(judge([one, two], ['web'], false)).toEqual({ ok: false, why: 'web (p-web-2): exited (exit code 3)' });
    expect(judge([one], ['web'], false, new Map([['web', 2]]))).toEqual({ ok: false, why: 'web: 1 of 2 containers' });
    // A first one still starting does not hide a broken later service.
    const db = container({ id: 'c3', name: 'p-db-1', service: 'db', state: 'restarting' });
    expect(judge([container({ health: 'starting' }), db], ['web', 'db'], false)).toMatchObject({ ok: false, why: 'db: restarting' });
  });

  it('calls it recovered only with the previous images running again', () => {
    const old = [container({ imageId: 'sha256:old' })];
    expect(recovered([container({ imageId: 'sha256:old' })], old)).toEqual({ ok: true });
    expect(recovered([container({ imageId: 'sha256:new' })], old)).toMatchObject({ ok: false });
    expect(recovered([container({ imageId: 'sha256:old', state: 'exited' })], old)).toMatchObject({ ok: false });
    expect(recovered([], old)).toMatchObject({ ok: false });
  });

  it('records a rollback that ran but left the new image as failed, not rolled back', async () => {
    const { makeApp, setupAdmin } = await import('../helpers.js');
    const t = await makeApp();
    await setupAdmin(t);
    const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'h', address: '127.0.0.1', username: 'u', authMethod: 'password', password: 'x' });
    let image = 'sha256:old';
    const monitor = { poll: async () => ({ error: null, containers: [container({ project: 'p', imageId: image })] }) };
    // compose up fails after the image changed; the rollback script exits 0 but nothing changes back.
    const scripts: string[] = [];
    const runner = {
      start: (_t: unknown, _k: unknown, job: (ctl: { run(s: string): Promise<number>; say(l: string): void; outcome(o: unknown): void }) => Promise<number>) => ({
        done: job({ run: async (s) => (scripts.push(s), scripts.length === 1 ? ((image = 'sha256:new'), 1) : 0), say: () => {}, outcome: () => {} }),
      }),
    };
    const checker = { list: () => [], check: async () => {} };
    const u = new Updater(t.ctx, monitor as never, runner as never, checker as never, { settleMs: 0, healthWaitMs: 0, pollMs: 1 });
    const op = (await u.update({ kind: 'system' } as never, h.id, 'p', false, ['web'])) as unknown as { done: Promise<number> };
    await op.done;
    expect(scripts).toHaveLength(2);
    expect(stackHistory(t.ctx, h.id, 'p')[0]).toMatchObject({ result: 'failed', detail: expect.stringContaining('the rollback failed too') });
    await t.close();
    // A whole app made and closed: under load (a gate beside other work) more than vitest's 5 s.
  }, 20_000);

  it('a pull that failed (the registry away for a moment) changed nothing: that release is not held back from the next window (review 2026-10-24)', async () => {
    const { makeApp, setupAdmin } = await import('../helpers.js');
    const { getUpdateState } = await import('../../src/docker/updates.js');
    const t = await makeApp();
    await setupAdmin(t);
    const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'h', address: '127.0.0.1', username: 'u', authMethod: 'password', password: 'x' });
    const monitor = { poll: async () => ({ error: null, containers: [container({ project: 'p' })] }) };
    const runner = {
      start: (_t: unknown, _k: unknown, job: (ctl: { run(s: string): Promise<number>; say(l: string): void; outcome(o: unknown): void }) => Promise<number>) => ({
        done: job({ run: async () => 1, say: () => {}, outcome: () => {} }),
      }),
    };
    const checker = { list: () => [{ hostId: h.id, image: 'nginx', status: 'update', localDigest: 'sha256:aaa', remoteDigest: 'sha256:new' }], check: async () => {} };
    const u = new Updater(t.ctx, monitor as never, runner as never, checker as never, { settleMs: 0, healthWaitMs: 0, pollMs: 1 });
    const op = (await u.update({ kind: 'system' } as never, h.id, 'p', true, ['web'])) as unknown as { done: Promise<number> };
    await op.done;
    expect(stackHistory(t.ctx, h.id, 'p')[0]).toMatchObject({ result: 'failed' });
    expect(getUpdateState(t.ctx).rolledBack ?? []).toEqual([]);
    await t.close();
  }, 20_000);
});

describe('rollbacks that are believed', () => {
  async function setup(states: () => ContainerInfo[], upCode: (n: number) => number) {
    const { makeApp, setupAdmin } = await import('../helpers.js');
    const t = await makeApp();
    await setupAdmin(t);
    const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'h', address: '127.0.0.1', username: 'u', authMethod: 'password', password: 'x' });
    const monitor = { poll: async () => ({ error: null, containers: states() }) };
    const scripts: string[] = [];
    const outcomes: unknown[] = [];
    const runner = {
      start: (_t: unknown, _k: unknown, job: (ctl: { run(s: string): Promise<number>; say(l: string): void; outcome(o: unknown): void }) => Promise<number>) => ({
        done: job({ run: async (s) => (scripts.push(s), upCode(scripts.length)), say: () => {}, outcome: (o) => void outcomes.push(o) }),
      }),
    };
    const checker = { list: () => [], check: async () => {} };
    const u = new Updater(t.ctx, monitor as never, runner as never, checker as never, { settleMs: 20, healthWaitMs: 20, pollMs: 1 });
    return { t, h, u, scripts, outcomes };
  }

  it('an update put back and running well again ends as "rolled back", with why, not as "failed" (W-FUNC-10)', async () => {
    let phase: 'old' | 'new' | 'back' = 'old';
    const { t, h, u, outcomes } = await setup(
      () => [container({ project: 'p', imageId: phase === 'new' ? 'sha256:new' : 'sha256:old', health: phase === 'new' ? 'unhealthy' : null })],
      (n) => {
        phase = n === 1 ? 'new' : 'back';
        return 0;
      },
    );
    const op = (await u.update({ kind: 'system' } as never, h.id, 'p', false, ['web'])) as unknown as { done: Promise<number> };
    expect(await op.done).toBe(1);
    expect(stackHistory(t.ctx, h.id, 'p')[0]).toMatchObject({ result: 'rolled_back' });
    expect(outcomes).toEqual([{ kind: 'rolled_back', why: 'web: unhealthy' }]);
    await t.close();
  });

  it('an operation tells how it ended to whoever follows it, also after the end (W-FUNC-10)', async () => {
    const { Op } = await import('../../src/docker/ops.js');
    const op = new Op({ id: 'x', hostId: 1, project: 'p', op: 'update', startedAt: '', exitCode: null });
    const live: unknown[] = [];
    op.listen((m) => void live.push(m));
    op.outcome = { kind: 'rolled_back', why: 'web: unhealthy' };
    op.end(1);
    const late: unknown[] = [];
    op.listen((m) => void late.push(m));
    expect(live).toEqual([{ t: 'exit', code: 1, outcome: { kind: 'rolled_back', why: 'web: unhealthy' } }]);
    expect(late).toEqual(live);
  });

  it("one read of the host that fails while an update is watched does not roll a good update back (gate 2026-10-23: 'the stack cannot be read')", async () => {
    let phase: 'old' | 'new' = 'old';
    let reads = 0;
    const { t, h, u, scripts } = await setup(
      () => {
        // The second read of the new containers fails, as a busy host's docker ps can.
        if (phase === 'new' && ++reads === 2) throw new Error('ssh: channel open failure');
        return [container({ project: 'p', imageId: phase === 'new' ? 'sha256:new' : 'sha256:old' })];
      },
      () => ((phase = 'new'), 0),
    );
    const op = (await u.update({ kind: 'system' } as never, h.id, 'p', false, ['web'])) as unknown as { done: Promise<number> };
    expect(await op.done).toBe(0);
    expect(scripts).toHaveLength(1);
    expect(stackHistory(t.ctx, h.id, 'p')[0]).toMatchObject({ result: 'updated' });
    await t.close();
  });

  it('the old image back but unhealthy is a failed rollback, not "rolled back" (AUDIT2 DO-01)', async () => {
    let phase: 'old' | 'new' | 'back' = 'old';
    const { t, h, u, scripts } = await setup(
      () => [container({ project: 'p', imageId: phase === 'new' ? 'sha256:new' : 'sha256:old', health: phase === 'old' ? null : 'unhealthy' })],
      (n) => {
        phase = n === 1 ? 'new' : 'back';
        return 0;
      },
    );
    const op = (await u.update({ kind: 'system' } as never, h.id, 'p', false, ['web'])) as unknown as { done: Promise<number> };
    await op.done;
    expect(scripts).toHaveLength(2);
    expect(stackHistory(t.ctx, h.id, 'p')[0]).toMatchObject({ result: 'failed', detail: expect.stringContaining('the rollback failed too') });
    await t.close();
  });

  it('a failed up that left one service gone puts that service back too, not only the ones on another image (AUDIT2 DO-02)', async () => {
    let gone = false;
    const web = container({ project: 'p', id: 'c1', name: 'p-web-1', service: 'web', imageId: 'sha256:w' });
    const db = container({ project: 'p', id: 'c2', name: 'p-db-1', service: 'db', imageId: 'sha256:d' });
    const { t, h, u, scripts } = await setup(
      () => (gone ? [web] : [web, db]),
      (n) => {
        if (n === 1) {
          gone = true;
          return 1;
        }
        gone = false;
        return 0;
      },
    );
    const op = (await u.update({ kind: 'system' } as never, h.id, 'p', false, ['web', 'db'])) as unknown as { done: Promise<number> };
    await op.done;
    expect(scripts).toHaveLength(2);
    expect(scripts[1]).toContain('db');
    expect(stackHistory(t.ctx, h.id, 'p')[0]).toMatchObject({ result: 'rolled_back' });
    await t.close();
  });
});

describe('an update across a restart of Burrow', () => {
  async function app() {
    const { makeApp, setupAdmin } = await import('../helpers.js');
    const t = await makeApp();
    await setupAdmin(t);
    const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'h', address: '127.0.0.1', username: 'u', authMethod: 'password', password: 'x' });
    return { t, h };
  }
  const runnerOf = (run: (s: string) => Promise<number>) => ({
    running: () => undefined,
    start: (_t: unknown, _k: unknown, job: (ctl: { run(s: string): Promise<number>; say(l: string): void; outcome(o: unknown): void }) => Promise<number>) => ({ done: job({ run, say: () => {}, outcome: () => {} }).catch(() => 1) }),
  });

  it('a failure while it runs is written down, not left without a history row (AUDIT2 DO-05)', async () => {
    const { t, h } = await app();
    const monitor = { poll: async () => ({ error: null, containers: [container({ project: 'p' })] }) };
    const u = new Updater(t.ctx, monitor as never, runnerOf(async () => { throw new Error('Could not start on the host: no space left'); }) as never, { list: () => [], check: async () => {} } as never, { settleMs: 0, healthWaitMs: 0, pollMs: 1 });
    const op = (await u.update({ kind: 'system' } as never, h.id, 'p', false, ['web'])) as unknown as { done: Promise<number> };
    await op.done;
    expect(stackHistory(t.ctx, h.id, 'p')[0]).toMatchObject({ result: 'failed', detail: expect.stringContaining('no space left') });
    expect(getUpdateState(t.ctx).pending ?? []).toEqual([]);
    await t.close();
  });

  it('one Burrow was in the middle of when it stopped: watched afterwards, and rolled back when not well (AUDIT2 DO-05)', async () => {
    const { t, h } = await app();
    let image = 'sha256:new';
    const monitor = { poll: async () => ({ error: null, containers: [container({ project: 'p', imageId: image, health: image === 'sha256:new' ? 'unhealthy' : null })] }) };
    const scripts: string[] = [];
    let busy = 1;
    const run = async (s: string) => {
      scripts.push(s);
      // The update still runs on the host at first (its lock), then it is done.
      if (s === 'true' && busy-- > 0) throw new Error('Another operation on this stack is still running on the host (x); try again when it is done.');
      if (s.includes('rollback')) image = 'sha256:old';
      return 0;
    };
    setUpdateState(t.ctx, { pending: [{ hostId: h.id, project: 'p', auto: true, services: ['web'], images: [{ image: 'nginx', from: null, to: null }], before: [{ name: 'web', service: 'web', image: 'nginx', imageId: 'sha256:old' }], started: 1 }] });
    const u = new Updater(t.ctx, monitor as never, runnerOf(run) as never, { list: () => [], check: async () => {} } as never, { settleMs: 5, healthWaitMs: 5, pollMs: 1 });
    await u.recover(1);
    await expect.poll(() => stackHistory(t.ctx, h.id, 'p')[0]?.result).toBe('rolled_back');
    expect(scripts.filter((x) => x === 'true')).toHaveLength(2);
    expect(scripts.some((x) => x.includes('docker tag sha256:old nginx'))).toBe(true);
    expect(getUpdateState(t.ctx).pending ?? []).toEqual([]);
    await t.close();
  });

  it('a host that cannot be read right after the restart: the update is taken up later, on a minute of its own (review 2026-10-24)', async () => {
    const { t, h } = await app();
    let down = true;
    const monitor = { poll: async () => (down ? { error: 'connect EHOSTUNREACH', containers: [] } : { error: null, containers: [container({ project: 'p', imageId: 'sha256:new' })] }) };
    const scripts: string[] = [];
    const run = async (s: string) => (scripts.push(s), 0);
    setUpdateState(t.ctx, { pending: [{ hostId: h.id, project: 'p', auto: true, services: ['web'], images: [{ image: 'nginx', from: null, to: null }], before: [{ name: 'web', service: 'web', image: 'nginx', imageId: 'sha256:old' }], started: t.ctx.now() }] });
    const u = new Updater(t.ctx, monitor as never, runnerOf(run) as never, { list: () => [], check: async () => {} } as never, { settleMs: 5, healthWaitMs: 5, pollMs: 1 });
    await u.recover(1);
    expect(scripts).toEqual([]);
    expect(getUpdateState(t.ctx).pending).toHaveLength(1);
    // The host back: the next minute's round takes it up.
    down = false;
    await u.tick();
    await expect.poll(() => stackHistory(t.ctx, h.id, 'p')[0]?.result).toBe('updated');
    expect(getUpdateState(t.ctx).pending ?? []).toEqual([]);
    // An update this Burrow runs itself is never taken up a second time by a later round.
    let release!: () => void;
    const slow = async (sc: string) => (sc.includes('pull') ? await new Promise<number>((r) => (release = () => r(0))) : (scripts.push(sc), 0));
    const u2 = new Updater(t.ctx, monitor as never, runnerOf(slow) as never, { list: () => [], check: async () => {} } as never, { settleMs: 5, healthWaitMs: 5, pollMs: 1 });
    await u2.recover(1);
    const op = (await u2.update({ kind: 'system' } as never, h.id, 'p', false, ['web'])) as unknown as { done: Promise<number> };
    await u2.tick();
    release();
    await op.done;
    await u2.tick();
    await new Promise((w) => setTimeout(w, 100));
    expect(stackHistory(t.ctx, h.id, 'p').filter((r) => r.result === 'updated')).toHaveLength(2);
    await t.close();
  });
});

describe('compose operations', () => {
  const t = { hostId: 1, project: 'media', workingDir: '/srv/media stack', configFiles: ['/srv/media stack/compose.yaml'] };

  it('builds the scripts', () => {
    expect(composeArgs(t)).toBe("-p media -f '/srv/media stack/compose.yaml'");
    const up = opScript(t, 'update', ['web']);
    expect(up).toContain("cd '/srv/media stack' || exit 1");
    // Only the chosen services: a dependency is not recreated with them (AUDIT2 DO-03).
    expect(up).toContain("dc -p media -f '/srv/media stack/compose.yaml' pull web && dc -p media -f '/srv/media stack/compose.yaml' up -d --no-deps web");
    const rb = rollbackScript(t, [{ ref: 'nginx:latest', imageId: 'sha256:aaa', service: 'web' }]);
    expect(rb).toContain('docker tag sha256:aaa nginx:latest || exit 1');
    expect(rb).toContain('up -d --no-deps --pull never web');
  });

  it('an update deploys only the release that was checked: a tag moved since is refused before up (AUDIT2 DO-07)', () => {
    const up = opScript(t, 'update', ['web'], { expect: [{ image: 'nginx:latest', digest: D1 }] });
    expect(up).toMatch(/pull web && \{ docker image inspect .*nginx:latest \| grep -qF/);
    expect(up).toContain(`grep -qF -- @${D1}`);
    expect(up.indexOf('grep -qF')).toBeLessThan(up.indexOf('up -d'));
    expect(up).toContain('moved since it was checked');
  });

  it('an up from a review checks the configuration once more on the host right before it, and stops when it changed (AUDIT2 DO-12)', () => {
    const d = 'a'.repeat(64);
    const up = opScript(t, 'up', [], { reviewed: d });
    expect(up).toContain(`config | sha256sum | cut -d' ' -f1)" = ${d} ]`);
    expect(up.indexOf('sha256sum')).toBeLessThan(up.indexOf(' up -d'));
    expect(up).toContain('exit 4');
    expect(opScript(t, 'up')).not.toContain('sha256sum');
  });

  it('a rollback pins each service to the exact image it ran, also two services that ran different images under one tag (AUDIT2 DO-04)', () => {
    const rb = rollbackScript(t, [
      { ref: 'app:latest', imageId: 'sha256:one', service: 'api' },
      { ref: 'app:latest', imageId: 'sha256:two', service: 'worker' },
      { ref: 'db:16', imageId: 'sha256:db', service: 'db' },
    ]);
    // The two under one tag: each by its image id, in an override for this rollback only.
    expect(rb).toContain('  "api":\n    image: sha256:one');
    expect(rb).toContain('  "worker":\n    image: sha256:two');
    expect(rb).not.toContain('"db":');
    expect(rb).toMatch(/-f "\$o" up -d --no-deps --pull never api worker db/);
    // One tag cannot point at both: it is left; one that ran a single image is put back.
    expect(rb).not.toContain('app:latest || exit 1');
    expect(rb).toContain('docker tag sha256:db db:16 || exit 1');
  });

  it('runs detached and follows until the exit line', () => {
    const d = detachScript('abc', 'echo hi', 'media');
    expect(d).toContain('setsid nohup sh -c "$s"');
    expect(d).toContain('f="$d/media@abc.log"');
    expect(followScript('/tmp/x.log')).toContain("grep -q '^@@burrow-exit '");
    // Followed again after a lost connection: from where it was.
    expect(followScript('/tmp/x.log', 120)).toContain('n=120');
  });

  it('refuses a second job on a stack while the first still runs on the host, also after Burrow restarted (audit BE-14)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'burrow-ops-'));
    const sh = (script: string) => {
      try {
        return { code: 0, out: execFileSync('sh', ['-c', script], { env: { ...process.env, HOME: home, XDG_CACHE_HOME: '' } }).toString() };
      } catch (err) {
        const e = err as { status: number; stdout: Buffer };
        return { code: e.status, out: e.stdout.toString() };
      }
    };
    // The first one runs a while (Burrow knows nothing of it after a restart).
    const first = sh(detachScript('op1-1', 'sleep 2', 'media'));
    expect(first.code).toBe(0);
    const second = sh(detachScript('op2-1', 'echo again', 'media'));
    expect(second.code).toBe(BUSY_EXIT);
    expect(second.out.trim()).toBe(first.out.trim());
    // Another stack is not held up.
    expect(sh(detachScript('op3-1', 'echo other', 'books')).code).toBe(0);
    // Done: the stack is free again.
    await new Promise((w) => setTimeout(w, 2500));
    expect(sh(detachScript('op4-1', 'echo now', 'media')).code).toBe(0);
    // Found again after a restart by its file's name, this one's and an older Burrow's.
    expect(parseRunningOps('/h/.cache/burrow/ops/media-@op5-1.log\t1700000000\t$ pull media-\n/h/.cache/burrow/ops/web--x1.log\t1700000001\t$ up web').map((x) => [x.project, x.op])).toEqual([
      ['media-', 'pull'],
      ['web', 'up'],
    ]);
    // A stack whose name only starts the same ("media-") holds up no other (review 2026-10-24).
    expect(sh(detachScript('op5-1', 'sleep 2', 'media-')).code).toBe(0);
    expect(sh(detachScript('op6-1', 'echo free', 'media')).code).toBe(0);
  });

  it('two starts at the same moment (two host entries for one machine): one runs, the other is refused (AUDIT2 DO-21)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'burrow-ops-'));
    const start = (id: string) =>
      new Promise<number>((resolve) => {
        // All held at the start line until "go": then at once.
        const p = spawn('sh', ['-c', `while [ ! -e "$HOME/go" ]; do :; done\n${detachScript(id, 'sleep 2', 'media')}`], { env: { ...process.env, HOME: home, XDG_CACHE_HOME: '' }, stdio: 'ignore' });
        p.on('exit', (code) => resolve(code ?? -1));
      });
    const all = Array.from({ length: 8 }, (_, i) => start(`op${i}-1`));
    await new Promise((w) => setTimeout(w, 300));
    writeFileSync(join(home, 'go'), '');
    const codes = await Promise.all(all);
    expect(codes.filter((c) => c === 0)).toHaveLength(1);
    expect(codes.filter((c) => c === BUSY_EXIT)).toHaveLength(7);
    await new Promise((w) => setTimeout(w, 2500));
  });

  it('finds the container Burrow runs in', () => {
    const id = 'f'.repeat(64);
    expect(selfContainerId(`1 2 0:1 /var/lib/docker/containers/${id}/hostname /etc/hostname rw`)).toBe(id);
    expect(selfContainerId('1 2 0:1 / / rw')).toBeNull();
  });

  it('marks it in a list, so a page knows before it asks to stop it', () => {
    const c = (id: string) => ({ id, name: id.slice(0, 4) }) as unknown as ContainerInfo;
    const me = 'a'.repeat(64);
    expect(markSelf([c(me), c('b'.repeat(64))], me).map((x) => x.self ?? false)).toEqual([true, false]);
    // Not in a container (Burrow run by hand): nothing marked.
    expect(markSelf([c(me)], null).map((x) => x.self ?? false)).toEqual([false]);
  });
});

describe('changelog', () => {
  it('finds the GitHub repository of an image', async () => {
    const { githubRepo } = await import('../../src/docker/changelog.js');
    expect(githubRepo('https://github.com/linuxserver/docker-radarr')).toEqual({ owner: 'linuxserver', repo: 'docker-radarr' });
    expect(githubRepo('https://github.com/immich-app/immich.git')).toEqual({ owner: 'immich-app', repo: 'immich' });
    expect(githubRepo('https://github.com/a/b/tree/main/docker')).toEqual({ owner: 'a', repo: 'b' });
    expect(githubRepo('https://gitlab.com/a/b')).toBeNull();
    expect(githubRepo(null)).toBeNull();
  });

  it('shows the releases after the version here', async () => {
    const { changelog } = await import('../../src/docker/changelog.js');
    const releases = ['v1.3.0', 'v1.2.1', 'v1.2.0', 'v1.1.0'].map((tag) => ({ tag_name: tag, name: tag, body: `notes ${tag}`, html_url: `https://github.com/o/r/releases/tag/${tag}`, published_at: '2026-09-01T00:00:00Z' }));
    let calls = 0;
    const f: FetchFn = async (url, init) => {
      calls++;
      expect(url).toBe('https://api.github.com/repos/o/r/releases?per_page=100');
      expect((init?.headers as Record<string, string>)['user-agent']).toBe('Burrow');
      return Response.json([{ tag_name: 'v2.0.0-draft', draft: true }, ...releases]);
    };
    const c = await changelog('https://github.com/o/r', '1.2.0', { fetch: f, now: 1 });
    expect(c).toMatchObject({ url: 'https://github.com/o/r/releases', matched: true });
    expect(c.releases.map((r) => r.tag)).toEqual(['v1.3.0', 'v1.2.1']);
    // Unknown version: the latest few; and answered from the cache.
    const u = await changelog('https://github.com/o/r', 'nightly', { fetch: f, now: 2 });
    expect(u.matched).toBe(false);
    expect(u.releases).toHaveLength(4);
    expect(calls).toBe(1);
    await expect(changelog('https://example.com/x', null, { fetch: f })).rejects.toMatchObject({ code: 'no_changelog' });
  });
});

describe('which version runs, and its notes (report 9190c5)', () => {
  it('an image without a version label is read by its *_VERSION variable; "latest" as a label is no version', () => {
    const ins = parseInspect(
      [
        `@@img valkey/valkey:9\tsha256:aaa\t["valkey/valkey@${D1}"]\t{"org.opencontainers.image.source":"https://github.com/valkey-io/valkey"}\t["PATH=/usr/bin","GOSU_VERSION=1.17","VALKEY_VERSION=9.0.6","SECRET=x"]`,
        `@@img qmcgaw/gluetun:latest\tsha256:bbb\t["qmcgaw/gluetun@${D1}"]\t{"org.opencontainers.image.version":"latest"}\tnull`,
        `@@img org/app:latest\tsha256:ccc\t["org/app@${D1}"]\t{"org.opencontainers.image.version":"1.1.1-amd64"}\tnull`,
      ].join('\n'),
    );
    // Only the version variables are kept, never the rest of what an image sets.
    expect(ins.get('valkey/valkey:9')!.env).toEqual(['GOSU_VERSION=1.17', 'VALKEY_VERSION=9.0.6']);
    const list = localImages(
      [container({ image: 'valkey/valkey:9', imageId: 'sha256:aaa' }), container({ id: 'c2', image: 'qmcgaw/gluetun:latest', imageId: 'sha256:bbb' }), container({ id: 'c3', image: 'org/app:latest', imageId: 'sha256:ccc' })],
      ins,
    );
    expect(Object.fromEntries(list.map((l) => [l.image, l.version]))).toEqual({ 'org/app:latest': '1.1.1', 'qmcgaw/gluetun:latest': null, 'valkey/valkey:9': '9.0.6' });
  });

  it('the notes of the line the tag follows; a backport of an older line is no new major version', async () => {
    const { changelog } = await import('../../src/docker/changelog.js');
    // Newest first, as GitHub lists them: an 8.x backport published after 9.0.7.
    const tags = ['8.0.12', '9.0.7', '8.0.11', '9.0.6', '9.0.0', '8.1.4'];
    const f: FetchFn = async () => Response.json(tags.map((tag) => ({ tag_name: tag, name: tag, body: '', html_url: `https://github.com/v/k/releases/tag/${tag}`, published_at: null })));
    const known = await changelog('https://github.com/v/k', '9.0.6', { fetch: f, now: 10, line: [9] });
    expect(known).toMatchObject({ matched: true, version: '9.0.6', breaking: 0 });
    expect(known.releases.map((r) => r.tag)).toEqual(['9.0.7']);
    const unknown = await changelog('https://github.com/v/k', null, { fetch: f, now: 10, line: [9] });
    expect(unknown).toMatchObject({ matched: false, version: null });
    expect(unknown.releases.map((r) => r.tag)).toEqual(['9.0.7', '9.0.6', '9.0.0']);
    expect(unknown.releases.map((r) => r.flags.major)).toEqual([false, false, true]);
  });

  it('pre-releases (GitHub marks them, or the tag says rc, beta, alpha) are left out, unless the version here is one (report 0d33eb)', async () => {
    const { changelog } = await import('../../src/docker/changelog.js');
    // As immich lists them: a release candidate of the next minor, a patch, and one not marked by GitHub.
    const list = [
      { tag: 'v4.0.0', pre: false },
      { tag: 'v4.0.0-rc.1', pre: true },
      { tag: 'v3.4.0-rc.2', pre: true },
      { tag: 'v3.3.6', pre: false },
      { tag: 'v3.4.0-beta1', pre: false },
      { tag: 'v3.3.5', pre: false },
    ];
    const f: FetchFn = async () => Response.json(list.map((r) => ({ tag_name: r.tag, name: r.tag, prerelease: r.pre, body: '', html_url: `https://github.com/i/a/releases/tag/${r.tag}`, published_at: null })));
    const stable = await changelog('https://github.com/i/a', 'v3.3.5', { fetch: f, now: 20 });
    expect(stable.releases.map((r) => r.tag)).toEqual(['v4.0.0', 'v3.3.6']);
    // The new major version is new against 3.3.6, not against its own release candidate.
    expect(stable.releases.map((r) => r.flags.major)).toEqual([true, false]);
    expect(stable.breaking).toBe(1);
    const unknown = await changelog('https://github.com/i/a', null, { fetch: f, now: 20 });
    expect(unknown.releases.map((r) => r.tag)).toEqual(['v4.0.0', 'v3.3.6', 'v3.3.5']);
    // Someone who runs a release candidate follows them: those after it are shown, pre-releases included.
    const rc = await changelog('https://github.com/i/a', 'v3.4.0-rc.2', { fetch: f, now: 20 });
    expect(rc.releases.map((r) => r.tag)).toEqual(['v4.0.0', 'v4.0.0-rc.1']);
  });
});

describe('what runs now (the busy pill)', () => {
  it('lists running operations and an update check with its progress', async () => {
    const { makeApp, setupAdmin } = await import('../helpers.js');
    const t = await makeApp();
    await setupAdmin(t);
    expect(await t.json('GET', '/api/docker/activity')).toEqual({ ops: [], check: null });
    let finish!: (code: number) => void;
    const op = t.ops.start({ hostId: 1, project: 'web', workingDir: null, configFiles: [] }, 'up', () => new Promise<number>((r) => (finish = r)));
    t.updates.checking = true;
    t.updates.progress = { done: 2, total: 5 };
    expect(await t.json('GET', '/api/docker/activity')).toEqual({ ops: [expect.objectContaining({ id: op.info.id, project: 'web', op: 'up' })], check: { done: 2, total: 5 } });
    finish(0);
    await op.done;
    t.updates.checking = false;
    t.updates.progress = null;
    expect(await t.json('GET', '/api/docker/activity')).toEqual({ ops: [], check: null });
    await t.close();
  });
});

describe('images marked as having an update', () => {
  it('are checked again, and only those', async () => {
    const { makeApp, setupAdmin } = await import('../helpers.js');
    const { imageChecks } = await import('../../src/db/schema.js');
    const t = await makeApp();
    await setupAdmin(t);
    const h1 = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'a', address: 'a.lan' });
    const h2 = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'b', address: 'b.lan' });
    const now = Date.now();
    const row = { status: 'current' as const, localDigest: D1, remoteDigest: D1, error: null, source: null, version: null, checkedAt: now };
    t.ctx.db.insert(imageChecks).values([{ hostId: h1.id, image: 'a', ...row }, { hostId: h1.id, image: 'b', ...row, status: 'update', remoteDigest: D2 }, { hostId: h2.id, image: 'c', ...row, status: 'update', remoteDigest: D2 }]).run();
    const asked: [number[], string[] | undefined][] = [];
    t.updates.check = async (hostIds: number[], only?: string[]) => void asked.push([hostIds, only]);
    await t.updates.recheckFlagged();
    expect(asked).toEqual([
      [[h1.id], ['b']],
      [[h2.id], ['c']],
    ]);
    await t.close();
  });
});

describe('an image no container uses any more', () => {
  it('goes from the list in a check of only some images too: it was still counted as an update (report 5f9ff3)', async () => {
    const { makeApp, setupAdmin } = await import('../helpers.js');
    const { imageChecks } = await import('../../src/db/schema.js');
    const t = await makeApp();
    await setupAdmin(t);
    const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'nas', address: 'nas.lan' });
    const row = { status: 'update' as const, localDigest: D1, remoteDigest: D2, error: null, source: null, version: null, checkedAt: Date.now() };
    t.ctx.db.insert(imageChecks).values([{ hostId: h.id, image: 'axllent/mailpit:latest', ...row }, { hostId: h.id, image: 'redis:7', ...row, status: 'current' }]).run();
    // The host runs nothing with that image now (its container was removed).
    (t.updates as unknown as { readHost: (id: number) => Promise<{ containers: ContainerInfo[]; error: string | null }> }).readHost = async () => ({ containers: [], error: null });
    await t.updates.check([h.id], ['axllent/mailpit:latest']);
    expect(t.updates.list(h.id).map((c) => c.image)).toEqual(['redis:7']);
    await t.close();
  });
});

describe('a check asked for while another runs', () => {
  it('runs after it, not skipped: an update just made is checked again (report 25f8d5)', async () => {
    const { makeApp, setupAdmin } = await import('../helpers.js');
    const t = await makeApp();
    await setupAdmin(t);
    const read: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (t.updates as unknown as { readHost: (id: number) => Promise<{ containers: ContainerInfo[]; error: string | null }> }).readHost = async (id) => {
      read.push(id);
      await gate;
      return { containers: [], error: null };
    };
    const first = t.updates.check([1]);
    const second = t.updates.check([2], ['web:latest']);
    release();
    await Promise.all([first, second]);
    expect(read).toEqual([1, 2]);
    await t.close();
  });
});

describe('telling about updates', () => {
  it('tells each new update once, on the updates topic', async () => {
    const { makeApp, setupAdmin } = await import('../helpers.js');
    const { imageChecks } = await import('../../src/db/schema.js');
    const t = await makeApp();
    await setupAdmin(t);
    const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'nas', address: 'nas.lan' });
    const sent: { topic: string; title: string; body: string; nl?: { title: string } }[] = [];
    t.updater.notifier = { notify: async (n: (typeof sent)[number]) => void sent.push(n) } as unknown as typeof t.updater.notifier;
    const row = { status: 'update' as const, localDigest: D1, remoteDigest: D2, error: null, source: null, version: null, checkedAt: Date.now() };
    t.ctx.db.insert(imageChecks).values([{ hostId: h.id, image: 'nginx:alpine', ...row }, { hostId: h.id, image: 'redis:7', ...row }]).run();
    t.updater.tellNew();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ topic: 'updates', title: '2 image updates available', nl: { title: '2 image-updates beschikbaar' } });
    expect(sent[0]!.body).toContain('nginx:alpine (nas)');
    // Nothing new: nothing sent.
    t.updater.tellNew();
    expect(sent).toHaveLength(1);
    // A newer image for one of them: told again, only that one.
    t.ctx.db.insert(imageChecks).values({ hostId: h.id, image: 'postgres:16', ...row }).run();
    t.updater.tellNew();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ title: '1 image update available', body: 'postgres:16 (nas)' });
    await t.close();
  });
});

describe('the maintenance window', () => {
  async function windowWith(level: 'major' | 'minor' | 'patch', releases: string[], manualWorker = false, otherRow = false) {
    const { makeApp, setupAdmin } = await import('../helpers.js');
    const { setFacts } = await import('../../src/hosts/service.js');
    const t = await makeApp();
    await setupAdmin(t);
    const h = await t.json<{ id: number }>('POST', '/api/hosts', { name: 'h', address: '127.0.0.1', username: 'u', authMethod: 'password', password: 'x' });
    setFacts(t.ctx, h.id, { hasDocker: true } as never);
    saveStackRow(t.ctx, h.id, 'p', { autoUpdate: true });
    setUpdateSettings(t.ctx, { ...DEFAULT_UPDATE_SETTINGS, autoLevel: level });
    const containers = [container({ id: 'a', name: 'p-web-1', project: 'p', service: 'web', image: 'img:1' }), container({ id: 'b', name: 'p-worker-1', project: 'p', service: 'worker', image: 'img:1', updateManual: manualWorker })];
    const check = { hostId: h.id, image: 'img:1', status: 'update', localDigest: null, remoteDigest: null, error: null, source: 'https://github.com/o/r', version: '1.2.3', newerTag: null, checkedAt: '' } as ImageCheck;
    const monitor = { poll: async () => ({ error: null, containers }) };
    const checker = { list: () => [check], check: async () => {} };
    const u = new Updater(t.ctx, monitor as never, { start: () => ({}) } as never, checker as never);
    const sent: string[] = [];
    u.notifier = { notify: async (n: { title: string; body: string }) => void sent.push(`${n.title}: ${n.body}`) } as never;
    u.notes = async () => ({ url: 'https://github.com/o/r/releases', matched: true, breaking: 0, releases: releases.map((tag) => ({ tag, name: tag, publishedAt: null, body: 'fixes', url: '', flags: releaseFlags('fixes', tag, '1.2.3') })) });
    const updated: string[][] = [];
    u.update = (async (_a: unknown, _h: number, _p: string, _auto: boolean, only?: string[]) => (updated.push(only ?? []), { done: Promise.resolve(0) })) as never;
    // Another stack's update, written before (or meanwhile): not this one's result.
    if (otherRow) {
      const { stackUpdates } = await import('../../src/db/schema.js');
      t.ctx.db.insert(stackUpdates).values({ hostId: h.id, project: 'other', auto: false, result: 'updated', images: '[]', detail: null, startedAt: t.ctx.now(), finishedAt: t.ctx.now() }).run();
    }
    const done = await u.runWindow();
    await t.close();
    return { updated, sent, done };
  }

  it("says this stack's own update, none when it wrote none: not the newest row of another (review 2026-10-24)", async () => {
    const r = await windowWith('major', ['1.3.0'], false, true);
    expect(r.updated).toHaveLength(1);
    expect(r.done).toEqual([]);
  });

  it('updates by itself only up to the step allowed; a bigger one waits and says so', async () => {
    expect((await windowWith('minor', ['1.3.0'])).updated).toEqual([['web', 'worker']]);
    const held = await windowWith('patch', ['1.3.0']);
    expect(held.updated).toEqual([]);
    expect(held.sent).toEqual([expect.stringContaining('p: update waits for you: The update is a minor version')]);
    // Every version: as before.
    expect((await windowWith('major', ['1.3.0'])).updated).toHaveLength(1);
  });

  it('burrow.update=manual: that service is checked, never updated by itself', async () => {
    expect((await windowWith('major', ['1.2.4'], true)).updated).toEqual([['web']]);
  });
});

describe('a review of the compose configuration', () => {
  it('is no review when cut off at the size limit: no digest of the first part only (AUDIT2 DO-13)', async () => {
    const { composeCheckOf } = await import('../../src/docker/manage.js');
    expect(composeCheckOf({ code: 0, stdout: 'services:\n  web: {}\n', stderr: '' })).toMatchObject({ ok: true, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(composeCheckOf({ code: 0, stdout: 'services:\n  web: {}\n', stderr: '', truncated: true })).toMatchObject({ ok: false, digest: null, output: expect.stringContaining('cannot be reviewed') });
    expect(composeCheckOf({ code: 1, stdout: '', stderr: 'bad' })).toMatchObject({ ok: false, digest: null, output: 'bad' });
  });
});

describe('what a deploy would recreate (W-FUNC-04)', () => {
  it("compose's hashes against the running containers' labels: differs, missing, or nothing", async () => {
    const { driftOf } = await import('../../src/docker/manage.js');
    expect(driftOf('H app aaa\nH db bbb\nH new ccc\nR app aaa\nR db old\n')).toEqual([
      { service: 'db', why: 'differs' },
      { service: 'new', why: 'missing' },
    ]);
    expect(driftOf('H app aaa\nR app aaa\nR app aaa\n')).toEqual([]);
    // Two replicas, one of them still on the old configuration.
    expect(driftOf('H app aaa\nR app aaa\nR app old\n')).toEqual([{ service: 'app', why: 'differs' }]);
    // A container left by `compose run` (one-off) is no replica of the service (review 2026-10-24).
    expect(driftOf('H app aaa\nR app aaa False\nR app old True\n')).toEqual([]);
    // No hashes (an old compose, a failure): not known, not "nothing".
    expect(driftOf('R app aaa\n')).toBeUndefined();
  });
});

describe('putting a deployment back (decision 11)', () => {
  it("the compose file as last deployed in the stack's own file for the moment of up, the person's back after; each tag back on its image, pinned by id only where one tag ran as two images", async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { deployRollbackScript } = await import('../../src/docker/autoupdate.js');
    const dir = mkdtempSync(join(tmpdir(), 'burrow-dr-'));
    const file = join(dir, 'compose.yaml');
    writeFileSync(file, 'services:\n  web:\n    image: nginx:2\n', { mode: 0o640 });
    const ino = statSync(file).ino;
    // docker and docker compose as stand-ins that write down what they were asked, and what the file said then.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\nif [ "$1" = compose ] && [ "$2" = version ]; then exit 0; fi\necho "docker $*" >> ${dir}/calls\n[ "$1" = compose ] && cat ${file} >> ${dir}/calls\nexit 0\n`, { mode: 0o755 });
    const t = { hostId: 1, project: 'shop', workingDir: dir, configFiles: [file] };
    const script = deployRollbackScript(t, [{ path: file, content: 'services:\n  web:\n    image: nginx:1\n' }], [{ service: 'web', ref: 'nginx:1', imageId: 'sha256:old' }], ['shop-extra-1']);
    execFileSync('sh', ['-c', script], { env: { PATH: `${bin}:/usr/bin:/bin` } });
    const calls = readFileSync(join(dir, 'calls'), 'utf8');
    expect(calls).toContain('docker tag sha256:old nginx:1');
    expect(calls).toContain('docker rm -f shop-extra-1');
    expect(calls).toMatch(new RegExp(`docker compose --ansi never -p shop -f ${file.replace(/[/.]/g, '\\$&')} up -d --no-deps --pull never web\\nservices:\\n  web:\\n    image: nginx:1`));
    // The person's file is theirs again: same content, same file.
    expect(readFileSync(file, 'utf8')).toBe('services:\n  web:\n    image: nginx:2\n');
    expect(statSync(file).ino).toBe(ino);
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(execFileSync('ls', ['-A', dir]).toString()).not.toContain('.burrow-yours');
    const two = deployRollbackScript(t, [{ path: file, content: 'x' }], [{ service: 'a', ref: 'app:1', imageId: 'sha256:1' }, { service: 'b', ref: 'app:1', imageId: 'sha256:2' }], []);
    expect(two).toContain('image: sha256:2');
    expect(two).toContain(' -f "$o" up -d');
    expect(two).not.toContain('docker tag');
  });

  it('its .env and its other compose files as deployed too, for the moment of up; each person\'s own back after (review 2026-10-24)', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { deployRollbackScript } = await import('../../src/docker/autoupdate.js');
    const dir = mkdtempSync(join(tmpdir(), 'burrow-dr-'));
    const file = join(dir, 'compose.yaml');
    const env = join(dir, '.env');
    writeFileSync(file, 'services:\n  web:\n    image: nginx:${TAG}\n');
    writeFileSync(env, 'TAG=2\n');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // What compose would read at up: the .env and the file as they are then.
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\nif [ "$1" = compose ] && [ "$2" = version ]; then exit 0; fi\n[ "$1" = compose ] && cat ${env} >> ${dir}/calls\nexit 0\n`, { mode: 0o755 });
    const t = { hostId: 1, project: 'shop', workingDir: dir, configFiles: [file] };
    const script = deployRollbackScript(t, [{ path: file, content: 'services:\n  web:\n    image: nginx:${TAG}\n' }, { path: env, content: 'TAG=1\n' }], [{ service: 'web', ref: 'nginx:1', imageId: 'sha256:old' }], []);
    execFileSync('sh', ['-c', script], { env: { PATH: `${bin}:/usr/bin:/bin` } });
    expect(readFileSync(join(dir, 'calls'), 'utf8')).toBe('TAG=1\n');
    expect(readFileSync(env, 'utf8')).toBe('TAG=2\n');
    expect(execFileSync('ls', ['-A', dir]).toString()).not.toContain('.burrow-yours');
    // A .env removed since: there for the moment of up, gone again after.
    const { rmSync, existsSync } = await import('node:fs');
    rmSync(env);
    execFileSync('sh', ['-c', script], { env: { PATH: `${bin}:/usr/bin:/bin` } });
    expect(readFileSync(join(dir, 'calls'), 'utf8')).toBe('TAG=1\nTAG=1\n');
    expect(existsSync(env)).toBe(false);
  });
});
