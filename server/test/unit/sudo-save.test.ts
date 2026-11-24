import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SUDO_SAVE } from '../../src/workspace/sudo.js';

// The root save's script, run here as this user (no sudo): what it does with the path it is given.

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (staged: string, path: string, target: string) => spawnSync('sh', ['-c', SUDO_SAVE, '_', staged, path, 'abcd', target], { encoding: 'utf8' });

describe('the root save', () => {
  it('writes the file the path led to when the save began', () => {
    dir = mkdtempSync(join(tmpdir(), 'burrow-sudo-'));
    writeFileSync(join(dir, 'staged'), 'new\n');
    writeFileSync(join(dir, 'compose.yaml'), 'old\n');
    expect(run(join(dir, 'staged'), join(dir, 'compose.yaml'), join(dir, 'compose.yaml')).status).toBe(0);
    expect(readFileSync(join(dir, 'compose.yaml'), 'utf8')).toBe('new\n');
  });

  it('refuses when the path leads elsewhere now: a link swapped in after the check sent root to another file (audit 2026-11-23)', () => {
    dir = mkdtempSync(join(tmpdir(), 'burrow-sudo-'));
    writeFileSync(join(dir, 'staged'), 'new\n');
    writeFileSync(join(dir, 'shadow'), 'precious\n');
    // The path led to compose.yaml when the save began (read, its content checked); by the time
    // root writes it leads to another file (here: the path is that file, as a link swapped in
    // between the link check and the write would make it).
    const r = run(join(dir, 'staged'), join(dir, 'shadow'), join(dir, 'compose.yaml'));
    expect(r.status).toBe(5);
    expect(readFileSync(join(dir, 'shadow'), 'utf8')).toBe('precious\n');
  });
});
