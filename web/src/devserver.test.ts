import { join } from 'node:path';
import { createServer, isFileLoadingAllowed } from 'vite';
import { describe, expect, it } from 'vitest';

// `make dev` serves the checkout under /@fs/ (Vite's allow list is the
// workspace root). The live instance's data may be a folder of the checkout
// (deploy/local: BURROW_DATA=./data/live, report 4b9965), beside the backups
// and the backup key: none of it is served.

const ROOT = join(__dirname, '..', '..');

describe('the dev server', () => {
  it('serves no instance data, backups or secrets of the checkout (report 4b9965)', async () => {
    const server = await createServer({ configFile: join(ROOT, 'web', 'vite.config.ts'), root: join(ROOT, 'web'), logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: false } });
    await server.listen();
    try {
      const get = (path: string) => fetch(new URL(`/@fs${join(ROOT, path)}`, server.resolvedUrls!.local[0]!));
      // A file of the checkout comes (not the page a missing one gets); one in secrets/ (its README, there in every checkout) is refused.
      expect(await (await get('package.json')).text()).toContain('"workspaces"');
      expect((await get('secrets/README.md')).status).toBe(403);
      // Files that need not be there (Vite answers 403 only for a file it finds): by the same rule.
      for (const path of ['data/live/burrow.db', 'data/live/secret.key', 'data/dev/burrow.db', 'backups/burrow-20261013T030000Z.tar.gz.enc', 'secrets/backup_encryption_key']) {
        expect(isFileLoadingAllowed(server.config, join(ROOT, path)), path).toBe(false);
      }
      expect(isFileLoadingAllowed(server.config, join(ROOT, 'web', 'src', 'main.ts'))).toBe(true);
    } finally {
      await server.close();
    }
  }, 30_000);
});
