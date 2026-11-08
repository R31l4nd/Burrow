import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { unused } from '@burrow/shared';
import { parseResources, RESOURCES_COMMAND } from '../../src/docker/resources.js';

describe("a host's images, volumes and networks", () => {
  it('what uses them not read: said, and nothing offered for clean-up (AUDIT2 DO-11)', () => {
    // A stand-in docker whose inspect always fails.
    const dir = mkdtempSync(join(tmpdir(), 'burrow-res-'));
    try {
      writeFileSync(
        join(dir, 'docker'),
        ['#!/bin/sh', 'case "$1 $2" in', '  "image ls") echo \'{"ID":"sha256:aaa","Repository":"nginx","Tag":"1","Size":"10MB"}\' ;;', '  "volume ls") echo \'{"Name":"data","Labels":""}\' ;;', '  "network ls") echo \'{"ID":"n1","Name":"bridge","Labels":""}\' ;;', '  "ps -aq") echo c1 ;;', '  inspect*) exit 1 ;;', 'esac', 'exit 0'].join('\n'),
      );
      chmodSync(join(dir, 'docker'), 0o755);
      const out = execFileSync('sh', ['-c', RESOURCES_COMMAND], { env: { PATH: `${dir}:/usr/bin:/bin` }, encoding: 'utf8' });
      const r = parseResources(1, out, null);
      expect(r.usageUnknown).toBe(true);
      expect(unused(r)).toEqual({ images: [], volumes: [], networks: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
