import type { LogLine } from '@burrow/shared';

/**
 * A log line's key: a reconnect sends the lines since the last one again, and
 * those seen already are dropped by it. A line without a time of its own (a
 * plain log file) is given "now" by the server, new at every read, so its
 * key leaves the time out (it was added again at each reconnect).
 */
export const lineKey = (l: Pick<LogLine, 'i' | 'ts' | 'text' | 'undated'>): string => (l.undated ? `${l.i}|u|${l.text}` : `${l.i}|${l.ts}|${l.text}`);
