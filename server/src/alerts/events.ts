import { IGNORE_LABEL, type AlertEvent } from '@burrow/shared';

// Docker's container events, as `docker events --format '{{json .}}'`
// prints them, turned into what an alert cares about. A container someone
// stops (`kill` just before `die`) is not a crash.

export const EVENTS_COMMAND =
  "docker events --format '{{json .}}' --filter type=container --filter event=die --filter event=oom --filter event=kill --filter event=health_status";

export interface ContainerEvent {
  container: string;
  id: string;
  project: string | null;
  action: 'die' | 'oom' | 'kill' | 'unhealthy' | 'healthy';
  exitCode: number | null;
  /** RFC 3339, for the link to the logs. */
  at: string;
  ms: number;
}

export function parseEvent(line: string, ignoreLabel: string = IGNORE_LABEL): ContainerEvent | null {
  let r: { Action?: string; status?: string; id?: string; time?: number; timeNano?: number; Actor?: { ID?: string; Attributes?: Record<string, string> } };
  try {
    r = JSON.parse(line) as typeof r;
  } catch {
    return null;
  }
  const raw = (r.Action ?? r.status ?? '').trim();
  const action = raw === 'die' || raw === 'oom' || raw === 'kill' ? raw : raw === 'health_status: unhealthy' ? 'unhealthy' : raw === 'health_status: healthy' ? 'healthy' : null;
  const attrs = r.Actor?.Attributes ?? {};
  // Labelled to be left alone (throwaway and test containers).
  if (!action || !attrs.name || attrs[ignoreLabel] === 'true') return null;
  const ms = r.timeNano ? Math.floor(r.timeNano / 1e6) : (r.time ?? 0) * 1000;
  const code = attrs.exitCode !== undefined ? Number(attrs.exitCode) : null;
  return {
    container: attrs.name,
    id: r.Actor?.ID ?? r.id ?? '',
    project: attrs['com.docker.compose.project'] ?? null,
    action,
    exitCode: Number.isFinite(code) ? code : null,
    at: new Date(ms).toISOString(),
    ms,
  };
}

const KILL_GRACE_MS = 30_000;
const LOOP_WINDOW_MS = 5 * 60_000;
const LOOP_DIES = 3;

export interface Happening {
  event: AlertEvent;
  title: string;
}

/**
 * Remembers recent kills and exits per container, and says which alert
 * events an incoming Docker event is: an exit with an error that nobody
 * asked for is a crash; three exits within five minutes a restart loop.
 */
export class EventJudge {
  readonly #killed = new Map<string, number>();
  readonly #dies = new Map<string, number[]>();

  judge(e: ContainerEvent): Happening[] {
    const key = e.id || e.container;
    if (e.action === 'kill') {
      this.#killed.set(key, e.ms);
      return [];
    }
    if (e.action === 'oom') return [{ event: 'oom', title: 'killed: out of memory' }];
    if (e.action === 'unhealthy') return [{ event: 'unhealthy', title: 'turned unhealthy' }];
    if (e.action !== 'die') return [];
    const killedAt = this.#killed.get(key);
    this.#killed.delete(key);
    if (killedAt !== undefined && e.ms - killedAt < KILL_GRACE_MS) return [];
    const out: Happening[] = [];
    if (e.exitCode !== 0) out.push({ event: 'crash', title: `exited with code ${e.exitCode ?? '?'}` });
    const dies = [...(this.#dies.get(key) ?? []).filter((t) => e.ms - t < LOOP_WINDOW_MS), e.ms];
    this.#dies.set(key, dies);
    if (dies.length >= LOOP_DIES) {
      out.push({ event: 'restart_loop', title: `stopped ${dies.length} times in 5 minutes` });
      this.#dies.set(key, []);
    }
    return out;
  }
}
