import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppTab } from '@burrow/shared';
import { appFromLabels, appsFromNpmConfs, appsFromSwagConfs, baseDomainOf, parseInspect } from '../../src/apps/discover.js';
import { embeddableFrom, iconLinks, probeApp, readCapped, type Fetcher } from '../../src/apps/probe.js';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

const ORIGIN = 'https://burrow.local.example.com';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('discovery from container labels', () => {
  it('parses docker inspect lines', () => {
    const out = '"/radarr" {"swag":"enable","swag_url":"radarr.local.*"}\n"/db" null\ngarbage\n';
    expect(parseInspect(out)).toEqual([
      { name: 'radarr', labels: { swag: 'enable', swag_url: 'radarr.local.*' } },
      { name: 'db', labels: {} },
    ]);
  });

  it('fills the SWAG wildcard and defaults to the container name', () => {
    expect(appFromLabels({ name: 'radarr', labels: { swag: 'enable', swag_url: 'radarr.local.*' } }, 'example.com')).toMatchObject({
      name: 'Radarr',
      url: 'https://radarr.local.example.com/',
      source: 'swag',
    });
    expect(appFromLabels({ name: 'sonarr', labels: { swag: 'enable' } }, 'example.com')?.url).toBe('https://sonarr.example.com/');
  });

  it('reads Traefik rules, http only on a plain web entrypoint', () => {
    const l = { 'traefik.http.routers.a.rule': 'Host(`a.example.com`) && PathPrefix(`/`)' };
    expect(appFromLabels({ name: 'a', labels: l }, 'x')?.url).toBe('https://a.example.com/');
    expect(appFromLabels({ name: 'a', labels: { ...l, 'traefik.http.routers.a.entrypoints': 'web' } }, 'x')?.url).toBe('http://a.example.com/');
  });

  it('prefers homepage labels, with their name and group', () => {
    const f = appFromLabels(
      { name: 'x', labels: { swag: 'enable', 'homepage.href': 'https://films.example.com', 'homepage.name': 'Films', 'homepage.group': 'Media' } },
      'example.com',
    );
    expect(f).toMatchObject({ name: 'Films', url: 'https://films.example.com/', group: 'Media', source: 'homepage' });
  });

  it('caddy-docker-proxy labels: the first site address, https unless it says http; snippets, global options and bare ports are no app (audit 2026-10-30)', () => {
    expect(appFromLabels({ name: 'radarr', labels: { caddy: 'radarr.example.com', 'caddy.reverse_proxy': '{{upstreams 7878}}' } }, 'x')).toMatchObject({ url: 'https://radarr.example.com/', source: 'caddy', container: 'radarr' });
    expect(appFromLabels({ name: 'wiki', labels: { caddy_0: 'http://wiki.lan, wiki.example.com', 'caddy_0.reverse_proxy': '{{upstreams 80}}' } }, 'x')?.url).toBe('http://wiki.lan/');
    expect(appFromLabels({ name: 'a', labels: { caddy: 'https://a.example.com:8443' } }, 'x')?.url).toBe('https://a.example.com:8443/');
    for (const v of ['(snippet)', '', ':80', '*.example.com']) expect(appFromLabels({ name: 'x', labels: { caddy: v } }, 'x'), v).toBeNull();
  });

  it('ignores containers without a web address', () => {
    expect(appFromLabels({ name: 'db', labels: { 'homepage.href': 'javascript:alert(1)' } }, 'x')).toBeNull();
  });

  it('derives the base domain from the origin', () => {
    expect(baseDomainOf(ORIGIN)).toBe('example.com');
    expect(baseDomainOf('http://localhost:8080')).toBe('localhost');
  });
});

