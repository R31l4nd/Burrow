import { describe, expect, it } from 'vitest';
import { CommandTimeout } from '../../src/ssh/connect.js';
import { HttpError, httpErrorOf } from '../../src/http.js';

// A command on a host that did not answer in time: a 504 in words, not "internal" (live log
// 2026-10-19: GET /api/workspace/:hostId/files 500 after "command timed out after 30000 ms").
describe('httpErrorOf', () => {
  it('a timed-out command is a 504 saying how long Burrow waited', () => {
    const e = httpErrorOf(new CommandTimeout(30_000));
    expect(e).toBeInstanceOf(HttpError);
    expect(e).toMatchObject({ status: 504, code: 'host_timeout' });
    expect(e!.message).toContain('30 s');
  });
  it('anything else is left to the handler', () => {
    expect(httpErrorOf(new Error('boom'))).toBeNull();
  });
});
