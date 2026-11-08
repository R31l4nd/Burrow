// How far a compose operation is, read from its output (`docker compose
// --ansi never`, which prints one line per change): the images being pulled
// with their bytes, and the containers being created, started or removed.
// Only what the output says; unknown totals stay unknown.

export type StepState = 'waiting' | 'busy' | 'done' | 'failed';

export interface OpProgress {
  /** Services whose image is pulled ("web Pulling" ... "web Pulled"). */
  images: { name: string; state: StepState }[];
  /** Bytes of the layers downloaded so far; the total only when compose says it for every layer. */
  bytes: { done: number; total: number | null } | null;
  /** Containers (and networks, volumes) being created, started, stopped or removed. */
  containers: { name: string; state: StepState }[];
}

const UNITS: Record<string, number> = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };
const size = (s: string): number => {
  const m = /^([\d.]+)\s*([kKMG]i?B|B)$/.exec(s);
  return m ? Number(m[1]) * (UNITS[m[2]!] ?? 1) : 0;
};

// Container states: what is still going on, what is an end.
const BUSY = /^(Creating|Recreate|Starting|Stopping|Removing|Restarting|Waiting|Pulling)$/;
const DONE = /^(Created|Recreated|Started|Stopped|Removed|Restarted|Running|Healthy|Exited|Up-to-date)$/;

export function opProgress(output: string): OpProgress {
  const images = new Map<string, StepState>();
  const layers = new Map<string, { done: number; total: number }>();
  const containers = new Map<string, StepState>();
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    // "Container burrowtest-web-1  Started", "Network x_default  Created".
    if ((m = /^(Container|Network|Volume)\s+(\S+)\s+(.+)$/.exec(line))) {
      const [, kind, name, what] = m;
      const word = what!.split(' ')[0]!;
      const key = kind === 'Container' ? name! : `${kind!.toLowerCase()} ${name}`;
      if (/^Error/.test(what!)) containers.set(key, 'failed');
      else if (BUSY.test(word)) containers.set(key, 'busy');
      else if (DONE.test(word)) containers.set(key, 'done');
      continue;
    }
    // A layer: "4f4fb700ef54 Downloading [==>  ]  1.2MB/30.5MB" (compose v2),
    // or "a7cd7d9a2144 Downloading 48.51kB" (newer: no total).
    if ((m = /^([0-9a-f]{12})\s+(.+)$/.exec(line))) {
      const [, id, what] = m;
      const l = layers.get(id!) ?? { done: 0, total: 0 };
      const d = /Downloading\s*(?:\[[^\]]*\])?\s*([\d.]+\s*[kKMG]?i?B)(?:\/([\d.]+\s*[kKMG]?i?B))?/.exec(what!);
      if (d) {
        l.done = Math.max(l.done, size(d[1]!));
        if (d[2]) l.total = size(d[2]);
      } else if (/^(Download complete|Verifying Checksum|Extracting|Pull complete|Already exists)/.test(what!)) {
        if (l.total) l.done = l.total;
      }
      layers.set(id!, l);
      continue;
    }
    // A service's image: "web Pulling", "web Pulled", "web Skipped - Image is
    // already present locally", "web Error" (compose v2), or "Image nginx:1.27 Pulling" (newer).
    if ((m = /^(?:Image\s+)?(\S+)\s+(Pulling|Pulled|Skipped|Error|Interrupted)\b/.exec(line))) {
      const [, name, what] = m;
      if (/^[0-9a-f]{12}$/.test(name!)) continue;
      images.set(name!, what === 'Pulling' ? (images.get(name!) === 'done' ? 'done' : 'busy') : what === 'Error' || what === 'Interrupted' ? 'failed' : 'done');
    }
  }
  const all = [...layers.values()];
  const done = all.reduce((a, l) => a + l.done, 0);
  return {
    images: [...images].map(([name, state]) => ({ name, state })),
    bytes: done ? { done, total: all.every((l) => l.total > 0) ? all.reduce((a, l) => a + l.total, 0) : null } : null,
    containers: [...containers].map(([name, state]) => ({ name, state })),
  };
}