describe('frame check', () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it('follows X-Frame-Options and CSP frame-ancestors', () => {
    expect(embeddableFrom(h({}), ORIGIN)).toBe('yes');
    expect(embeddableFrom(h({ 'x-frame-options': 'DENY' }), ORIGIN)).toBe('no');
    expect(embeddableFrom(h({ 'x-frame-options': 'SAMEORIGIN' }), ORIGIN)).toBe('no');
    expect(embeddableFrom(h({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" }), ORIGIN)).toBe('no');
    expect(embeddableFrom(h({ 'content-security-policy': 'frame-ancestors https://*.example.com' }), ORIGIN)).toBe('yes');
    expect(embeddableFrom(h({ 'content-security-policy': `frame-ancestors ${ORIGIN}`, 'x-frame-options': 'DENY' }), ORIGIN)).toBe('yes');
  });

  it('finds icon links, touch icons first', () => {
    const html = '<link rel="stylesheet" href="a.css"><link rel="icon" href="/fav.png"><link rel="apple-touch-icon" href="touch.png">';
    expect(iconLinks(html, 'https://a.example.com/app/')).toEqual(['https://a.example.com/app/touch.png', 'https://a.example.com/fav.png']);
  });
});

/** A tiny web with two apps: one that may be framed, one that may not. */
const fakeWeb: Fetcher = async (url) => {
  const u = new URL(url);
  if (u.hostname === 'down.example.com') throw new Error('ECONNREFUSED');
  if (u.pathname === '/') {
    const headers: Record<string, string> = { 'content-type': 'text/html' };
    if (u.hostname === 'deny.example.com') headers['x-frame-options'] = 'DENY';
    return new Response('<link rel="icon" href="/icon.png">', { headers });
  }
  if (u.pathname === '/icon.png') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  return new Response('', { status: 404 });
};

describe('probe', () => {
  it('reports frame permission and fetches the icon', async () => {
    expect(await probeApp('https://ok.example.com/', ORIGIN, fakeWeb)).toMatchObject({ embeddable: 'yes', icon: { type: 'image/png' } });
    expect((await probeApp('https://deny.example.com/', ORIGIN, fakeWeb)).embeddable).toBe('no');
    expect(await probeApp('https://down.example.com/', ORIGIN, fakeWeb)).toEqual({ embeddable: 'unknown', icon: null });
  });
});

describe('app routes', () => {
  let t: TestApp;
  afterEach(async () => t.close());

  it('adds apps, lets frameable ones into the CSP and serves icons inertly', async () => {
    t = await makeApp({ fetch: fakeWeb });
    await setupAdmin(t);
    const ok = await t.json<AppTab>('POST', '/api/apps', { name: 'Radarr', url: 'https://ok.example.com/', group: 'Media' });
    expect(ok).toMatchObject({ embeddable: 'yes', hasIcon: true, group: 'Media', pinned: true, up: true, uptime: 1 });
    const deny = await t.json<AppTab>('POST', '/api/apps', { name: 'Sonarr', url: 'https://deny.example.com/' });
    expect(deny.embeddable).toBe('no');

    const csp = (await t.request('GET', '/')).headers['content-security-policy'] as string;
    expect(csp).toContain("frame-src 'self' https://ok.example.com");
    expect(csp).not.toContain('deny.example.com');

    const icon = await t.request('GET', `/api/apps/${ok.id}/icon`);
    expect(icon.headers['content-type']).toBe('image/png');
    expect(icon.headers['content-security-policy']).toContain('sandbox');
    expect(icon.rawPayload.equals(PNG)).toBe(true);

    expect((await t.request('POST', '/api/apps', { name: 'Again', url: 'https://ok.example.com/' })).statusCode).toBe(409);
    expect((await t.request('POST', '/api/apps', { name: 'Bad', url: 'javascript:alert(1)' })).statusCode).toBe(400);

    const order = await t.json<AppTab[]>('POST', '/api/apps/order', { ids: [deny.id, ok.id] });
    expect(order.map((a) => a.name)).toEqual(['Sonarr', 'Radarr']);

    expect((await t.request('DELETE', `/api/apps/${ok.id}`)).statusCode).toBe(204);
    expect((await t.request('GET', '/')).headers['content-security-policy']).not.toContain('ok.example.com');
  });
});

describe('android routes', () => {
  let t: TestApp;
  afterEach(async () => t.close());

  it('offers the APK to signed-in users only', async () => {
    const dir = join(tmpdir(), `burrow-apk-${process.pid}-${Date.now()}`);
    mkdirSync(join(dir, 'downloads'), { recursive: true });
    t = await makeApp({ env: { BURROW_DATA_DIR: dir } });
    expect((await t.request('GET', '/api/android/burrow.apk')).statusCode).toBe(401);
    await setupAdmin(t);
    expect(await t.json('GET', '/api/android')).toEqual({ apk: null });
    writeFileSync(join(dir, 'downloads', 'burrow.apk'), 'PK-apk');
    writeFileSync(join(dir, 'downloads', 'burrow.apk.json'), JSON.stringify({ versionName: '0.5.0', versionCode: 5, sha256: 'ab' }));
    const res = await t.request('GET', '/api/android/burrow.apk');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('burrow-0.5.0.apk');
    expect(res.body).toBe('PK-apk');
  });

  it('publishes asset links only when a certificate is configured', async () => {
    t = await makeApp();
    expect((await t.request('GET', '/.well-known/assetlinks.json')).statusCode).toBe(404);
    await t.close();
    const fp = Array.from({ length: 32 }, () => 'ab').join(':');
    t = await makeApp({ env: { BURROW_ANDROID_CERT_SHA256: fp } });
    const res = await t.request('GET', '/.well-known/assetlinks.json');
    expect(res.json()[0].target).toMatchObject({ package_name: 'io.github.r31l4nd.burrow', sha256_cert_fingerprints: [fp.toUpperCase()] });
  });
});

describe('reading an app\'s reply', () => {
  it('stops at the limit while it comes, without a length too (it was read whole first)', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 200) return c.close();
        c.enqueue(new Uint8Array(64 * 1024));
      },
    });
    expect(await readCapped(new Response(body), 512 * 1024)).toBeNull();
    expect(pulled).toBeLessThan(12);
    expect((await readCapped(new Response('small'), 512 * 1024))?.toString()).toBe('small');
  });
});

