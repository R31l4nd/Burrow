import { releaseFlags, type Changelog, type ContainerInfo, type ImageCheck } from '@burrow/shared';
import { describe, expect, it } from 'vitest';
import { Updater } from '../../src/docker/autoupdate.js';
import type { Ctx } from '../../src/context.js';
import type { DockerMonitor } from '../../src/docker/monitor.js';
import type { OpRunner } from '../../src/docker/ops.js';
import type { UpdateChecker } from '../../src/docker/updates.js';

// Automatic updates stop for a person when the release notes in between
// announce a breaking change (or a new major version).

const check = (image: string, version: string): ImageCheck => ({ image, status: 'update', source: `https://github.com/o/${image}`, version }) as unknown as ImageCheck;
const release = (tag: string, body: string, previous: string) => ({ tag, name: tag, publishedAt: null, body, url: '', flags: releaseFlags(body, tag, previous) });

function updater(checks: ImageCheck[], notes: Record<string, Changelog | Error>): Updater {
  const u = new Updater({} as Ctx, {} as DockerMonitor, {} as OpRunner, { list: () => checks } as unknown as UpdateChecker);
  u.notes = async (source) => {
    const n = notes[source!.split('/').pop()!];
    if (!n || n instanceof Error) throw n ?? new Error('none');
    return n;
  };
  return u;
}

describe('a breaking change holds an automatic update', () => {
  const containers = [{ image: 'app' }, { image: 'db' }, { image: 'web' }] as ContainerInfo[];

  it('names the releases that need a read, and nothing for plain ones or unreadable notes', async () => {
    const u = updater([check('app', '1.9.0'), check('db', '2.0.0'), check('web', '1.0.0')], {
      app: { url: '', matched: true, breaking: 1, releases: [release('2.0.0', 'All new.', '1.9.0'), release('1.9.1', '- Fixes', '1.9.0')] },
      db: { url: '', matched: true, breaking: 0, releases: [release('2.0.1', '- Faster', '2.0.0')] },
      web: new Error('rate limited'),
    });
    expect(await u.breakingIn(1, containers)).toEqual(['app 2.0.0']);
  });

  it('holds nothing when no image of the stack has an update', async () => {
    const u = updater([check('other', '1.0.0')], {});
    expect(await u.breakingIn(1, containers)).toEqual([]);
  });
});

describe('a held update, read and released', () => {
  it('goes by itself for exactly the releases that were read; a new one holds again', async () => {
    const { makeApp } = await import('../helpers.js');
    const t = await makeApp();
    try {
      const u = t.updater;
      expect(u.isReleased(1, 'app', ['app 2.0.0'])).toBe(false);
      u.release(1, 'app', ['app 2.0.0']);
      expect(u.isReleased(1, 'app', ['app 2.0.0'])).toBe(true);
      // Another stack, or another breaking release since: not released.
      expect(u.isReleased(1, 'other', ['app 2.0.0'])).toBe(false);
      expect(u.isReleased(1, 'app', ['app 2.0.0', 'app 3.0.0'])).toBe(false);
      // A new release replaces the stack's old one.
      u.release(1, 'app', ['app 3.0.0', 'app 2.0.0']);
      expect(u.isReleased(1, 'app', ['app 2.0.0', 'app 3.0.0'])).toBe(true);
      expect(u.isReleased(1, 'app', ['app 2.0.0'])).toBe(false);
    } finally {
      await t.close();
    }
  });
});
