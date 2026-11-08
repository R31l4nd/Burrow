import { skipReason } from '@burrow/shared';
import type { HistoryItem } from '../lib/complete/engine.js';

/**
 * A command run in a direct session, added to the phone's history (and its
 * suggestions): by the server's rules, so a password on the command line is
 * kept nowhere. Null when it is not kept.
 */
export function remembered(history: HistoryItem[], cmd: string, now = new Date()): HistoryItem[] | null {
  if (skipReason(cmd) !== null) return null;
  return [{ command: cmd, count: 1, lastAt: now.toISOString(), score: 100 } as HistoryItem, ...history.filter((h) => h.command !== cmd)];
}
