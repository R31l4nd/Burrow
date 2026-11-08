import { parseTarget, type LogTarget } from '@burrow/shared';

/** "1:web,2:db,3::%2Fvar%2Flog%2Fsyslog" from a URL, keeping only well-formed targets. */
export function parseTargetList(s: string): LogTarget[] {
  return s
    .split(',')
    .map((p) => parseTarget(p))
    .filter((t): t is LogTarget => t !== null);
}
