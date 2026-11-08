import { and, desc, eq, gte } from 'drizzle-orm';
import { levelRank, needsReading, plural, tagLine, updateLevel, type Changelog, type ContainerInfo, type ImageCheck, type StackUpdate, type UpdateLevel, type UpdateResult } from '@burrow/shared';
import { audit, type Actor } from '../audit.js';
import type { Ctx } from '../context.js';
import { hosts, stacks, stackUpdates } from '../db/schema.js';
import { getHost } from '../hosts/service.js';
import type { DockerMonitor } from './monitor.js';
import { composeArgs, opScript, prelude, rollbackScript, type JobControl, type Op, type OpRunner, type StackTarget } from './ops.js';
import { changelog } from './changelog.js';
import { isSelf, readStack, saveStackRow, stackRow, toUpdate } from './stacks.js';
import { shellQuote } from '../ssh/quote.js';
import type { Notifier } from '../notify/channels.js';
import { getUpdateSettings, getUpdateState, inWindow, rolledBackAt, setUpdateState, type UpdateChecker } from './updates.js';

// Updating a stack's images: pull and recreate the services with a newer
// image, then watch them for a while. A container that stops, keeps
// restarting or turns unhealthy puts the old images back. Each update, and
// each rollback, ends up in the stack's history and the audit log.
//
// Automatically once a day in the maintenance window, for stacks that opted
// in; never for the stack Burrow itself runs in (it would stop watching).

const SYSTEM: Actor = { userId: null, username: 'burrow', ip: null };

export interface UpdaterOptions {
  /** How long updated containers must stay well before the update counts. */
  settleMs: number;
  /** How long a healthcheck may stay "starting". */
  healthWaitMs: number;
  pollMs: number;
}

export const DEFAULT_UPDATER: UpdaterOptions = { settleMs: 60_000, healthWaitMs: 180_000, pollMs: 5000 };
/** Reads of a watched stack that may fail in a row before it counts as unreadable. */
const WATCH_MISSES = 3;

type Verdict = { ok: true } | { ok: false; why: string };

/** An update under way, kept across a restart of Burrow (AUDIT2 DO-05). */
/** How long an update left in the middle by a restart waits for its stack to be readable again. */
const RECOVER_FOR_MS = 24 * 3600_000;

export interface PendingUpdate {
  hostId: number;
  project: string;
  auto: boolean;
  services: string[];
  images: { image: string; from: string | null; to: string | null }[];
  /** The containers before it: what a rollback puts back. */
  before: Pick<ContainerInfo, 'name' | 'service' | 'image' | 'imageId'>[];
  started: number;
}

const keptContainer = (c: ContainerInfo): PendingUpdate['before'][number] => ({ name: c.name, service: c.service, image: c.image, imageId: c.imageId });

/** A deploy (`up`) under way, kept across a restart of Burrow (OPS-W-05), watched like an update (decision 11). */
export interface PendingDeploy {
  hostId: number;
  project: string;
  /** The compose file deployed from its review, and its content as reviewed; null for a plain up. */
  file: string | null;
  content: string | null;
  /** The stack's other compose files and its .env as they were for this deploy (path -> content). */
  extra?: Record<string, string>;
  /** The containers before it: which services the deploy recreated, and what a rollback puts back. */
  before: (PendingUpdate['before'][number] & { id: string })[];
  started: number;
}

/** A compose file larger than this is not put back by a rollback (it goes on the command line). */
const MAX_ROLLBACK_FILE = 256 << 10;

/**
 * Puts a stack's previous deployment back after a deploy that does not run
 * well: its compose file as Burrow last deployed it, each service on the
 * image it ran before, without pulling. Compose records the files a
 * container was made from (a file of its own made them point at a file
 * gone afterwards), so the previous content goes into the stack's own file
 * for the moment of `up`, and the person's version back into it right
 * after, the same inode, owner and mode. Services the deploy added are
 * removed.
 */
