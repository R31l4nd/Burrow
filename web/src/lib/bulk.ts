// Several picked containers at once (Containers -> Select): what an action
// does to each, and what it leaves alone and why. The page then runs the
// container route once per container (the same as from a container's own
// page), or a stack's update per stack.

export type BulkAction = 'restart' | 'stop' | 'start' | 'update';

export interface BulkRow {
  hostId: number;
  hostName: string;
  name: string;
  running: boolean;
  /** The container Burrow runs in. */
  self: boolean;
  project: string | null;
  service: string | null;
  image: string;
  hasUpdate: boolean;
}

export type SkipReason = 'running' | 'stopped' | 'self' | 'noUpdate' | 'noStack';

export interface BulkPlan {
  act: BulkRow[];
  skip: { row: BulkRow; reason: SkipReason }[];
  /** For an update: the stacks, each with the services to update and their images. */
  stacks: { hostId: number; hostName: string; project: string; services: string[]; images: string[] }[];
}

function why(a: BulkAction, r: BulkRow): SkipReason | null {
  switch (a) {
    case 'start':
      return r.running ? 'running' : null;
    case 'stop':
      // Burrow stopping itself would end the page that asked.
      if (r.self) return 'self';
      return r.running ? null : 'stopped';
    case 'restart':
      return null;
    case 'update':
      if (!r.hasUpdate) return 'noUpdate';
      return r.project && r.service ? null : 'noStack';
  }
}

export function plan(a: BulkAction, rows: BulkRow[]): BulkPlan {
  const act: BulkRow[] = [];
  const skip: BulkPlan['skip'] = [];
  for (const r of rows) {
    const reason = why(a, r);
    if (reason) skip.push({ row: r, reason });
    else act.push(r);
  }
  const stacks: BulkPlan['stacks'] = [];
  if (a === 'update') {
    for (const r of act) {
      let s = stacks.find((x) => x.hostId === r.hostId && x.project === r.project);
      if (!s) stacks.push((s = { hostId: r.hostId, hostName: r.hostName, project: r.project!, services: [], images: [] }));
      if (!s.services.includes(r.service!)) s.services.push(r.service!);
      if (!s.images.includes(r.image)) s.images.push(r.image);
    }
  }
  return { act, skip, stacks };
}

/**
 * Runs [work] for each item, at most [perHost] at a time on one host, the
 * first one alone (it may ask the person to confirm it is them; the rest
 * then go without asking again). One failing does not stop the others.
 */
export async function runAll<T extends { hostId: number }>(items: T[], work: (x: T) => Promise<void>, perHost = 2): Promise<void> {
  if (!items.length) return;
  const [first, ...rest] = items;
  await work(first!).catch(() => {});
  const hosts = [...new Set(rest.map((x) => x.hostId))];
  await Promise.all(
    hosts.map(async (h) => {
      const queue = rest.filter((x) => x.hostId === h);
      const lane = async () => {
        for (let x = queue.shift(); x; x = queue.shift()) await work(x).catch(() => {});
      };
      await Promise.all(Array.from({ length: Math.min(perHost, queue.length) }, lane));
    }),
  );
}
