import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PROJECT_URL, projectPublished } from '@burrow/shared';
import { readCapped, type Fetcher } from '../apps/probe.js';
import { HttpError } from '../http.js';

// The app from the release of the version this Burrow runs (report a5ace5): an update of Burrow
// builds no app, so the one it offered stayed behind. Every release on GitHub carries burrow.apk and
// burrow.apk.json (versionName, versionCode, sha256), made by the same CI job; fetched on an admin's
// request, never by itself. The APK is kept only when it is the version asked for and its SHA-256 is
// the one named; Android then installs it over the app only when it is signed with the same key.

const MAX_BYTES = 200 * 1024 * 1024;

const meta = z.object({
  versionName: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/),
  versionCode: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ReleaseApk = z.infer<typeof meta>;

let running: Promise<ReleaseApk> | null = null;

/** The release's APK into `dir` (burrow.apk and burrow.apk.json, as scripts/apk.sh leaves them); one fetch at a time. */
export function fetchReleaseApk(dir: string, version: string, f: Fetcher, project = PROJECT_URL): Promise<ReleaseApk> {
  running ??= fetchOnce(dir, version, f, project).finally(() => (running = null));
  return running;
}

async function fetchOnce(dir: string, version: string, f: Fetcher, project: string): Promise<ReleaseApk> {
  if (!projectPublished(project)) throw new HttpError(409, 'not_published', 'This Burrow is not built from a published project: there is no release to fetch the app from.');
  const at = `${project}/releases/download/v${encodeURIComponent(version)}`;
  const get = async (name: string, ms: number) => {
    let res: Response;
    try {
      res = await f(`${at}/${name}`, { headers: { 'user-agent': 'Burrow' }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
    } catch (err) {
      throw new HttpError(502, 'release_unreachable', `GitHub could not be reached: ${(err as Error).message}`);
    }
    if (res.status === 404) throw new HttpError(404, 'no_release_apk', `The release ${version} on GitHub has no app (${name}).`);
    if (!res.ok) throw new HttpError(502, 'release_error', `GitHub: HTTP ${res.status} for ${name}`);
    return res;
  };
  const parsed = meta.safeParse(await (await get('burrow.apk.json', 30_000)).json().catch(() => null));
  if (!parsed.success) throw new HttpError(502, 'release_error', "The release's burrow.apk.json does not describe an app.");
  const info = parsed.data;
  if (info.versionName !== version) throw new HttpError(502, 'release_mismatch', `The release ${version} names the app ${info.versionName}.`);
  const body = await readCapped(await get('burrow.apk', 600_000), MAX_BYTES);
  if (!body) throw new HttpError(502, 'release_error', 'The app in the release is larger than an app can be.');
  // An APK is a zip: anything else (an error page) is not offered.
  if (body.subarray(0, 4).toString('latin1') !== 'PK\x03\x04') throw new HttpError(502, 'release_error', 'What the release gave is not an app.');
  const sha = createHash('sha256').update(body).digest('hex');
  if (sha !== info.sha256) throw new HttpError(502, 'release_checksum', 'The app from the release is not the one its burrow.apk.json names (SHA-256 differs).');
  mkdirSync(dir, { recursive: true });
  const apk = join(dir, 'burrow.apk');
  try {
    writeFileSync(`${apk}.new`, body);
    writeFileSync(`${apk}.json.new`, `${JSON.stringify(info)}\n`);
    renameSync(`${apk}.new`, apk);
    renameSync(`${apk}.json.new`, `${apk}.json`);
  } finally {
    rmSync(`${apk}.new`, { force: true });
    rmSync(`${apk}.json.new`, { force: true });
  }
  return info;
}