export function deployRollbackScript(t: StackTarget, files: { path: string; content: string }[], back: { service: string; ref: string; imageId: string }[], added: string[]): string {
  const lines = [prelude(t), `echo ${shellQuote(`$ rollback ${t.project}`)}`];
  // Each file as deployed (the compose files, the .env) for the moment of up; the person's own kept
  // beside it and put back, whatever happens (review 2026-10-24: only one file came back).
  const restore: string[] = [];
  files.forEach((file, i) => {
    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) || '/' : '.';
    const f = shellQuote(file.path);
    // Gone since (a .env removed): written for the moment of up, removed again after.
    lines.push(`if [ -e ${f} ]; then y${i}=$(mktemp ${shellQuote(`${dir}/.burrow-yours.`)}XXXXXX) || exit 1; cp -p -- ${f} "$y${i}" || exit 1; else y${i}=; fi`);
    const g = f.replace(/'/g, `'\\''`);
    restore.push(`if [ -n "$y${i}" ]; then cat "$y${i}" > ${g} && rm -f "$y${i}"; else rm -f ${g}; fi`);
  });
  // Each tag back on the image it named before, as an update's rollback does; pinned by id
  // only where one tag ran as two images (a container pinned by id is no longer known by its tag).
  const idsOf = new Map<string, Set<string>>();
  for (const b of back) idsOf.set(b.ref, (idsOf.get(b.ref) ?? new Set()).add(b.imageId));
  const pinned = back.filter((b) => idsOf.get(b.ref)!.size > 1);
  lines.push(pinned.length ? 'o=$(mktemp /tmp/burrow-rollback.XXXXXX) || exit 1' : 'o=', `trap '${restore.join('; ')}; rm -f $o' EXIT`, ...files.map((file) => `printf '%s' ${shellQuote(file.content)} > ${shellQuote(file.path)}`));
  for (const [ref, ids] of idsOf) if (ids.size === 1) lines.push(`docker tag ${shellQuote([...ids][0]!)} ${shellQuote(ref)} || exit 1`);
  if (pinned.length) lines.push(`printf '%s\\n' ${shellQuote(['services:', ...pinned.flatMap((b) => [`  "${b.service}":`, `    image: ${b.imageId}`])].join('\n'))} > "$o"`);
  if (added.length) lines.push(`docker rm -f ${added.map(shellQuote).join(' ')} >/dev/null 2>&1`);
  if (back.length) lines.push(`dc ${composeArgs(t)}${pinned.length ? ' -f "$o"' : ''} up -d --no-deps --pull never ${[...new Set(back.map((b) => shellQuote(b.service)))].join(' ')}`);
  return lines.join('\n');
}

/**
 * Judges the updated services' containers after an update, every replica:
 * bad, fine, or null while a healthcheck is still starting (`final`: no
 * more waiting). `expected`: how many containers a service had before.
 */
export function judge(containers: ContainerInfo[], services: string[], final: boolean, expected?: Map<string, number>): Verdict | null {
  let starting: string | null = null;
  for (const s of services) {
    const cs = containers.filter((x) => x.service === s);
    if (!cs.length) return { ok: false, why: `${s}: no container` };
    const want = expected?.get(s) ?? 0;
    if (cs.length < want) return { ok: false, why: `${s}: ${cs.length} of ${want} containers` };
    for (const c of cs) {
      const who = cs.length > 1 ? `${s} (${c.name})` : s;
      if (c.state !== 'running') return { ok: false, why: `${who}: ${c.state}${c.state === 'exited' ? ` (exit code ${c.exitCode})` : ''}` };
      if (c.restarts > 0) return { ok: false, why: `${who}: restarted ${c.restarts} time(s)` };
      if (c.health === 'unhealthy') return { ok: false, why: `${who}: unhealthy` };
      if (c.health === 'starting') starting ??= who;
    }
  }
  // Only after every container had its say: a failure elsewhere is not waited for.
  if (starting) return final ? { ok: false, why: `${starting}: still starting` } : null;
  return { ok: true };
}

/** Back as before: every container of those services on its old image again, and running. */
export function recovered(containers: ContainerInfo[], before: ContainerInfo[]): Verdict {
  for (const s of new Set(before.map((b) => b.service!))) {
    const old = before.filter((b) => b.service === s);
    const now = containers.filter((c) => c.service === s);
    if (now.length < old.length) return { ok: false, why: `${s}: ${now.length} of ${old.length} containers` };
    const other = now.find((c) => !old.some((b) => b.imageId === c.imageId));
    if (other) return { ok: false, why: `${s}: ${other.name} does not run the previous image` };
    const down = now.find((c) => c.state !== 'running');
    if (down) return { ok: false, why: `${s}: ${down.name} ${down.state}` };
  }
  return { ok: true };
}

export class Updater {
  #timer: NodeJS.Timeout | null = null;
  /** Tells the channels about updates and rollbacks. */
  notifier: Notifier | null = null;
  #windowRunning = false;
  // Updates and deploys left in the middle by a restart: taken up after the hosts were followed
  // again, and then each minute while one waits for its host (it was only tried once, at start-up).
  #recoverable = false;
  #recovering = false;
  /** Those taken up already (host, stack, start): a later round leaves them to the job it started. */
  #taken = new Set<string>();

  get windowRunning(): boolean {
    return this.#windowRunning;
  }

  /** Release notes of an image's source (GitHub); replaced in tests. */
  notes: (source: string | null, version: string | null, image?: string) => Promise<Changelog> = (s, v, image) => changelog(s, v, { line: image ? tagLine(image) : null });

  /**
   * The newer images of these containers whose release notes, from the
   * running version on, announce a breaking change or a new major version:
   * "image tag" each. Notes that cannot be read hold nothing back.
   */
  async breakingIn(hostId: number, containers: ContainerInfo[]): Promise<string[]> {
    const images = new Set(containers.map((c) => c.image));
    const out: string[] = [];
    for (const c of this.checker.list(hostId).filter((x) => x.status === 'update' && images.has(x.image))) {
      try {
        const log = await this.notes(c.source, c.version, c.image);
        for (const r of log.releases.filter((x) => needsReading(x.flags))) out.push(`${c.image} ${r.tag}`);
      } catch {
        // No notes (not on GitHub, rate limited): nothing to hold for.
      }
    }
    return out;
  }

  /**
   * The biggest step among a stack's newer images, from their release notes
   * (the running version found among them); null when it cannot be told.
   */
  async levelIn(hostId: number, containers: ContainerInfo[]): Promise<UpdateLevel | null> {
    const images = new Set(containers.map((c) => c.image));
    let level: UpdateLevel = 'patch';
    for (const c of this.checker.list(hostId).filter((x) => x.status === 'update' && images.has(x.image))) {
      const log = await this.notes(c.source, c.version, c.image).catch(() => null);
      const l = log?.matched ? updateLevel(c.version, log.releases.map((r) => r.tag)) : null;
      if (l === null) return null;
      if (levelRank(l) > levelRank(level)) level = l;
    }
    return level;
  }

  /** A stack that waits because its step is bigger than allowed: said once per step. */
  #tellLevel(hostId: number, project: string, level: UpdateLevel | null, allowed: UpdateLevel): void {
    const key = `level ${hostId} ${project} ${level ?? 'unknown'} ${allowed}`;
    const told = getUpdateState(this.ctx).held ?? [];
    if (told.includes(key)) return;
    setUpdateState(this.ctx, { held: [...told.filter((k) => !k.startsWith(`level ${hostId} ${project} `)), key].slice(-200) });
    const what = level === null ? ['a version Burrow cannot tell', 'een versie die Burrow niet kan bepalen'] : level === 'major' ? ['a major version', 'een nieuwe hoofdversie'] : ['a minor version', 'een minor-versie'];
    void this.notifier?.notify({
      topic: 'updates',
      title: `${project}: update waits for you`,
      body: `The update is ${what[0]}; automatic updates go up to ${allowed} versions. Update by hand.`,
      page: `/stacks/${hostId}/${encodeURIComponent(project)}`,
      priority: 3,
      nl: { title: `${project}: update wacht op jou`, body: `De update is ${what[1]}; automatisch bijwerken gaat tot ${allowed}-versies. Werk met de hand bij.` },
    });
  }

  /** The key of a stack's held releases, for "told" and "released". */
  static holdKey = (hostId: number, project: string, held: string[]) => `${hostId} ${project} ${[...held].sort().join(',')}`;

  /** Read and released by a person: this very set of releases may update by itself. */
  isReleased(hostId: number, project: string, held: string[]): boolean {
    return (getUpdateState(this.ctx).released ?? []).includes(Updater.holdKey(hostId, project, held));
  }

  release(hostId: number, project: string, held: string[]): void {
    const others = (getUpdateState(this.ctx).released ?? []).filter((k) => !k.startsWith(`${hostId} ${project} `));
    setUpdateState(this.ctx, { released: [...others, Updater.holdKey(hostId, project, held)].slice(-200) });
  }

  /** A stack that waits for a person: said once per set of releases. */
  #tellHeld(hostId: number, project: string, held: string[]): void {
    const key = Updater.holdKey(hostId, project, held);
    const told = getUpdateState(this.ctx).held ?? [];
    if (told.includes(key)) return;
    setUpdateState(this.ctx, { held: [...told.filter((k) => !k.startsWith(`${hostId} ${project} `)), key].slice(-200) });
    this.ctx.log.info({ hostId }, `updates: ${project} waits: breaking change in ${held.join(', ')}`);
    void this.notifier?.notify({
      topic: 'updates',
      title: `${project}: update waits for you`,
      body: `Release notes announce a breaking change: ${held.join(', ')}. Read them and update by hand.`,
      page: `/stacks/${hostId}/${encodeURIComponent(project)}`,
      priority: 3,
      nl: { title: `${project}: update wacht op jou`, body: `De release notes melden een breaking change: ${held.join(', ')}. Lees ze en werk met de hand bij.` },
    });
  }

  constructor(
    private readonly ctx: Ctx,
    private readonly monitor: DockerMonitor,
    private readonly runner: OpRunner,
    private readonly checker: UpdateChecker,
    private readonly opts: UpdaterOptions = DEFAULT_UPDATER,
  ) {}

  /** The services of a stack with a newer image, according to the last check. */
  servicesWithUpdate(containers: ContainerInfo[], checks: ImageCheck[]): string[] {
    const newer = new Set(checks.filter((c) => c.status === 'update').map((c) => c.image));
    return [...new Set(containers.filter((c) => newer.has(c.image) && c.service).map((c) => c.service!))];
  }

  /** Writes an update's end: its history row, the audit log and the message on the channels. */
  // judged: the new version ran and was found wanting (or could not be put back). A failure before
  // anything changed (a pull the registry refused for a moment) says nothing about the version.
  #record(rec: PendingUpdate, actor: Actor, result: UpdateResult, detail: string | null, judged = true): void {
    const { hostId, project, auto, services, images } = rec;
    // Forgotten first, the host by a name that holds when it was deleted meanwhile: getHost threw
    // there, the update stayed pending and the round over the others stopped at it (audit 2026-11-05).
    this.#forget(rec);
    const host = { name: this.#hostName(hostId) };
    // No history row for a host that is gone (it would go with the host; the insert was refused).
    if (this.ctx.db.select({ id: hosts.id }).from(hosts).where(eq(hosts.id, hostId)).get())
      this.ctx.db
        .insert(stackUpdates)
        .values({ hostId, project, auto, result, images: JSON.stringify(images), detail, startedAt: rec.started, finishedAt: this.ctx.now() })
        .run();
    if (judged) this.#remember(rec, result);
    audit(this.ctx, actor, result === 'rolled_back' ? 'stack.rollback' : result === 'failed' ? 'stack.update_failed' : 'stack.update', `${host.name}/${project}`, {
      auto,
      services,
      ...(detail ? { detail } : {}),
    });
    if (result === 'unchanged' || !this.notifier) return;
    const what = { updated: ['updated', 'bijgewerkt'], rolled_back: ['rolled back', 'teruggezet'], failed: ['update failed', 'bijwerken mislukt'] }[result];
    const imgs = images.map((i) => i.image).join(', ');
    void this.notifier.notify({
      topic: 'updates',
      title: `${project} on ${host.name}: ${what[0]}`,
      body: [imgs, detail].filter(Boolean).join('\n'),
      page: `/stacks/${hostId}/${encodeURIComponent(project)}`,
      priority: result === 'updated' ? 2 : 4,
      nl: { title: `${project} op ${host.name}: ${what[1]}`, body: [imgs, detail].filter(Boolean).join('\n') },
      data: { hostId, project, result, images, auto },
    });
  }

  /** A host's name, or its id once it was deleted. */
  #hostName(hostId: number): string {
    try {
      return getHost(this.ctx, hostId).name;
    } catch {
      return String(hostId);
    }
  }

  /**
   * A version rolled back (or failed) is remembered by its digest, so the
   * window does not put it on again every night, with the downtime, the
   * alert and maybe a migration each time (W-FUNC-03). Updated: forgotten.
   */
  #remember(rec: PendingUpdate, result: UpdateResult): void {
    if (result === 'unchanged') return;
    const images = new Set(rec.images.map((i) => i.image));
    const rest = (getUpdateState(this.ctx).rolledBack ?? []).filter((x) => !(x.hostId === rec.hostId && images.has(x.image)));
    const bad = result === 'updated' ? [] : rec.images.filter((i) => i.to).map((i) => ({ hostId: rec.hostId, image: i.image, digest: i.to!, at: this.ctx.now() }));
    setUpdateState(this.ctx, { rolledBack: [...rest, ...bad].slice(-200) });
  }

  // An update under way is kept in the update state: when Burrow restarts
  // in the middle (the operation goes on on the host), it is watched and,
  // when not well, rolled back afterwards; the in-memory watch and rollback
  // were lost with the restart (AUDIT2 DO-05).
  #keep(rec: PendingUpdate): void {
    // This Burrow's own job watches it: never taken up again by a recovery round.
    this.#taken.add(`update ${rec.hostId} ${rec.project} ${rec.started}`);
    const rest = (getUpdateState(this.ctx).pending ?? []).filter((p) => !(p.hostId === rec.hostId && p.project === rec.project));
    setUpdateState(this.ctx, { pending: [...rest, rec] });
  }
  #forget(rec: PendingUpdate): void {
    setUpdateState(this.ctx, { pending: (getUpdateState(this.ctx).pending ?? []).filter((p) => !(p.hostId === rec.hostId && p.project === rec.project && p.started === rec.started)) });
  }

  /**
   * Updates a stack: the given services, or all with a newer image. Returns
   * the job at once; its history entry is written when it ends.
   */
  async update(actor: Actor, hostId: number, project: string, auto: boolean, only?: string[]): Promise<Op> {
    const stack = await readStack(this.monitor, hostId, project);
    const checks = this.checker.list(hostId);
    const services = only?.length ? only : this.servicesWithUpdate(stack.containers, checks);
    const before = stack.containers.filter((c) => c.service && services.includes(c.service));
    const images = [...new Set(before.map((c) => c.image))].map((image) => {
      const ch = checks.find((c) => c.image === image);
      return { image, from: ch?.localDigest ?? null, to: ch?.remoteDigest ?? null };
    });
    const rec: PendingUpdate = { hostId, project, auto, services, images, before: before.map(keptContainer), started: this.ctx.now() };
    const finish = (result: UpdateResult, detail: string | null, judged = true) => this.#record(rec, actor, result, detail, judged);

    const op = this.runner.start(stack.target, 'update', async (ctl) => {
      if (!services.length) {
        ctl.say('Nothing to update: every image is the newest.');
        finish('unchanged', null);
        return 0;
      }
      this.#keep(rec);
      try {
        ctl.say(`Updating ${services.join(', ')}.`);
        // The releases checked (and released, when held) are the ones deployed.
        const expect = images.filter((i): i is { image: string; from: string | null; to: string } => !!i.to).map((i) => ({ image: i.image, digest: i.to }));
        const code = await ctl.run(opScript(stack.target, 'update', services, { expect }));
        if (code !== 0) {
          // Pull failed: nothing changed. Up failed halfway: put back what changed.
          // Every service not as it was: on another image, but also gone,
          // fewer or stopped (only another image counted, and a service the
          // failed up took down was left so; AUDIT2 DO-02).
          const now = await readStack(this.monitor, hostId, project).catch(() => null);
          const changed = now ? before.filter((b) => !recovered(now.containers, before.filter((x) => x.service === b.service)).ok) : before;
          const back = changed.length ? await this.#rollback(ctl, stack.target, before.filter((b) => changed.some((c) => c.service === b.service))) : null;
          if (back?.ok) ctl.outcome({ kind: 'rolled_back', why: `docker compose ended with ${code}` });
          finish(back?.ok ? 'rolled_back' : 'failed', `docker compose ended with ${code}${back && !back.ok ? `; the rollback failed too (${back.why})` : ''}`, changed.length > 0);
          return code;
        }
        return await this.#settle(ctl, rec, stack.target, actor);
      } catch (err) {
        // Lost while it goes on on the host: kept, and finished when it can be
        // seen again (recover). Anything else ends it here, written down (a
        // thrown path left no history at all, AUDIT2 DO-05).
        if (!/goes on on the host/.test((err as Error).message)) finish('failed', (err as Error).message, false);
        throw err;
      }
    });
    return op;
  }

  /** After the update ran: watched; well, or the previous images back. */
  async #settle(ctl: JobControl, rec: PendingUpdate, target: Parameters<typeof rollbackScript>[0], actor: Actor, afterRestart = false): Promise<number> {
    const before = rec.before as ContainerInfo[];
    const counts = new Map<string, number>();
    for (const b of before) counts.set(b.service!, (counts.get(b.service!) ?? 0) + 1);
    const verdict = await this.#watch(ctl, rec.hostId, rec.project, rec.services, counts);
    if (verdict.ok) {
      ctl.say('Updated; the containers run well.');
      this.#record(rec, actor, 'updated', afterRestart ? 'seen after Burrow restarted during the update' : null);
      await this.checker.check([rec.hostId], rec.images.map((i) => i.image)).catch(() => {});
      return 0;
    }
    ctl.say(`Not well: ${verdict.why}. Putting the previous images back.`);
    const back = await this.#rollback(ctl, target, before);
    // Rolled back is how it ended, not "failed" (W-FUNC-10).
    if (back.ok) ctl.outcome({ kind: 'rolled_back', why: verdict.why });
    this.#record(rec, actor, back.ok ? 'rolled_back' : 'failed', back.ok ? verdict.why : `${verdict.why}; the rollback failed too (${back.why})`);
    return 1;
  }

  // ---- deploys, watched like updates (decision 11)

  #keepDeploy(rec: PendingDeploy): void {
    // This Burrow's own job watches it: never taken up again by a recovery round.
    this.#taken.add(`deploy ${rec.hostId} ${rec.project} ${rec.started}`);
    const rest = (getUpdateState(this.ctx).deploys ?? []).filter((p) => !(p.hostId === rec.hostId && p.project === rec.project));
    setUpdateState(this.ctx, { deploys: [...rest, rec] });
  }
  #forgetDeploy(rec: PendingDeploy): void {
    setUpdateState(this.ctx, { deploys: (getUpdateState(this.ctx).deploys ?? []).filter((p) => !(p.hostId === rec.hostId && p.project === rec.project && p.started === rec.started)) });
  }

  /**
   * `docker compose up` on a stack (a deploy from its review, or a plain
   * up), then the services it recreated watched as an update is: well, or
   * the previous deployment put back. Returns the job at once.
   */
  deploy(actor: Actor, stack: { target: StackTarget; containers: ContainerInfo[] }, opts: { services?: string[]; file?: string; reviewed?: string; content?: string | null; extra?: Record<string, string> } = {}): Op {
    const { target } = stack;
    const rec: PendingDeploy = {
      hostId: target.hostId,
      project: target.project,
      file: opts.file ?? null,
      content: opts.content ?? null,
      extra: opts.extra ?? {},
      before: stack.containers.filter((c) => c.service).map((c) => ({ ...keptContainer(c), id: c.id })),
      started: this.ctx.now(),
    };
    return this.runner.start(target, 'up', async (ctl) => {
      this.#keepDeploy(rec);
      try {
        const code = await ctl.run(opScript(target, 'up', opts.services, opts.reviewed ? { reviewed: opts.reviewed } : {}));
        if (code !== 0) {
          this.#forgetDeploy(rec);
          return code;
        }
        return await this.#settleDeploy(ctl, rec, target, actor);
      } catch (err) {
        // Lost while it goes on on the host: kept, and finished after a restart (recover).
        if (!/goes on on the host/.test((err as Error).message)) this.#forgetDeploy(rec);
        throw err;
      }
    });
  }

  /** After a deploy ran: the services it recreated watched; well (and its file kept as deployed), or the previous deployment back. */
  async #settleDeploy(ctl: JobControl, rec: PendingDeploy, target: StackTarget, actor: Actor): Promise<number> {
    try {
      // A read that fails is not "nothing recreated": that kept the deploy, unseen, as the one
      // deployed (the next diff's before, what a rollback puts back). Read again as a watch does, a
      // few in a row; still unreadable, it is not called well (audit 2026-11-05).
      let now: Awaited<ReturnType<typeof readStack>> | null = null;
      for (let i = 0; i < WATCH_MISSES && !now; i++) {
        if (i) await new Promise((r) => setTimeout(r, this.opts.pollMs));
        now = await readStack(this.monitor, rec.hostId, rec.project).catch(() => null);
      }
      const saved = () => {
        // What is now deployed (as reviewed): the "before" of the next diff, and what a rollback puts back.
        if (rec.file && rec.content !== null) saveStackRow(this.ctx, rec.hostId, rec.project, { deployedFile: rec.file, deployedContent: rec.content, deployedExtra: JSON.stringify(rec.extra ?? {}), deployedAt: this.ctx.now() });
      };
      if (!now) {
        const why = 'the stack cannot be read';
        ctl.say(`Not well: ${why}. Nothing was put back.`);
        ctl.outcome({ kind: 'not_well', why });
        audit(this.ctx, actor, 'stack.deploy_not_well', `${this.#hostName(rec.hostId)}/${rec.project}`, { detail: why });
        return 1;
      }
      const ids = new Set(rec.before.map((b) => b.id));
      const recreated = [...new Set(now.containers.filter((c) => c.service && !ids.has(c.id)).map((c) => c.service!))];
      if (!recreated.length) {
        saved();
        return 0;
      }
      const counts = new Map<string, number>();
      for (const c of now.containers) if (c.service && recreated.includes(c.service)) counts.set(c.service, (counts.get(c.service) ?? 0) + 1);
      const verdict = await this.#watch(ctl, rec.hostId, rec.project, recreated, counts);
      if (verdict.ok) {
        ctl.say('Deployed; the containers run well.');
        saved();
        return 0;
      }
      const host = { name: this.#hostName(rec.hostId) };
      const row = stackRow(this.ctx, rec.hostId, rec.project);
      const previous = row?.deployedFile && row.deployedContent !== null && target.configFiles.includes(row.deployedFile) ? { file: row.deployedFile, content: row.deployedContent } : null;
      if (!previous || previous.content.length > MAX_ROLLBACK_FILE) {
        const why = previous ? 'its compose file is too large to put back' : 'Burrow has not deployed this stack before and does not know its previous compose file';
        ctl.say(`Not well: ${verdict.why}. Nothing was put back: ${why}.`);
        ctl.outcome({ kind: 'not_well', why: verdict.why });
        audit(this.ctx, actor, 'stack.deploy_not_well', `${host.name}/${rec.project}`, { detail: verdict.why });
        return 1;
      }
      ctl.say(`Not well: ${verdict.why}. Putting the previous deployment back (${previous.file} as deployed ${new Date(row!.deployedAt ?? 0).toISOString()}); the file itself stays as it is.`);
      const back = rec.before.filter((b) => b.service && recreated.includes(b.service));
      const added = now.containers.filter((c) => c.service && recreated.includes(c.service) && !rec.before.some((b) => b.service === c.service)).map((c) => c.name);
      // Its other files and .env as deployed then, where they are still the stack's (deployed before this: none known).
      const known = (() => {
        try {
          return JSON.parse(row?.deployedExtra ?? '{}') as Record<string, string>;
        } catch {
          return {};
        }
      })();
      const env = target.workingDir ? `${target.workingDir.replace(/\/+$/, '')}/.env` : null;
      const others = Object.entries(known)
        .filter(([path, content]) => (target.configFiles.includes(path) || path === env) && path !== previous.file && content.length <= MAX_ROLLBACK_FILE)
        .map(([path, content]) => ({ path, content }));
      const rc = await ctl.run(deployRollbackScript(target, [{ path: previous.file, content: previous.content }, ...others], back.map((b) => ({ service: b.service!, ref: b.image, imageId: b.imageId })), added));
      let v: Verdict = rc === 0 ? { ok: true } : { ok: false, why: `exit ${rc}` };
      if (v.ok && back.length) {
        const bc = new Map<string, number>();
        for (const b of back) bc.set(b.service!, (bc.get(b.service!) ?? 0) + 1);
        const watched = await this.#watch(ctl, rec.hostId, rec.project, [...bc.keys()], bc);
        const after = watched.ok ? await readStack(this.monitor, rec.hostId, rec.project).catch(() => null) : null;
        v = !watched.ok ? watched : !after ? { ok: false, why: 'the stack cannot be read' } : recovered(after.containers, back as ContainerInfo[]);
      }
      ctl.say(v.ok ? 'The previous deployment runs again, and runs well.' : `The rollback failed (${v.why}).`);
      if (v.ok) ctl.outcome({ kind: 'rolled_back', why: verdict.why });
      audit(this.ctx, actor, v.ok ? 'stack.deploy_rollback' : 'stack.deploy_failed', `${host.name}/${rec.project}`, { detail: v.ok ? verdict.why : `${verdict.why}; the rollback failed too (${v.why})` });
      void this.notifier?.notify({
        topic: 'updates',
        title: `${rec.project} on ${host.name}: deploy ${v.ok ? 'rolled back' : 'failed'}`,
        body: v.ok ? verdict.why : `${verdict.why}; the rollback failed too (${v.why})`,
        page: `/stacks/${rec.hostId}/${encodeURIComponent(rec.project)}`,
        priority: 4,
        nl: { title: `${rec.project} op ${host.name}: uitrol ${v.ok ? 'teruggezet' : 'mislukt'}`, body: v.ok ? verdict.why : `${verdict.why}; ook terugzetten mislukte (${v.why})` },
      });
      return 1;
    } finally {
      this.#forgetDeploy(rec);
    }
  }

  /**
   * Updates Burrow was in the middle of when it stopped: once the operation
   * on the host is done, watched as any update, and rolled back when not
   * well. Kept for later when the stack cannot be read now.
   */
  async recover(waitMs = 10_000): Promise<void> {
    if (this.#recovering) return;
    this.#recovering = true;
    try {
      await this.#recover(waitMs);
    } finally {
      this.#recovering = false;
      this.#recoverable = true;
    }
  }

  async #recover(waitMs: number): Promise<void> {
    // Deploys first: one followed again (adoptRunning) is waited for; one that ended meanwhile, by its log's exit line (OPS-W-05).
    // Settled, not all: one that cannot start now (409, another job) held up the updates after it.
    await Promise.allSettled(
      (getUpdateState(this.ctx).deploys ?? []).map(async (rec) => {
        const key = `deploy ${rec.hostId} ${rec.project} ${rec.started}`;
        if (this.#taken.has(key)) return;
        this.#taken.add(key);
        const running = this.runner.running(rec.hostId, rec.project);
        // undefined: the host did not answer. Only an exit other than 0 ends it here; a host that
        // is down now (its exit or its stack unreadable) is no failed deploy: tried again next
        // minute, for a day, as an update is (it was forgotten, never watched; audit 2026-11-05).
        const code = running ? await running.done : await this.runner.lastExit(rec.hostId, rec.project).catch(() => undefined);
        if (typeof code === 'number' && code !== 0) return this.#forgetDeploy(rec);
        const stack = code === 0 ? await readStack(this.monitor, rec.hostId, rec.project).catch(() => null) : null;
        if (!stack) {
          if (this.ctx.now() - rec.started > RECOVER_FOR_MS) return this.#forgetDeploy(rec);
          this.#taken.delete(key);
          return;
        }
        this.runner.start(stack.target, 'up', async (ctl) => {
          ctl.say('Burrow restarted during this deploy; it ended well on the host. Watching the containers.');
          return this.#settleDeploy(ctl, rec, stack.target, SYSTEM);
        });
      }),
    );
    for (const rec of getUpdateState(this.ctx).pending ?? []) {
      // One that fails here (its host deleted) holds up none of the others.
      await this.#recoverUpdate(rec, waitMs).catch((err: Error) => this.ctx.log.warn({ hostId: rec.hostId }, `updates: taking up ${rec.project} after a restart: ${err.message}`));
    }
  }

  async #recoverUpdate(rec: PendingUpdate, waitMs: number): Promise<void> {
    const key = `update ${rec.hostId} ${rec.project} ${rec.started}`;
    if (this.#taken.has(key)) return;
    // Followed again after the restart: its end first.
    await this.runner.running(rec.hostId, rec.project)?.done;
    const stack = await readStack(this.monitor, rec.hostId, rec.project).catch(() => null);
    if (this.runner.running(rec.hostId, rec.project)) return;
    if (!stack) {
      // Tried again next minute; a stack gone for a day is written down as such.
      if (this.ctx.now() - rec.started > RECOVER_FOR_MS) this.#record(rec, SYSTEM, 'failed', 'after Burrow restarted: the stack could not be read for a day', false);
      return;
    }
    this.#taken.add(key);
    this.runner.start(stack.target, 'update', async (ctl) => {
      ctl.say('Burrow restarted during this update: checking how it went.');
      // The operation on the host first: done (it holds the stack's lock until then).
      for (let i = 0; ; i++) {
        try {
          await ctl.run('true');
          break;
        } catch (err) {
          if (!/still running/.test((err as Error).message) || i >= 720) {
            this.#record(rec, SYSTEM, 'failed', `after Burrow restarted: ${(err as Error).message}`, false);
            return 1;
          }
          await new Promise((w) => setTimeout(w, waitMs));
        }
      }
      return this.#settle(ctl, rec, stack.target, SYSTEM, true);
    });
  }

  /**
   * Puts the previous images back; rolled back only when they are seen
   * running again and stay well as long as an update is watched (healthy,
   * no restarts). Running once was enough, and an old image that was
   * unhealthy or kept starting was called recovered (AUDIT2 DO-01).
   */
  async #rollback(ctl: JobControl, target: Parameters<typeof rollbackScript>[0], before: ContainerInfo[]): Promise<Verdict> {
    const rc = await ctl.run(rollbackScript(target, before.map((c) => ({ ref: c.image, imageId: c.imageId, service: c.service! }))));
    let v: Verdict;
    if (rc !== 0) v = { ok: false, why: `exit ${rc}` };
    else {
      const services = [...new Set(before.map((b) => b.service!))];
      const counts = new Map<string, number>();
      for (const b of before) counts.set(b.service!, (counts.get(b.service!) ?? 0) + 1);
      const watched = await this.#watch(ctl, target.hostId, target.project, services, counts);
      const now = watched.ok ? await readStack(this.monitor, target.hostId, target.project).catch(() => null) : null;
      v = !watched.ok ? watched : !now ? { ok: false, why: 'the stack cannot be read' } : recovered(now.containers, before);
    }
    ctl.say(v.ok ? 'The previous images run again, and run well.' : `The rollback failed (${v.why}).`);
    return v;
  }

  async #watch(ctl: JobControl, hostId: number, project: string, services: string[], expected: Map<string, number>): Promise<Verdict> {
    ctl.say(`Watching the containers for ${Math.round(this.opts.settleMs / 1000)} s.`);
    // Real time, not the (test) clock: this is about waiting.
    const start = performance.now();
    // One read that fails (a busy host's docker ps, a channel refused) is not a
    // broken update: only reads failing in a row roll it back (gate 2026-10-23).
    let misses = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, this.opts.pollMs));
      const elapsed = performance.now() - start;
      const s = await readStack(this.monitor, hostId, project).catch(() => null);
      if (!s) {
        if (++misses < WATCH_MISSES) continue;
        return { ok: false, why: 'the stack cannot be read' };
      }
      misses = 0;
      const v = judge(s.containers, services, false, expected);
      if (v && !v.ok) return v;
      if (elapsed < this.opts.settleMs) continue;
      // Settled, unless a healthcheck is still starting: then wait a little longer.
      const settled = judge(s.containers, services, elapsed >= this.opts.settleMs + this.opts.healthWaitMs, expected);
      if (settled) return settled;
    }
  }

  // ---- the maintenance window

  start(): void {
    // A tick that throws is said; the next minute's comes all the same.
    this.#timer = setInterval(() => void this.tick().catch((err: Error) => this.ctx.log.warn(`updates: the maintenance window check failed: ${err.message}`)), 60_000);
    this.#timer.unref();
    // Operations still running on the hosts (started before a restart) followed again,
    // then updates and deploys left in the middle finished: once the hosts can be read again (OPS-W-05).
    setTimeout(
      () =>
        void this.runner
          .adoptRunning(this.#dockerHosts().map((h) => h.id))
          .then(() => this.recover())
          .catch((err: Error) => this.ctx.log.warn(`updates: recovering after a restart: ${err.message}`)),
      30_000,
    ).unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  async tick(now = this.ctx.now()): Promise<void> {
    if (this.#recoverable && (getUpdateState(this.ctx).pending?.length || getUpdateState(this.ctx).deploys?.length)) void this.recover().catch((err: Error) => this.ctx.log.warn(`updates: recovering after a restart: ${err.message}`));
    if (this.#windowRunning) return;
    const s = getUpdateSettings(this.ctx);
    if (!s.enabled) return;
    const w = inWindow(now, s);
    if (!w.inside || getUpdateState(this.ctx).lastWindowDay === w.day) return;
    setUpdateState(this.ctx, { lastWindowDay: w.day });
    const t0 = performance.now();
    await this.runWindow(() => inWindow(now + (performance.now() - t0), s).inside);
  }

  /**
   * A message on the channels (topic "updates") for updates found since the
   * last one: each update once, whatever the check that found it.
   */
  tellNew(): void {
    const found = this.checker.list().filter((c) => c.status === 'update' && c.remoteDigest);
    const key = (c: (typeof found)[number]) => `${c.hostId} ${c.image} ${c.remoteDigest}`;
    const told = new Set(getUpdateState(this.ctx).notified ?? []);
    const fresh = found.filter((c) => !told.has(key(c)));
    // Keep only what is still an update: the list does not grow forever.
    setUpdateState(this.ctx, { notified: found.map(key) });
    if (!fresh.length || !this.notifier) return;
    const names = new Map(this.ctx.db.select().from(hosts).all().map((h) => [h.id, h.name]));
    const lines = fresh.map((c) => `${c.image} (${names.get(c.hostId) ?? c.hostId})`);
    void this.notifier.notify({
      topic: 'updates',
      title: `${plural(fresh.length, 'image update', 'image updates')} available`,
      body: lines.join('\n'),
      page: '/containers',
      priority: 3,
      nl: { title: `${plural(fresh.length, 'image-update', 'image-updates')} beschikbaar`, body: lines.join('\n') },
      data: { updates: fresh.map((c) => ({ hostId: c.hostId, image: c.image })) },
    });
  }

  /**
   * A message (topic "updates") for newer versions under another tag found
   * since the last one: each once. Never updated by itself: a new version
   * is a choice, made in the compose file.
   */
  tellNewTags(): void {
    const found = this.checker.list().filter((c) => c.newerTag);
    const key = (c: (typeof found)[number]) => `${c.hostId} ${c.image} ${c.newerTag}`;
    const told = new Set(getUpdateState(this.ctx).notifiedTags ?? []);
    const fresh = found.filter((c) => !told.has(key(c)));
    setUpdateState(this.ctx, { notifiedTags: found.map(key) });
    if (!fresh.length || !this.notifier) return;
    const names = new Map(this.ctx.db.select().from(hosts).all().map((h) => [h.id, h.name]));
    const lines = fresh.map((c) => `${c.image} -> ${c.newerTag} (${names.get(c.hostId) ?? c.hostId})`);
    void this.notifier.notify({
      topic: 'updates',
      title: `${plural(fresh.length, 'newer version', 'newer versions')} available`,
      body: lines.join('\n'),
      page: '/containers',
      priority: 2,
      nl: { title: `${plural(fresh.length, 'nieuwere versie', 'nieuwere versies')} beschikbaar`, body: lines.join('\n') },
      data: { versions: fresh.map((c) => ({ hostId: c.hostId, image: c.image, tag: c.newerTag })) },
    });
  }

  #dockerHosts() {
    return this.ctx.db.select().from(hosts).all().filter((h) => h.facts && (JSON.parse(h.facts) as { hasDocker?: boolean }).hasDocker);
  }

  /** The window's work: check every Docker host, then update the stacks that opted in. */
  async runWindow(stillInWindow: () => boolean = () => true): Promise<StackUpdate[]> {
    if (this.#windowRunning) return [];
    this.#windowRunning = true;
    const done: StackUpdate[] = [];
    try {
      const dockerHosts = this.#dockerHosts();
      await this.checker.check(dockerHosts.map((h) => h.id));
      this.tellNew();
      this.tellNewTags();
      // Check and tell only: the stacks that opted in wait.
      const settings = getUpdateSettings(this.ctx);
      if (!settings.autoUpdate) return done;
      const opted = this.ctx.db.select().from(stacks).where(eq(stacks.autoUpdate, true)).all();
      for (const st of opted) {
        if (!stillInWindow()) {
          this.ctx.log.info('updates: the maintenance window closed; the other stacks wait for the next one');
          break;
        }
        try {
          const s = await readStack(this.monitor, st.hostId, st.project);
          if (isSelf(s.containers)) continue;
          // burrow.update=manual: checked and told, never updated by itself.
          const manual = new Set(s.containers.filter((c) => c.updateManual && c.service).map((c) => c.service!));
          const checks = this.checker.list(st.hostId);
          // A version rolled back before: not again by itself; a newer digest in the registry is tried (W-FUNC-03).
          const known = new Set(checks.filter((c) => c.status === 'update' && rolledBackAt(this.ctx, st.hostId, c.image, c.remoteDigest)).map((c) => c.image));
          const skipped = s.containers.filter((c) => c.service && known.has(c.image)).map((c) => c.service!);
          if (skipped.length) this.ctx.log.info({ hostId: st.hostId }, `updates: ${st.project}: ${[...known].join(', ')} was rolled back before; not updated to it again by itself`);
          const services = this.servicesWithUpdate(s.containers, checks).filter((x) => !manual.has(x) && !skipped.includes(x));
          if (!services.length) continue;
          const going = s.containers.filter((c) => c.service && services.includes(c.service));
          // A breaking change in between: not by itself, a person reads first.
          const held = await this.breakingIn(st.hostId, going);
          // Released after reading: this set of releases goes; a new one holds again.
          if (held.length && !this.isReleased(st.hostId, st.project, held)) {
            this.#tellHeld(st.hostId, st.project, held);
            continue;
          }
          // Only up to the step allowed (patch, minor); unknown waits too.
          if (settings.autoLevel !== 'major') {
            const level = await this.levelIn(st.hostId, going);
            if (level === null || levelRank(level) > levelRank(settings.autoLevel)) {
              this.#tellLevel(st.hostId, st.project, level, settings.autoLevel);
              continue;
            }
          }
          const since = this.ctx.now();
          const op = await this.update(SYSTEM, st.hostId, st.project, true, services);
          await op.done;
          // This stack's own row of this update; none when it wrote none (a lost connection), not the newest of another.
          const last = this.ctx.db
            .select()
            .from(stackUpdates)
            .where(and(eq(stackUpdates.hostId, st.hostId), eq(stackUpdates.project, st.project), gte(stackUpdates.startedAt, since)))
            .orderBy(desc(stackUpdates.id))
            .limit(1)
            .get();
          if (last) done.push(toUpdate(last));
        } catch (err) {
          this.ctx.log.warn({ hostId: st.hostId }, `updates: ${st.project}: ${(err as Error).message}`);
        }
      }
    } finally {
      this.#windowRunning = false;
    }
    return done;
  }
}
