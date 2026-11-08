import { describe, expect, it } from 'vitest';
import { continues, foldStacks } from './stacktrace.js';

describe('stack traces in a log', () => {
  it('knows the lines that go on from the one before', () => {
    for (const l of ['\tat com.example.Main.run(Main.java:12)', '    at Object.<anonymous> (/app/index.js:3:9)', '  File "/app/x.py", line 3, in <module>', 'Caused by: java.io.IOException: boom', '\t... 12 more'])
      expect(continues(l), l).toBe(true);
    for (const l of ['ERROR something broke', 'GET /api 200', '', 'Traceback (most recent call last):']) expect(continues(l), l).toBe(false);
  });

  it('folds them under their first line, one source at a time', () => {
    const lines = [
      { source: 0, text: 'starting' },
      { source: 0, text: 'java.lang.IllegalStateException: boom' },
      { source: 0, text: '\tat a.B.c(B.java:1)' },
      { source: 1, text: '\tat other.Source(X.java:2)' },
      { source: 0, text: '\tat a.B.d(B.java:2)' },
      { source: 0, text: 'next event' },
    ];
    const { more, headOf } = foldStacks(lines);
    expect(more.get(1)).toBe(1);
    expect(headOf.get(2)).toBe(1);
    // Another source's line in between ends the trace; it starts none of its own.
    expect(headOf.has(3)).toBe(false);
    expect(headOf.has(4)).toBe(false);
    expect(headOf.has(5)).toBe(false);
  });
});
