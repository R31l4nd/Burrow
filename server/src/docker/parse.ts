import { IGNORE_LABEL, TAG_EXCLUDE_LABEL, TAG_INCLUDE_LABEL, type ContainerInfo, type ContainerState, type ContainerStats } from '@burrow/shared';

// Reading a host's containers with the docker CLI, in one SSH command per
// poll: inspect (state, health, restarts, compose labels) and one sample of
// docker stats. The CLI's own JSON, so nothing depends on column layouts.

// Whole objects rather than single fields: Docker 29 treats a missing field
// (.State.Health without a healthcheck) as a template error, older versions
// have structs where newer ones have maps. JSON of the whole thing works on all.
const INSPECT_TEMPLATE =
  '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"state":{{json .State}},' +
  '"restarts":{{json .RestartCount}},"created":{{json .Created}},"labels":{{json .Config.Labels}}}';

const STATS_MARK = '@@burrow-stats';

/**
 * Exit codes of the commands: the list could not be read (no list is not
 * "no containers"), or only the stats sample failed (the list stands).
 */
export const EXIT_NO_LIST = 90;
export const EXIT_NO_STATS = 92;

// A container gone between ps and inspect fails inspect: once more with a fresh list.
const INSPECT = `docker inspect --format '${INSPECT_TEMPLATE}'`;

/**
 * The healthcheck's last five outputs (.State.Health.Log) emptied on the
 * host: they made up most of inspect's answer (4.2 KB a container on
 * average, up to 25 KB), so a host with more than about 950 containers
 * passed the 4 MB Burrow reads and showed none (OPS-W-10). Only the status
 * is used. A JSON string ("...") is skipped whole, so brackets or escaped
 * quotes in an output do not end the list early.
 */
export const STRIP_HEALTH_LOG = String.raw`sed -E 's/"Log":\[([^]["]|"([^"\\]|\\.)*")*\]/"Log":[]/g'`;
const STATE = [
  `ids=$(docker ps -aq --no-trunc) || exit ${EXIT_NO_LIST}`,
  // Held until it succeeded: a first try that printed half and failed was
  // followed by the whole list, and containers counted twice (AUDIT2 DO-10).
  `if [ -n "$ids" ]; then out=$(${INSPECT} $ids 2>/dev/null) || { ids=$(docker ps -aq --no-trunc) && out=$( [ -z "$ids" ] || ${INSPECT} $ids ); } || exit ${EXIT_NO_LIST}; printf '%s\\n' "$out" | ${STRIP_HEALTH_LOG}; fi`,
  `echo '${STATS_MARK}'`,
];

/** Containers (all, also stopped), then a line, then one stats sample of the running ones. */
export const MONITOR_COMMAND = [...STATE, `docker stats --no-stream --no-trunc --format '{{json .}}' || exit ${EXIT_NO_STATS}`].join('; ');

/**
 * The containers without the stats sample: docker stats takes seconds with
 * many containers (2.3 s for 72), inspect a tenth of that. The watch loop
 * asks for stats only every few polls.
 */
export const STATE_COMMAND = STATE.join('; ');

const ZERO_TIME = /^0001-01-01/;
const STATES = new Set(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']);

const time = (s: unknown): string | null => (typeof s === 'string' && s && !ZERO_TIME.test(s) ? s : null);
const text = (s: unknown): string | null => (typeof s === 'string' && s ? s : null);

/** "87.32MiB", "31.1GiB", "1.71MB", "512B" -> bytes. */
export function parseSize(s: string): number {
  const m = /^([\d.]+)\s*([KMGTP]?i?B)?$/i.exec(s.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'B').toUpperCase();
  const pow = { B: 0, K: 1, M: 2, G: 3, T: 4, P: 5 }[unit[0] as 'B'] ?? 0;
  const base = unit.includes('I') ? 1024 : 1000;
  return Math.round(n * base ** pow);
}

export interface MonitorSample {
  containers: ContainerInfo[];
  stats: Map<string, ContainerStats>;
}

export function parseMonitor(out: string, ignoreLabel: string = IGNORE_LABEL): MonitorSample {
  const [inspectPart = '', statsPart = ''] = out.split(STATS_MARK);
  const containers: ContainerInfo[] = [];
  for (const line of inspectPart.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      const st = (r.state ?? {}) as Record<string, unknown>;
      const labels = (r.labels ?? {}) as Record<string, string>;
      const state = String(st.Status ?? '');
      containers.push({
        id: String(r.id),
        name: String(r.name).replace(/^\//, ''),
        image: String(r.image ?? ''),
        imageId: String(r.imageId ?? ''),
        state: (STATES.has(state) ? state : 'dead') as ContainerState,
        health: text((st.Health as Record<string, unknown> | null | undefined)?.Status),
        restarts: Number(r.restarts) || 0,
        startedAt: time(st.StartedAt),
        finishedAt: time(st.FinishedAt),
        exitCode: Number(st.ExitCode) || 0,
        oomKilled: st.OOMKilled === true,
        createdAt: String(r.created ?? ''),
        project: text(labels['com.docker.compose.project']),
        service: text(labels['com.docker.compose.service']),
        configFiles: text(labels['com.docker.compose.project.config_files']),
        workingDir: text(labels['com.docker.compose.project.working_dir']),
        ignored: labels[ignoreLabel] === 'true',
        tagInclude: text(labels[TAG_INCLUDE_LABEL]),
        tagExclude: text(labels[TAG_EXCLUDE_LABEL]),
        updateManual: labels['burrow.update'] === 'manual',
        // The image's own word for its version (OCI), when it says one (report eaa986).
        version: text(labels['org.opencontainers.image.version']),
      });
    } catch {
      // A line that is not ours.
    }
  }
  // Each container once, as last read.
  const once = [...new Map(containers.map((c) => [c.id, c])).values()];
  containers.length = 0;
  containers.push(...once);
  const stats = new Map<string, ContainerStats>();
  for (const line of statsPart.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const r = JSON.parse(line) as Record<string, string>;
      const [used = '0B', limit = '0B'] = (r.MemUsage ?? '').split('/');
      const memBytes = parseSize(used);
      const memLimitBytes = parseSize(limit);
      stats.set(r.ID ?? r.Container ?? '', {
        cpu: Number.parseFloat(r.CPUPerc ?? '0') || 0,
        memBytes,
        memLimitBytes,
        // "0B / 0B": the host does not count memory (a Raspberry Pi without the memory cgroup), not a container using none.
        ...(memBytes === 0 && memLimitBytes === 0 ? { memKnown: false as const } : {}),
      });
    } catch {
      // Skip.
    }
  }
  return { containers: containers.sort((a, b) => a.name.localeCompare(b.name)), stats };
}
