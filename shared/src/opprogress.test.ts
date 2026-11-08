import { describe, expect, it } from 'vitest';
import { opProgress } from './opprogress.js';

// What `docker compose --ansi never` prints while it pulls and starts.
const PULL = `$ update burrowtest
 web Pulling
 db Pulling
 4f4fb700ef54 Pulling fs layer
 a1b2c3d4e5f6 Pulling fs layer
 4f4fb700ef54 Downloading [==>                    ]  1.5MB/30MB
 a1b2c3d4e5f6 Downloading [=====>                 ]  500kB/2MB
 db Skipped - Image is already present locally
`;

describe('operation progress', () => {
  it('reads images, their bytes and the containers', () => {
    const p = opProgress(PULL);
    expect(p.images).toEqual([
      { name: 'web', state: 'busy' },
      { name: 'db', state: 'done' },
    ]);
    expect(p.bytes).toEqual({ done: 2_000_000, total: 32_000_000 });
    expect(p.containers).toEqual([]);

    const later = opProgress(
      `${PULL} 4f4fb700ef54 Download complete
 a1b2c3d4e5f6 Pull complete
 web Pulled
 Network burrowtest_default  Creating
 Network burrowtest_default  Created
 Container burrowtest-db-1  Running
 Container burrowtest-web-1  Recreate
 Container burrowtest-web-1  Recreated
 Container burrowtest-web-1  Starting
`,
    );
    expect(later.images.every((i) => i.state === 'done')).toBe(true);
    expect(later.bytes).toEqual({ done: 32_000_000, total: 32_000_000 });
    expect(later.containers).toEqual([
      { name: 'network burrowtest_default', state: 'done' },
      { name: 'burrowtest-db-1', state: 'done' },
      { name: 'burrowtest-web-1', state: 'busy' },
    ]);
  });

  it('reads the newer format too (images by name, no layer totals)', () => {
    const p = opProgress(` Image busybox:1.36.0 Pulling
 Image alpine:3.19.4 Pulling
 a7cd7d9a2144 Pulling fs layer 0B
 a7cd7d9a2144 Downloading 48.51kB
 a7cd7d9a2144 Download complete 0B
 Image busybox:1.36.0 Pulled
 Network p_default Creating
 Network p_default Created
 Container p-a-1 Creating
 Container p-a-1 Started
`);
    expect(p.images).toEqual([
      { name: 'busybox:1.36.0', state: 'done' },
      { name: 'alpine:3.19.4', state: 'busy' },
    ]);
    expect(p.bytes).toEqual({ done: 48_510, total: null });
    expect(p.containers).toEqual([
      { name: 'network p_default', state: 'done' },
      { name: 'p-a-1', state: 'done' },
    ]);
  });

  it('marks what failed', () => {
    const p = opProgress(' web Error manifest unknown\n Container x-web-1  Error response from daemon: boom\n');
    expect(p.images).toEqual([{ name: 'web', state: 'failed' }]);
    expect(p.containers).toEqual([{ name: 'x-web-1', state: 'failed' }]);
  });

  it('says nothing about output it does not know', () => {
    expect(opProgress('Removing network\nsomething else\n')).toEqual({ images: [], bytes: null, containers: [] });
  });
});
