import type { FastifyInstance } from 'fastify';
import { pruneInput, unused, type DockerResources, type ImageResource, type NetworkResource, type PruneResult, type VolumeResource } from '@burrow/shared';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import type { SftpPool } from '../files/pool.js';
import { getHost } from '../hosts/service.js';
import { actor, HttpError, idParam, parse } from '../http.js';
import { exec } from '../ssh/connect.js';
import { shellQuote } from '../ssh/quote.js';
import { parseSize } from './parse.js';
import { selfContainerId } from './stacks.js';

// A host's images, volumes and networks, and what uses them; cleaning up
// removes only what nothing uses, after showing it (docs/PRIOR-ART.md:
// Portainer, Dockhand). Over SSH, like everything else.

/** One command; a part Docker could not list fails it (no list is not "nothing there"). */
export const RESOURCES_COMMAND = [
  "echo @@images; docker image ls -a --no-trunc --format '{{json .}}' || exit 90",
  "echo @@volumes; docker volume ls --format '{{json .}}' || exit 90",
  "echo @@networks; docker network ls --no-trunc --format '{{json .}}' || exit 90",
  // What uses them, or that it could not be read: an empty list made
  // everything look unused (AUDIT2 DO-11). Once more with a fresh list when
  // a container went between ps and inspect.
  "echo @@uses; F='{{json .Id}} {{json .Name}} {{json .Image}} {{json .Mounts}} {{json .NetworkSettings.Networks}} {{json .Config.Labels}}'; ids=$(docker ps -aq --no-trunc) || exit 90; if [ -n \"$ids\" ]; then out=$(docker inspect --format \"$F\" $ids 2>/dev/null) || { ids=$(docker ps -aq --no-trunc) && out=$( [ -z \"$ids\" ] || docker inspect --format \"$F\" $ids ); } || { echo @@uses-unread; out=''; }; printf '%s\\n' \"$out\"; fi",
].join('\n');

const BUILTIN = new Set(['bridge', 'host', 'none']);

function rows(out: string, mark: string): Record<string, string>[] {
  const part = (out.split(`@@${mark}\n`)[1] ?? '').split('\n@@')[0] ?? '';
  return part
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, string>];
      } catch {
        return [];
      }
    });
}

export function parseResources(hostId: number, out: string, self: string | null = selfContainerId()): DockerResources {
  const imageUse = new Map<string, string[]>();
  const volumeUse = new Map<string, string[]>();
  const networkUse = new Map<string, string[]>();
  let selfProject: string | null = null;
  const add = (m: Map<string, string[]>, k: string, name: string) => m.set(k, [...(m.get(k) ?? []), name]);
  const uses = (out.split('@@uses\n')[1] ?? '').split('\n');
  const usageUnknown = uses.some((l) => l.trim() === '@@uses-unread');
  for (const line of uses) {
    // Six JSON values in a row, split where one ends and the next begins.
    const parts = line.trim() ? splitJsonValues(line) : [];
    if (parts.length < 6) continue;
    const [id, rawName, image, mounts, nets, labels] = parts as [string, string, string, { Type?: string; Name?: string }[] | null, Record<string, { NetworkID?: string }> | null, Record<string, string> | null];
    const name = String(rawName).replace(/^\//, '');
    add(imageUse, image, name);
    for (const m of mounts ?? []) if (m.Type === 'volume' && m.Name) add(volumeUse, m.Name, name);
    for (const [netName, n] of Object.entries(nets ?? {})) {
      add(networkUse, netName, name);
      if (n.NetworkID) add(networkUse, n.NetworkID, name);
    }
    if (self && id === self) selfProject = labels?.['com.docker.compose.project'] ?? null;
  }
  const images: ImageResource[] = [];
  for (const r of rows(out, 'images')) {
    const id = r.ID?.startsWith('sha256:') ? r.ID : `sha256:${r.ID}`;
    const tag = r.Repository && r.Repository !== '<none>' ? `${r.Repository}:${r.Tag}` : null;
    const known = images.find((i) => i.id === id);
    if (known) {
      if (tag && !known.tags.includes(tag)) known.tags.push(tag);
      continue;
    }
    images.push({ id, tags: tag ? [tag] : [], sizeBytes: parseSize(r.Size ?? '0'), created: r.CreatedAt ?? null, usedBy: imageUse.get(id) ?? [] });
  }
  const volumes: VolumeResource[] = rows(out, 'volumes').map((r) => ({
    name: r.Name ?? '',
    driver: r.Driver ?? '',
    project: /(?:^|,)com\.docker\.compose\.project=([^,]+)/.exec(r.Labels ?? '')?.[1] ?? null,
    usedBy: volumeUse.get(r.Name ?? '') ?? [],
  }));
  const networks: NetworkResource[] = rows(out, 'networks').map((r) => ({
    id: r.ID ?? '',
    name: r.Name ?? '',
    driver: r.Driver ?? '',
    builtin: BUILTIN.has(r.Name ?? ''),
    usedBy: [...new Set([...(networkUse.get(r.Name ?? '') ?? []), ...(networkUse.get(r.ID ?? '') ?? [])])],
  }));
  return { hostId, images, volumes, networks, selfProject, ...(usageUnknown ? { usageUnknown: true } : {}) };
}

/** "a" {"b":1} null [...]: the JSON values on one line, in order. */
function splitJsonValues(line: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let inStr = false;
  let start = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (start < 0) {
      if (ch === ' ') continue;
      start = i;
    }
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    if (!inStr && depth === 0 && (i === line.length - 1 || line[i + 1] === ' ')) {
      try {
        out.push(JSON.parse(line.slice(start, i + 1)));
      } catch {
        return [];
      }
      start = -1;
    }
  }
  return out;
}

