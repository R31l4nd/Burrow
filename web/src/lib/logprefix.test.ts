import { describe, expect, it } from 'vitest';
import { repeatedHead } from './logprefix.js';

const head = (text: string, level: Parameters<typeof repeatedHead>[1]) => text.slice(0, repeatedHead(text, level));

describe('repeatedHead', () => {
  it("an app's own time and level after Burrow's: that head (the live Burrow's Jellyfin lines)", () => {
    expect(head('[01:31:59] [INF] [12] Main: Startup complete', 'info')).toBe('[01:31:59] [INF] ');
    expect(head('2026-10-08 01:31:59.123 +02:00 WARN disk almost full', 'warn')).toBe('2026-10-08 01:31:59.123 +02:00 WARN ');
    expect(head('ERROR: could not reach the database', 'error')).toBe('ERROR: ');
    expect(head('01:31:59 listening on :8080', null)).toBe('01:31:59 ');
  });
  it('not a word that only looks like a level, nor a level other than the line has, nor the whole line', () => {
    expect(head('Information about the run follows', 'info')).toBe('');
    expect(head('[WARN] something', 'error')).toBe('');
    expect(head('[01:31:59] ', null)).toBe('');
    expect(head('listening on :8080', 'info')).toBe('');
  });
});
