import { describe, expect, it } from 'vitest';
import { lineKey } from './logkey.js';

describe("a log line's key, to drop it when sent again after a reconnect", () => {
  it('is the source, the time and the text', () => {
    expect(lineKey({ i: 1, ts: '2026-10-24T10:00:00.000Z', text: 'GET /' })).toBe('1|2026-10-24T10:00:00.000Z|GET /');
  });

  it('leaves the time out of a line without one of its own: the server gives it "now", new at every read (review 2026-10-24)', () => {
    const first = lineKey({ i: 2, ts: '2026-10-24T10:00:00.000Z', text: 'plain line', undated: true });
    const again = lineKey({ i: 2, ts: '2026-10-24T10:05:00.000Z', text: 'plain line', undated: true });
    expect(again).toBe(first);
  });
});
