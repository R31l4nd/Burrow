import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Fetcher } from '../apps/probe.js';
import type { Ctx } from '../context.js';
import { contentDisposition, HttpError } from '../http.js';
import { fetchReleaseApk } from './release.js';

// The Android app: the APK is offered to signed-in users from the data
// directory (downloads/burrow.apk, with burrow.apk.json describing it), and
// the Digital Asset Links file tells Android which signed app belongs to this
// origin (needed only for passkeys inside the app).

interface ApkInfo {
  versionName: string;
  versionCode: number;
  sha256: string;
  size: number;
}

export function registerAndroidRoutes(app: FastifyInstance, ctx: Ctx, version: string, f: Fetcher = fetch): void {
  const dir = join(ctx.config.dataDir, 'downloads');
  const apk = join(dir, 'burrow.apk');

  const info = (): ApkInfo | null => {
    if (!existsSync(apk)) return null;
    try {
      const meta = JSON.parse(readFileSync(`${apk}.json`, 'utf8')) as Omit<ApkInfo, 'size'>;
      return { ...meta, size: statSync(apk).size };
    } catch {
      return { versionName: '?', versionCode: 0, sha256: '', size: statSync(apk).size };
    }
  };

  app.get('/api/android', { config: { auth: 'user' } }, async () => ({ apk: info() }));

  // The app of this Burrow's own release, from GitHub, in place of an older one (report a5ace5): what
  // every phone that updates from here installs, so an admin's, confirmed as the person.
  app.post('/api/android/fetch-release', { config: { stepUp: true } }, async () => {
    await fetchReleaseApk(dir, version, f);
    return { apk: info() };
  });

  app.get('/api/android/burrow.apk', { config: { auth: 'user' } }, async (_req, reply) => {
    const i = info();
    if (!i) throw new HttpError(404, 'not_found', 'No APK has been built for this server yet.');
    reply.header('Content-Type', 'application/vnd.android.package-archive');
    reply.header('Content-Disposition', contentDisposition('attachment', `burrow-${i.versionName}.apk`));
    reply.header('Content-Length', i.size);
    return reply.send(createReadStream(apk));
  });

  app.get('/.well-known/assetlinks.json', { config: { auth: 'public' } }, async (_req, reply) => {
    const prints = ctx.config.androidCertSha256;
    if (!prints.length) throw new HttpError(404, 'not_found');
    reply.header('Cache-Control', 'public, max-age=3600');
    return [
      {
        relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
        target: { namespace: 'android_app', package_name: 'io.github.r31l4nd.burrow', sha256_cert_fingerprints: prints },
      },
    ];
  });
}
