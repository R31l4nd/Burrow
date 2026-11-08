import { describe, expect, it } from 'vitest';
import { breakingItems } from './breakingitems.js';

const rel = (name: string, breaking: string[]) => ({ name, flags: { breaking, major: false, security: false, important: false } });

describe('breakingItems', () => {
  it('per image, each warning once with the versions that give it (report 06354e)', () => {
    const rc = 'This is a release candidate, not a stable release.';
    const items = breakingItems([
      { image: 'ghcr.io/immich-app/immich-machine-learning:release-openvino', c: { releases: [rel('v3.3.0-rc.2', [rc]), rel('v3.3.0-rc.1', [rc]), rel('v3.2.0', [])] } },
      { image: 'ghcr.io/immich-app/immich-server:release', c: { releases: [rel('v3.3.0-rc.2', [rc])] } },
      { image: 'nginx:1', c: { releases: [rel('1.2', [])] } },
      { image: 'localhost:5001/burrowtest-app:latest', c: { releases: [rel('v2', ['PORT is now HTTP_PORT'])] } },
    ] as never);
    expect(items).toEqual([
      { title: 'immich-app/immich-machine-learning:release-openvino', lines: [`v3.3.0-rc.2, v3.3.0-rc.1: ${rc}`] },
      { title: 'immich-app/immich-server:release', lines: [`v3.3.0-rc.2: ${rc}`] },
      { title: 'burrowtest-app:latest', lines: ['v2: PORT is now HTTP_PORT'] },
    ]);
  });
});

describe('notes that could not be read (AUDIT2 WEB-09)', () => {
  it('are an item each, said as unknown, not left out', async () => {
    const { unreadItems } = await import('./breakingitems.js');
    expect(unreadItems(['ghcr.io/org/app:1.2', 'nginx:1.27'], 'not read')).toEqual([
      { title: 'org/app:1.2', lines: ['not read'] },
      { title: 'nginx:1.27', lines: ['not read'] },
    ]);
  });
});
