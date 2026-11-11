import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchReleaseApk } from '../../src/android/release.js';

// The app from the release of the version Burrow runs (report a5ace5): kept only when it is that
// version and its SHA-256 is the one the release names.
const PROJECT = 'https://github.com/someone/burrow';
const apk = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(1000, 7)]);
const sha = createHash('sha256').update(apk).digest('hex');

function release(files: Record<string, Response | (() => Response)>) {
  const asked: string[] = [];
  const f = async (url: string) => {
    asked.push(url);
    const name = url.slice(url.lastIndexOf('/') + 1);
    const r = files[name];
    return r ? (typeof r === 'function' ? r() : r) : new Response('Not Found', { status: 404 });
  };
  return { f, asked };
}
const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });

describe("the app from Burrow's own release", () => {
  it('fetched from the release of this version, kept with what describes it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-apk-'));
    const { f, asked } = release({ 'burrow.apk.json': json({ versionName: '2.24.0', versionCode: 22400, sha256: sha }), 'burrow.apk': new Response(apk) });
    expect(await fetchReleaseApk(dir, '2.24.0', f, PROJECT)).toEqual({ versionName: '2.24.0', versionCode: 22400, sha256: sha });
    expect(asked).toEqual([`${PROJECT}/releases/download/v2.24.0/burrow.apk.json`, `${PROJECT}/releases/download/v2.24.0/burrow.apk`]);
    expect(readFileSync(join(dir, 'burrow.apk')).equals(apk)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'burrow.apk.json'), 'utf8'))).toEqual({ versionName: '2.24.0', versionCode: 22400, sha256: sha });
  });

  it('not kept when its SHA-256 is not the one named, another version, no app, or no release; what was offered stays', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'burrow-apk-'));
    writeFileSync(join(dir, 'burrow.apk'), 'the app offered before');
    const other = Buffer.concat([apk, Buffer.from('x')]);
    const cases: [Record<string, Response>, string][] = [
      [{ 'burrow.apk.json': json({ versionName: '2.24.0', versionCode: 22400, sha256: sha }), 'burrow.apk': new Response(other) }, 'release_checksum'],
      [{ 'burrow.apk.json': json({ versionName: '2.23.0', versionCode: 22300, sha256: sha }), 'burrow.apk': new Response(apk) }, 'release_mismatch'],
      [{ 'burrow.apk.json': json({ versionName: '2.24.0', versionCode: 22400, sha256: createHash('sha256').update('<html>').digest('hex') }), 'burrow.apk': new Response('<html>') }, 'release_error'],
      [{ 'burrow.apk.json': json({ versionName: '2.24.0' }) }, 'release_error'],
      [{}, 'no_release_apk'],
    ];
    for (const [files, code] of cases) {
      await expect(fetchReleaseApk(dir, '2.24.0', release(files).f, PROJECT)).rejects.toMatchObject({ code });
      expect(readFileSync(join(dir, 'burrow.apk'), 'utf8'), code).toBe('the app offered before');
      expect(existsSync(join(dir, 'burrow.apk.new')), code).toBe(false);
    }
  });

  it('none from a project not published (the placeholder address)', async () => {
    const { f, asked } = release({});
    await expect(fetchReleaseApk(mkdtempSync(join(tmpdir(), 'burrow-apk-')), '2.24.0', f, `https://github.com/${['OWNER', 'burrow'].join('/')}`)).rejects.toMatchObject({ code: 'not_published' });
    expect(asked).toEqual([]);
  });
});
