// How long to wait before connecting to a host again that keeps failing:
// the alert streams and the pool's background callers (statistics, the
// container monitor, package checks) use the same waits.

export const RETRY_MS = 10_000;
/** Longest wait between connects to a host that keeps failing them. */
export const RETRY_MAX_MS = 30 * 60_000;
/** Refused for who Burrow is or what the host's key is: not better in seconds, and each try is a failed login to fail2ban. */
const REFUSED_RETRY_MS = 5 * 60_000;
const REFUSED = new Set(['auth_failed', 'unknown_host_key', 'host_key_mismatch']);

/**
 * How long to wait before connecting again after `failures` failed connects in a row: from ten
 * seconds (five minutes when the host refused Burrow itself), doubled each time up to half an hour,
 * a little spread. Every ten seconds, a wrong password got Burrow banned by fail2ban within minutes,
 * terminals and files with it, and a host that was off filled the log.
 */
export function retryAfter(failures: number, code: string | undefined, random: () => number = Math.random): number {
  const first = code && REFUSED.has(code) ? REFUSED_RETRY_MS : RETRY_MS;
  return Math.min(RETRY_MAX_MS, Math.round(first * 2 ** Math.max(0, failures - 1) * (1 + random() * 0.1)));
}
