import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
          environment: 'node',
          // Many make a whole app (database, migrations, keys): on a busy machine
          // (other projects' tests beside a gate) more than vitest's 5 s.
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // One sshd, shared state: run files one after another.
          fileParallelism: false,
        },
      },
    ],
  },
});
