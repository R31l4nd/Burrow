import { readFileSync } from 'node:fs';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { ContainerInfo, DownStack, StackInfo, StackUpdate } from '@burrow/shared';
import type { Ctx } from '../context.js';
import { hosts, stacks, stackUpdates } from '../db/schema.js';
import { HttpError } from '../http.js';
import type { DockerMonitor } from './monitor.js';
import type { OpRunner, StackTarget } from './ops.js';

// A compose stack as Docker's labels describe it: the project, its files and
// directory, and the containers of its services. What Burrow keeps about a
// stack (auto-update, the last deployed compose file) is in the stacks table.

let selfId: string | null | undefined;

/** The id of the container Burrow runs in, from its own mounts; null outside Docker. */
export function selfContainerId(mountinfo?: string): string | null {
  if (mountinfo === undefined && selfId !== undefined) return selfId;
  let text = mountinfo;
  if (text === undefined) {
    try {
      text = readFileSync('/proc/self/mountinfo', 'utf8');
    } catch {
      text = '';
    }
  }
  const id = /\/containers\/([0-9a-f]{64})\//.exec(text)?.[1] ?? null;
  if (mountinfo === undefined) selfId = id;
  return id;
}

export interface StackContainers {
  target: StackTarget;
  containers: ContainerInfo[];
}

/** The stack's containers and files, read from the host now. */
export async function readStack(monitor: DockerMonitor, hostId: number, project: string): Promise<StackContainers> {
  const h = await monitor.poll(hostId);
  if (h.error) throw new HttpError(502, 'docker_error', h.error);
  const containers = h.containers.filter((c) => c.project === project);
  if (!containers.length) throw new HttpError(404, 'stack_not_found', `No containers of stack ${project} on this host.`);
  const withFiles = containers.find((c) => c.configFiles) ?? containers[0]!;
  return {
    target: {
      hostId,
      project,
      workingDir: withFiles.workingDir,
      configFiles: (withFiles.configFiles ?? '').split(',').map((f) => f.trim()).filter(Boolean),
    },
    containers,
  };
}

/**
 * As readStack, and a stack brought down from Burrow too: no containers, its
 * files as kept when it went down (Dockge and Portainer list a stack that is
 * down as well). Back with containers, it is no longer down.
 */
export async function readStackOrDown(ctx: Ctx, monitor: DockerMonitor, hostId: number, project: string): Promise<StackContainers & { downAt: number | null }> {
  const row = stackRow(ctx, hostId, project);
  try {
    const s = await readStack(monitor, hostId, project);
    if (row?.downAt) saveStackRow(ctx, hostId, project, { downAt: null });
    return { ...s, downAt: null };
  } catch (err) {
    if (!(err instanceof HttpError) || err.code !== 'stack_not_found' || !row?.downAt || !row.configFiles) throw err;
    return { target: { hostId, project, workingDir: row.workingDir, configFiles: JSON.parse(row.configFiles) as string[] }, containers: [], downAt: row.downAt };
  }
}

/** Brought down from Burrow: where its files are, so it can be brought up again. */
export function rememberDown(ctx: Ctx, target: StackTarget): void {
  saveStackRow(ctx, target.hostId, target.project, { workingDir: target.workingDir, configFiles: JSON.stringify(target.configFiles), downAt: ctx.now() });
}

/** The stacks brought down from Burrow and not up again. */
export function downStacks(ctx: Ctx): DownStack[] {
  return ctx.db
    .select({ hostId: stacks.hostId, project: stacks.project, downAt: stacks.downAt, hostName: hosts.name })
    .from(stacks)
    .innerJoin(hosts, eq(hosts.id, stacks.hostId))
    .where(isNotNull(stacks.downAt))
    .orderBy(stacks.project)
    .all()
    .map((r) => ({ hostId: r.hostId, hostName: r.hostName, project: r.project, downAt: new Date(r.downAt!).toISOString() }));
}

export function stackRow(ctx: Ctx, hostId: number, project: string) {
  return ctx.db.select().from(stacks).where(and(eq(stacks.hostId, hostId), eq(stacks.project, project))).get();
}

export function saveStackRow(ctx: Ctx, hostId: number, project: string, set: Partial<typeof stacks.$inferInsert>): void {
  ctx.db
    .insert(stacks)
    .values({ hostId, project, ...set })
    .onConflictDoUpdate({ target: [stacks.hostId, stacks.project], set })
    .run();
}

export function isSelf(containers: ContainerInfo[], self = selfContainerId()): boolean {
  return !!self && containers.some((c) => c.id === self);
}

/** The list with Burrow's own container marked, so a page can say so before it is asked to stop it. */
export function markSelf(containers: ContainerInfo[], self = selfContainerId()): ContainerInfo[] {
  return self ? containers.map((c) => (c.id === self ? { ...c, self: true } : c)) : containers;
}

export function stackInfo(ctx: Ctx, runner: OpRunner, s: StackContainers & { downAt?: number | null }): StackInfo {
  const row = stackRow(ctx, s.target.hostId, s.target.project);
  const running = runner.running(s.target.hostId, s.target.project);
  return {
    hostId: s.target.hostId,
    project: s.target.project,
    configFiles: s.target.configFiles,
    workingDir: s.target.workingDir,
    services: s.containers.map((c) => ({ service: c.service ?? c.name, container: c.name, image: c.image, state: c.state })),
    autoUpdate: row?.autoUpdate ?? false,
    self: isSelf(s.containers),
    deployed:
      row?.deployedFile && row.deployedContent !== null && row.deployedAt
        ? { file: row.deployedFile, content: row.deployedContent, at: new Date(row.deployedAt).toISOString() }
        : null,
    running: running ? { ...running.info } : null,
    downAt: s.downAt ? new Date(s.downAt).toISOString() : null,
  };
}

export function stackHistory(ctx: Ctx, hostId: number, project?: string, limit = 20): StackUpdate[] {
  const where = project ? and(eq(stackUpdates.hostId, hostId), eq(stackUpdates.project, project)) : eq(stackUpdates.hostId, hostId);
  return ctx.db
    .select()
    .from(stackUpdates)
    .where(where)
    .orderBy(desc(stackUpdates.startedAt))
    .limit(limit)
    .all()
    .map(toUpdate);
}

export function toUpdate(r: typeof stackUpdates.$inferSelect): StackUpdate {
  return {
    id: r.id,
    hostId: r.hostId,
    project: r.project,
    auto: r.auto,
    result: r.result,
    images: JSON.parse(r.images) as StackUpdate['images'],
    detail: r.detail,
    startedAt: new Date(r.startedAt).toISOString(),
    finishedAt: new Date(r.finishedAt).toISOString(),
  };
}
