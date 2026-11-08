import { describe, expect, it } from 'vitest';
import { pruneInput, unused, type DockerResources } from './resources.js';

// Removing unused images, volumes and networks: what counts as unused, and
// what a prune request may name (it reaches `docker ... rm` on the host).

const res = (over: Partial<DockerResources> = {}): DockerResources =>
  ({
    images: [
      { id: `sha256:${'a'.repeat(64)}`, usedBy: ['web'] },
      { id: `sha256:${'b'.repeat(64)}`, usedBy: [] },
    ],
    volumes: [
      { name: 'web_data', project: 'web', usedBy: ['web'] },
      { name: 'old_cache', project: null, usedBy: [] },
      { name: 'burrow_data', project: 'burrow', usedBy: [] },
    ],
    networks: [
      { id: 'n1', name: 'bridge', builtin: true, usedBy: [] },
      { id: 'n2', name: 'oldnet', builtin: false, usedBy: [] },
      { id: 'n3', name: 'burrow_default', builtin: false, usedBy: [] },
      { id: 'n4', name: 'web_default', builtin: false, usedBy: ['web'] },
    ],
    selfProject: 'burrow',
    ...over,
  }) as unknown as DockerResources;

describe('unused', () => {
  it("is what nothing uses, never Burrow's own volumes and networks, never Docker's own networks", () => {
    const u = unused(res());
    expect(u.images.map((i) => i.id)).toEqual([`sha256:${'b'.repeat(64)}`]);
    expect(u.volumes.map((v) => v.name)).toEqual(['old_cache']);
    expect(u.networks.map((n) => n.name)).toEqual(['oldnet']);
  });

  it('without knowing which project is Burrow, only what nothing uses', () => {
    const u = unused(res({ selfProject: null }));
    expect(u.volumes.map((v) => v.name)).toEqual(['old_cache', 'burrow_data']);
    expect(u.networks.map((n) => n.name)).toEqual(['oldnet', 'burrow_default']);
  });

  it('is nothing at all when what uses them could not be read (AUDIT2 DO-11)', () => {
    expect(unused(res({ usageUnknown: true }))).toEqual({ images: [], volumes: [], networks: [] });
  });
});

describe('prune input', () => {
  it('names images by digest, volumes by a plain name and networks by id: nothing that reads as an option or a path', () => {
    expect(pruneInput.parse({})).toEqual({ images: [], volumes: [], networks: [] });
    expect(pruneInput.safeParse({ images: [`sha256:${'c'.repeat(64)}`], volumes: ['old_cache', 'a.b-c'], networks: ['0123456789ab'] }).success).toBe(true);
    for (const bad of [{ images: ['nginx:latest'] }, { images: ['--all'] }, { volumes: ['-f'] }, { volumes: ['../etc'] }, { volumes: ['a b'] }, { networks: ['oldnet'] }, { networks: ['--filter'] }]) {
      expect(pruneInput.safeParse(bad).success).toBe(false);
    }
  });
});
