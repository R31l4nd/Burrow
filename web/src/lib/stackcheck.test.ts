import { describe, expect, it } from 'vitest';
import type { ImageCheck } from '@burrow/shared';
import { stackCheck } from './stackcheck.js';

const check = (image: string, status: ImageCheck['status'], checkedAt = '2026-10-09T08:00:00.000Z'): ImageCheck => ({
  hostId: 1,
  image,
  status,
  localDigest: null,
  remoteDigest: null,
  error: status === 'unknown' ? 'registry said 429' : null,
  source: null,
  version: null,
  newerTag: null,
  checkedAt,
});

describe("a stack's update line without updates (AUDIT2 PAGE-07)", () => {
  it('none of its images checked: never checked, whatever else was', () => {
    expect(stackCheck([undefined, undefined])).toEqual({ kind: 'never' });
  });
  it('one check failed: not up to date', () => {
    expect(stackCheck([check('a', 'current'), check('b', 'unknown')])).toEqual({ kind: 'unknown', n: 1 });
  });
  it('one image not checked yet: not up to date', () => {
    expect(stackCheck([check('a', 'current'), undefined])).toEqual({ kind: 'unchecked', n: 1 });
  });
  it('all checked: up to date as of the oldest check', () => {
    expect(stackCheck([check('a', 'current', '2026-10-09T09:00:00.000Z'), check('b', 'pinned', '2026-10-09T07:00:00.000Z')])).toEqual({ kind: 'current', at: '2026-10-09T07:00:00.000Z' });
  });
});
