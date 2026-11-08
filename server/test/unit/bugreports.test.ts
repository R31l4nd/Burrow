import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BugReportInput } from '@burrow/shared';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// A 1x1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const report = (over: Partial<BugReportInput> = {}): BugReportInput => ({
  text: 'The dropdown is off the screen.',
  screenshot: PNG,
  attachments: [],
  context: {
    page: '/hosts/1/stats',
    dialog: null,
    appVersion: '1.0.0',
    userAgent: 'test',
    viewport: { width: 360, height: 780, dpr: 3 },
    terminal: null,
    locale: 'nl',
    theme: 'dark',
    android: false,
    online: true,
    errors: ['TypeError: x is undefined (app.js:1:2)'],
    failedCalls: [{ method: 'GET', path: '/api/hosts/1/stats', status: 502, code: 'ssh_error', at: '2026-09-28T07:00:00Z' }],
  },
  recording: null,
  ...over,
});

let t: TestApp;
let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'burrow-bugs-'));
  t = await makeApp();
  t.ctx.config.dataDir = dir;
  await setupAdmin(t);
});
afterEach(async () => {
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('problem reports', () => {
  it('saves the report, its context and the screenshot in the data directory', async () => {
    const { id } = await t.json<{ id: string }>('POST', '/api/bugreports', report());
    const folder = join(dir, 'bugreports', id);
    expect(readdirSync(folder).sort()).toEqual(['context.json', 'report.md', 'screenshot.png']);
    const md = readFileSync(join(folder, 'report.md'), 'utf8');
    expect(md).toContain('The dropdown is off the screen.');
    expect(md).toContain('GET /api/hosts/1/stats -> 502 ssh_error');
    expect(md).toContain(', in a browser');
    // From a dialog: which one.
    const inDialog = await t.json<{ id: string }>('POST', '/api/bugreports', report({ context: { ...report().context, dialog: 'alert-rule' } }));
    expect(readFileSync(join(dir, 'bugreports', inDialog.id, 'report.md'), 'utf8')).toContain('on /hosts/1/stats, in the dialog "alert-rule".');
    expect(JSON.parse(readFileSync(join(folder, 'context.json'), 'utf8'))).toMatchObject({ id, role: 'admin', page: '/hosts/1/stats' });
    expect(readFileSync(join(folder, 'screenshot.png')).subarray(1, 4).toString()).toBe('PNG');
    // The screenshot said covered or shown on purpose (report 36ee73: a .env readable, ticked by the person, not a fault).
    for (const [shot, said] of [
      [{ covered: 1, shown: true }, '- screenshot.png (files, terminals and logs as they were: ticked by the person, 1 part)'],
      [{ covered: 2, shown: false }, '- screenshot.png (2 parts with files, terminals or logs covered)'],
      [{ covered: 0, shown: false }, '- screenshot.png\n'],
    ] as const) {
      const r = await t.json<{ id: string }>('POST', '/api/bugreports', report({ context: { ...report().context, shot } }));
      expect(readFileSync(join(dir, 'bugreports', r.id, 'report.md'), 'utf8')).toContain(said);
    }
    // From the app: its own version beside the page's (it can be older:
    // reported as "App 1.7.6" while the app was 1.7.4), and the time zone.
    const fromApp = await t.json<{ id: string }>('POST', '/api/bugreports', report({ context: { ...report().context, android: true, androidApp: '1.7.4', timeZone: 'America/New_York -04:00' } }));
    const appMd = readFileSync(join(dir, 'bugreports', fromApp.id, 'report.md'), 'utf8');
    expect(appMd).toContain('Web app 1.0.0, server ');
    expect(appMd).toContain(', Android app 1.7.4');
    expect(appMd).toContain('time zone America/New_York -04:00');
  });

  it('keeps the input recording beside it, and says so', async () => {
    const recording = {
      version: 1 as const,
      withText: false,
      viewport: { width: 360, height: 780 },
      terminal: { compose: false, mode: 'tmux', cols: 40, rows: 20 },
      entries: [
        { t: 10, e: 'keydown', keyCode: 229 },
        { t: 12, e: 'input', inputType: 'insertText', textLength: 1, len: 1 },
        { t: 13, e: 'sent', textLength: 1 },
      ],
    };
    const { id } = await t.json<{ id: string }>('POST', '/api/bugreports', report({ context: { ...report().context, page: '/term/abc' }, recording }));
    const folder = join(dir, 'bugreports', id);
    expect(readdirSync(folder)).toContain('recording.json');
    expect(JSON.parse(readFileSync(join(folder, 'recording.json'), 'utf8'))).toEqual(recording);
    expect(readFileSync(join(folder, 'report.md'), 'utf8')).toContain('3 events in the last 30 seconds, without the text (recording.json; make replay ID=');
    // Too long a text in it: refused whole, nothing half saved.
    const big = { ...recording, withText: true, entries: [{ t: 1, e: 'sent', text: 'x'.repeat(5000) }] };
    expect((await t.request('POST', '/api/bugreports', report({ recording: big }))).statusCode).toBe(400);
  });

  it('refuses a picture that is not what it says', async () => {
    const fake = `data:image/png;base64,${Buffer.from('<svg onload=alert(1)>').toString('base64')}`;
    expect((await t.request('POST', '/api/bugreports', report({ screenshot: fake }))).statusCode).toBe(400);
    expect((await t.request('POST', '/api/bugreports', report({ screenshot: 'data:image/svg+xml;base64,AAAA' }))).statusCode).toBe(400);
  });

  it('takes at most sixty an hour from an admin going over the screens, ten from an operator', async () => {
    const inv = await t.json<{ url: string }>('POST', '/api/invites', { role: 'operator' });
    for (let i = 0; i < 60; i++) expect((await t.request('POST', '/api/bugreports', report({ screenshot: null }))).statusCode).toBe(200);
    const r = await t.request('POST', '/api/bugreports', report({ screenshot: null }));
    expect(r.statusCode).toBe(429);
    expect(r.json().message).toContain('60 reports an hour');
    // An operator: ten, and again after an hour.
    const { eq } = await import('drizzle-orm');
    const { users } = await import('../../src/db/schema.js');
    t.cookie = null;
    const state = await t.json<{ user: { id: number } }>('POST', `/api/invites/${inv.url.split('/').pop()!}/accept`, { username: 'olivia' });
    t.ctx.db.update(users).set({ incomplete: false }).where(eq(users.id, state.user.id)).run();
    for (let i = 0; i < 10; i++) expect((await t.request('POST', '/api/bugreports', report({ screenshot: null }))).statusCode).toBe(200);
    expect((await t.request('POST', '/api/bugreports', report({ screenshot: null }))).statusCode).toBe(429);
    t.advance(3600_000);
    expect((await t.request('POST', '/api/bugreports', report({ screenshot: null }))).statusCode).toBe(200);
  });

  it('is for signed-in people only', async () => {
    expect((await t.request('POST', '/api/bugreports', report(), { cookie: null })).statusCode).toBe(401);
  });

  it('the admin reads them in Burrow: newest first, one whole, its picture, its folder as an archive', async () => {
    const first = await t.json<{ id: string }>('POST', '/api/bugreports', report({ text: 'First one.', screenshot: null }));
    t.advance(2000);
    const second = await t.json<{ id: string }>('POST', '/api/bugreports', report({ text: 'Second one.\nWith a second line.' }));
    const list = await t.json<{ id: string; text: string; pictures: number; recording: boolean; page: string; role: string }[]>('GET', '/api/bugreports');
    expect(list.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(list[0]).toMatchObject({ text: 'Second one.\nWith a second line.', pictures: 1, recording: false, page: '/hosts/1/stats', role: 'admin' });
    const one = await t.json<{ text: string; pictures: string[]; context: { failedCalls: unknown[] }; serverVersion: string }>('GET', `/api/bugreports/${second.id}`);
    expect(one.text).toBe('Second one.\nWith a second line.');
    expect(one.pictures).toEqual(['screenshot.png']);
    expect(one.context.failedCalls).toHaveLength(1);
    expect(one.serverVersion).toMatch(/^\d+\.\d+\.\d+$/);
    // The picture: an image, never sniffed as anything else.
    const pic = await t.request('GET', `/api/bugreports/${second.id}/pictures/screenshot.png`);
    expect(pic.statusCode).toBe(200);
    expect(pic.headers['content-type']).toBe('image/png');
    expect(pic.headers['x-content-type-options']).toBe('nosniff');
    expect(pic.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    // The folder as a .tar.gz: each file under the report's id, whole.
    const arc = await t.request('GET', `/api/bugreports/${second.id}/archive`);
    expect(arc.statusCode).toBe(200);
    expect(arc.headers['content-disposition']).toBe(`attachment; filename="burrow-problem-${second.id}.tar.gz"`);
    const tar = gunzipSync(arc.rawPayload);
    const entries: { name: string; size: number }[] = [];
    for (let at = 0; at + 512 <= tar.length; ) {
      const name = tar.subarray(at, at + 100).toString().replace(/\0.*$/s, '');
      if (!name) break;
      const size = parseInt(tar.subarray(at + 124, at + 136).toString(), 8);
      // The header's checksum as tar checks it.
      const sum = [...tar.subarray(at, at + 512)].reduce((a, b, i) => a + (i >= 148 && i < 156 ? 32 : b), 0);
      expect(parseInt(tar.subarray(at + 148, at + 156).toString(), 8), name).toBe(sum);
      entries.push({ name, size });
      at += 512 + Math.ceil(size / 512) * 512;
    }
    expect(entries.map((e) => e.name)).toEqual([`${second.id}/context.json`, `${second.id}/report.md`, `${second.id}/screenshot.png`]);
    expect(entries[2]!.size).toBe(readFileSync(join(dir, 'bugreports', second.id, 'screenshot.png')).length);
  });

  it('one from before 1.8.0 (its text only in report.md) reads the same', async () => {
    const id = '2026-09-30-10-00-00-a1b2c3';
    const folder = join(dir, 'bugreports', id);
    mkdirSync(folder, { recursive: true });
    const { text: _, ...ctx } = { text: '', ...report().context };
    writeFileSync(join(folder, 'context.json'), JSON.stringify({ id, at: '2026-09-30T10:00:00.000Z', role: 'operator', serverVersion: '1.7.0', ...ctx }));
    writeFileSync(join(folder, 'report.md'), '# Problem report\n\n## What happened\n\nOld text,\ntwo lines.\n\n## Where\n\n- x\n');
    expect((await t.json<{ text: string; role: string }>('GET', `/api/bugreports/${id}`))).toMatchObject({ text: 'Old text,\ntwo lines.', role: 'operator' });
  });

  it('deleted by the admin (in the audit log); nothing outside a report folder is reachable', async () => {
    const { id } = await t.json<{ id: string }>('POST', '/api/bugreports', report());
    for (const bad of ['..', '..%2F..%2Fetc', 'not-an-id', '2026-10-04-12-00-00-zzzzzz', '2026-10-04-12-00-00-abcdef']) {
      expect((await t.request('GET', `/api/bugreports/${bad}`)).statusCode, bad).toBe(404);
      expect((await t.request('DELETE', `/api/bugreports/${bad}`)).statusCode, bad).toBe(404);
    }
    for (const bad of ['context.json', 'report.md', '..%2Fcontext.json', 'screenshot.svg', 'picture-9.png']) {
      expect((await t.request('GET', `/api/bugreports/${id}/pictures/${bad}`)).statusCode, bad).toBe(404);
    }
    expect((await t.request('DELETE', `/api/bugreports/${id}`)).statusCode).toBe(200);
    expect(readdirSync(join(dir, 'bugreports'))).toEqual([]);
    expect((await t.request('GET', `/api/bugreports/${id}`)).statusCode).toBe(404);
    const audit = await t.json<{ action: string; target: string }[]>('GET', '/api/audit');
    expect(audit.find((a) => a.action === 'bugreport.delete')).toMatchObject({ target: id });
  });

  it('open until marked solved, with when and by whom; open again; both in the audit log', async () => {
    const { id } = await t.json<{ id: string }>('POST', '/api/bugreports', report({ screenshot: null }));
    expect((await t.json<{ status: string }[]>('GET', '/api/bugreports'))[0]).toMatchObject({ status: 'open', closedAt: null });
    t.advance(60_000);
    const closed = await t.json<{ status: string; closedAt: string; closedBy: string }>('PUT', `/api/bugreports/${id}/status`, { status: 'closed' });
    expect(closed).toMatchObject({ status: 'closed', closedAt: new Date(t.ctx.now()).toISOString(), closedBy: 'admin' });
    expect((await t.json<{ status: string }[]>('GET', '/api/bugreports'))[0]).toMatchObject({ status: 'closed', closedAt: closed.closedAt });
    expect(await t.json('GET', `/api/bugreports/${id}`)).toMatchObject({ status: 'closed', closedBy: 'admin' });
    expect(await t.json('PUT', `/api/bugreports/${id}/status`, { status: 'open' })).toMatchObject({ status: 'open', closedAt: null, closedBy: null });
    expect((await t.request('PUT', `/api/bugreports/${id}/status`, { status: 'done' })).statusCode).toBe(400);
    expect((await t.request('PUT', '/api/bugreports/2026-10-04-12-00-00-abcdef/status', { status: 'closed' })).statusCode).toBe(404);
    const audit = await t.json<{ action: string; target: string }[]>('GET', '/api/audit');
    expect(audit.filter((a) => a.target === id).map((a) => a.action)).toEqual(expect.arrayContaining(['bugreport.close', 'bugreport.reopen']));
  });

  it('reaches the admins through the channels for problem reports, not the others', async () => {
    const hooks: { url: string; body: string }[] = [];
    const u = await makeApp({ send: { fetch: async (url: string, init?: RequestInit) => (hooks.push({ url, body: String(init?.body) }), new Response('ok')) } });
    u.ctx.config.dataDir = dir;
    await setupAdmin(u);
    await u.json('POST', '/api/channels', { kind: 'webhook', name: 'Problems', enabled: true, topics: ['problems'], lang: 'en', webhook: { url: 'https://hooks.example.com/problems' } });
    await u.json('POST', '/api/channels', { kind: 'webhook', name: 'Reports only', enabled: true, topics: ['reports'], lang: 'en', webhook: { url: 'https://hooks.example.com/reports' } });
    await u.json('POST', '/api/bugreports', report({ text: 'The terminal froze.\nAfter a paste.' }));
    await expect.poll(() => hooks.length).toBe(1);
    expect(hooks[0]!.url).toBe('https://hooks.example.com/problems');
    expect(hooks[0]!.body).toContain('Problem report from admin');
    expect(hooks[0]!.body).toContain('The terminal froze.');
    await u.close();
  });

  it('the admins see how many are still open (W-FUNC-11)', async () => {
    expect((await t.json<{ openReports: number }>('GET', '/api/system/hints')).openReports).toBe(0);
    const a = await t.json<{ id: string }>('POST', '/api/bugreports', report({ text: 'One.' }));
    await t.json('POST', '/api/bugreports', report({ text: 'Two.' }));
    expect((await t.json<{ openReports: number }>('GET', '/api/system/hints')).openReports).toBe(2);
    await t.json('PUT', `/api/bugreports/${a.id}/status`, { status: 'closed' });
    expect((await t.json<{ openReports: number }>('GET', '/api/system/hints')).openReports).toBe(1);
  });

  it('an empty list before the first report', async () => {
    expect(await t.json('GET', '/api/bugreports')).toEqual([]);
  });
});