export function registerResourceRoutes(app: FastifyInstance, ctx: Ctx, pool: SftpPool): void {
  const read = async (hostId: number): Promise<DockerResources> => {
    const r = await pool.with(hostId, ({ client }) => exec(client, RESOURCES_COMMAND, 60_000, 8 << 20));
    if (r.code !== 0) throw new HttpError(502, 'docker_error', (r.stderr || r.stdout).trim().split('\n').pop() || `docker exited with ${r.code}`);
    return parseResources(hostId, r.stdout);
  };

  // To look at for anyone signed in (as the containers are); cleaning up stays the admin's.
  app.get('/api/docker/:hostId/resources', { config: { auth: 'user' } }, async (req) => {
    const hostId = idParam(req, 'hostId');
    getHost(ctx, hostId);
    return read(hostId);
  });

  /**
   * Removes exactly what was shown as unused, if it still is: read again
   * first, never with -f (Docker refuses what a container took meanwhile).
   */
  app.post('/api/docker/:hostId/prune', { config: { stepUp: true } }, async (req): Promise<PruneResult> => {
    const hostId = idParam(req, 'hostId');
    const host = getHost(ctx, hostId);
    const want = parse(pruneInput, req.body);
    const now = unused(await read(hostId));
    const result: PruneResult = { removed: { images: [], volumes: [], networks: [] }, skipped: [], freedBytes: 0 };
    const steps: { kind: 'image' | 'volume' | 'network'; id: string; ok: boolean; cmd: string; bytes: number }[] = [
      ...want.images.map((id) => ({ kind: 'image' as const, id, ok: now.images.some((i) => i.id === id), cmd: `docker image rm -- ${shellQuote(id)}`, bytes: now.images.find((i) => i.id === id)?.sizeBytes ?? 0 })),
      ...want.volumes.map((id) => ({ kind: 'volume' as const, id, ok: now.volumes.some((v) => v.name === id), cmd: `docker volume rm -- ${shellQuote(id)}`, bytes: 0 })),
      ...want.networks.map((id) => ({ kind: 'network' as const, id, ok: now.networks.some((n) => n.id === id), cmd: `docker network rm -- ${shellQuote(id)}`, bytes: 0 })),
    ];
    for (const s of steps) {
      if (!s.ok) {
        result.skipped.push({ kind: s.kind, id: s.id, why: 'in use, Burrow\'s own, or gone' });
        continue;
      }
      const r = await pool.with(hostId, ({ client }) => exec(client, s.cmd, 120_000));
      if (r.code !== 0) {
        result.skipped.push({ kind: s.kind, id: s.id, why: (r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.code}` });
        continue;
      }
      result.removed[`${s.kind}s` as 'images' | 'volumes' | 'networks'].push(s.id);
      result.freedBytes += s.bytes;
    }
    audit(ctx, actor(req), 'docker.prune', host.name, { removed: result.removed, skipped: result.skipped.length });
    return result;
  });
}
