import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT_URL } from '@burrow/shared';
import { makeApp, setupAdmin, totpNow, type TestApp } from '../helpers.js';

// The app of Burrow's own release offered in place of an older one (report a5ace5): fetched from the
// release of the version that runs, on an admin's confirmed request, and then offered for download.
const apk = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(4096, 1)]);
const sha = createHash('sha256').update(apk).digest('hex');
const asked: string[] = [];
let t: TestApp;
let version: string;
let secret: string;

beforeAll(async () => {
  t = await makeApp({
    env: { BURROW_DATA_DIR: mkdtempSync(join(tmpdir(), 'burrow-android-')) },
    fetch: async (url: string) => {
      asked.push(url);
      if (url === `${PROJECT_URL}/releases/download/v${version}/burrow.apk.json`) return new Response(JSON.stringify({ versionName: version, versionCode: 99999, sha256: sha }));
      if (url === `${PROJECT_URL}/releases/download/v${version}/burrow.apk`) return new Response(apk);
      return new Response('Not Found', { status: 404 });
    },
  });
  ({ secret } = await setupAdmin(t));
  version = (await t.json<{ server: string }>('GET', '/api/version')).server;
});
afterAll(() => t.close());

describe("the app from Burrow's own release", () => {
  it('none offered, then fetched from the release of this version and offered for download', async () => {
    expect(await t.json('GET', '/api/android')).toEqual({ apk: null });
    await t.json('POST', '/api/auth/step-up/totp', { code: await totpNow(secret, t) });
    const got = await t.json<{ apk: { versionName: string; versionCode: number; sha256: string; size: number } }>('POST', '/api/android/fetch-release');
    expect(got.apk).toEqual({ versionName: version, versionCode: 99999, sha256: sha, size: apk.length });
    expect(asked.filter((u) => u.includes('/releases/download/'))).toEqual([`${PROJECT_URL}/releases/download/v${version}/burrow.apk.json`, `${PROJECT_URL}/releases/download/v${version}/burrow.apk`]);
    expect(await t.json('GET', '/api/android')).toEqual(got);
    const res = await t.request('GET', '/api/android/burrow.apk');
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(apk)).toBe(true);
  });
});