describe("SWAG's own proxy confs (report 6d39c6)", () => {
  it('an app proxied by a conf written by hand (swag=disable on its container) is found by its server_name and upstream', () => {
    const out = [
      '@@conf /config/nginx/proxy-confs/dashboard.subdomain.conf',
      '    server_name _;',
      '    server_name dashboard.*;',
      '@@conf /config/nginx/proxy-confs/kameraadschap.subdomain.conf',
      '    server_name kameraadschap.*;',
      '    server_name kameraadschap.*;',
      '        set $upstream_app stemspel;',
      '        set $upstream_app other;',
      '@@conf /config/nginx/proxy-confs/livetrack.subdomain.conf',
      '    server_name _ livetrack.*;',
      '        set $upstream_app livetrack;',
      '@@conf /config/nginx/proxy-confs/odd.subdomain.conf',
      '    server_name $host;',
      '        set $upstream_app odd;',
    ].join('\n');
    expect(appsFromSwagConfs(out, 'example.com')).toEqual([
      { name: 'Kameraadschap', url: 'https://kameraadschap.example.com/', group: null, source: 'swag', container: 'stemspel' },
      { name: 'Livetrack', url: 'https://livetrack.example.com/', group: null, source: 'swag', container: 'livetrack' },
    ]);
  });
  it('nothing read is nothing found', () => {
    expect(appsFromSwagConfs('', 'example.com')).toEqual([]);
  });
});

describe("Nginx Proxy Manager's proxy hosts (audit 2026-10-30)", () => {
  it('an app by its server_name and the container it forwards to; https where it listens with TLS', () => {
    const out = [
      '@@conf /data/nginx/proxy_host/1.conf',
      '  set $server         "radarr";',
      '  listen 80;',
      '  listen 443 ssl;',
      '  server_name radarr.example.com films.example.com;',
      '@@conf /data/nginx/proxy_host/2.conf',
      '  set $server         "wiki";',
      '  listen 80;',
      '  server_name wiki.lan;',
      '@@conf /data/nginx/proxy_host/3.conf',
      '  set $server         "192.168.1.9";',
      '  listen 80;',
      '  server_name nas.lan;',
    ].join('\n');
    expect(appsFromNpmConfs(out)).toEqual([
      { name: 'Radarr', url: 'https://radarr.example.com/', group: null, source: 'npm', container: 'radarr' },
      { name: 'Wiki', url: 'http://wiki.lan/', group: null, source: 'npm', container: 'wiki' },
      { name: 'Nas', url: 'http://nas.lan/', group: null, source: 'npm', container: '192.168.1.9' },
    ]);
    expect(appsFromNpmConfs('')).toEqual([]);
  });
});
