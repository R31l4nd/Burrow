import { randomBytes } from 'node:crypto';
import type { Client } from 'ssh2';
import type { OpInfo, OpOutcome, OpServerMessage, StackOp } from '@burrow/shared';
import type { Ctx } from '../context.js';
import type { SftpPool } from '../files/pool.js';
import { HttpError } from '../http.js';
import { endsWithChannel, exec, execChannel } from '../ssh/connect.js';
import { shellQuote } from '../ssh/quote.js';

// Compose operations (up, pull, down, updates, rollbacks) run on the host
// apart from Burrow: started with setsid and nohup, output into a file that
// Burrow follows. A dropped connection or a restart of Burrow, even when the
// operation recreates Burrow's own container, does not break them off.

const EXIT_MARK = '@@burrow-exit ';
const MAX_BUFFER = 1 << 20;

export interface StackTarget {
  hostId: number;
  project: string;
  workingDir: string | null;
  configFiles: string[];
}

const q = (s: string) => (/^[\w.:/@+-]+$/.test(s) ? s : shellQuote(s));

/** `docker compose` as a shell function, or the old docker-compose. */
const COMPOSE_FN = [
  'if docker compose version >/dev/null 2>&1; then dc() { docker compose --ansi never "$@"; }',
  'elif command -v docker-compose >/dev/null 2>&1; then dc() { docker-compose --ansi never "$@"; }',
  "else echo 'docker compose is not installed on this host.'; exit 127; fi",
].join('\n');

/** The compose command line for a stack (project name and its files). */
export function composeArgs(t: StackTarget): string {
  return ['-p', q(t.project), ...t.configFiles.flatMap((f) => ['-f', q(f)])].join(' ');
}

/** The compose function, in the stack's directory. */
export function prelude(t: StackTarget): string {
  return [COMPOSE_FN, t.workingDir ? `cd ${q(t.workingDir)} || exit 1` : ''].filter(Boolean).join('\n');
}

/**
 * The shell script of an operation; runs in the stack's directory. An
 * update given the digests that were checked deploys only those: a tag
 * moved in the registry since (another release) stops it after the pull,
 * before anything is recreated (AUDIT2 DO-07). An up from a review deploys
 * only the configuration reviewed (DO-12).
 */
export function opScript(t: StackTarget, op: StackOp, services: string[] = [], opts: { expect?: { image: string; digest: string }[]; reviewed?: string } = {}): string {
  const dc = `dc ${composeArgs(t)}`;
  const svc = services.map(q).join(' ');
  const expect = opts.expect ?? [];
  const verify = expect.map(
    (e) => `{ docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' ${q(e.image)} | grep -qF -- ${q(`@${e.digest}`)} || { echo ${q(`${e.image} moved since it was checked (not ${e.digest.slice(0, 19)}); nothing deployed. Check again.`)}; exit 3; }; }`,
  );
  const body: Record<StackOp, string> = {
    // From a review: the configuration checked once more right before up, on
    // the host, so a change after the review (an editor, a .env) is not
    // deployed unseen (AUDIT2 DO-12).
    up: opts.reviewed
      ? `[ "$(${dc} config | sha256sum | cut -d' ' -f1)" = ${q(opts.reviewed)} ] || { echo 'The compose files changed since the review; nothing deployed. Review again.'; exit 4; }; ${dc} up -d ${svc}`
      : `${dc} up -d ${svc}`,
    pull: `${dc} pull ${svc}`,
    // Only the chosen services: up recreated a dependency (a manually
    // updated one, a shared tag) outside what was watched (AUDIT2 DO-03).
    update: [`${dc} pull ${svc}`, ...verify, `${dc} up -d ${services.length ? '--no-deps ' : ''}${svc}`].join(' && '),
    restart: `${dc} restart ${svc}`,
    down: `${dc} down`,
  };
  return [prelude(t), `echo ${shellQuote(`$ ${op} ${t.project}`)}`, body[op].trim()].join('\n');
}

/**
 * Put images back: each tag points to the image the container ran before,
 * then compose recreates those services without pulling and without their
 * dependencies. A tag that two services ran as different images cannot
 * point at both (retagging restored only one of them, AUDIT2 DO-04): those
 * services are pinned to their exact image by id, in an override for this
 * rollback only. Only then: a container pinned by id shows that id as its
 * image, and the update check no longer knows it by its tag.
 */
export function rollbackScript(t: StackTarget, images: { ref: string; imageId: string; service: string }[]): string {
  const lines = [prelude(t), `echo ${shellQuote(`$ rollback ${t.project}`)}`];
  const idsOf = new Map<string, Set<string>>();
  for (const i of images) idsOf.set(i.ref, (idsOf.get(i.ref) ?? new Set()).add(i.imageId));
  for (const [ref, ids] of idsOf) if (ids.size === 1) lines.push(`docker tag ${q([...ids][0]!)} ${q(ref)} || exit 1`);
  const pinned = new Map<string, string>();
  for (const i of images) if (idsOf.get(i.ref)!.size > 1 && !pinned.has(i.service)) pinned.set(i.service, i.imageId);
  let override = '';
  if (pinned.size) {
    const yaml = ['services:', ...[...pinned].flatMap(([svc, id]) => [`  "${svc}":`, `    image: ${id}`])].join('\n');
    lines.push('o=$(mktemp /tmp/burrow-rollback.XXXXXX) || exit 1', 'trap \'rm -f "$o"\' EXIT', `printf '%s\\n' ${q(yaml)} > "$o"`);
    override = ' -f "$o"';
  }
  lines.push(`dc ${composeArgs(t)}${override} up -d --no-deps --pull never ${[...new Set(images.map((i) => q(i.service)))].join(' ')}`);
  return lines.join('\n');
}

/** The exit code of a start refused because the stack is still busy on the host. */
export const BUSY_EXIT = 75;

/**
 * Starts `script` detached; prints the log file's path. Its process id is
 * kept beside the log, named by the stack (`tag`): while an earlier one for
 * that stack still runs on the host (started before Burrow restarted, or
 * its output no longer followed), this one is refused there, so two never
 * run at once (audit BE-14). Ends with BUSY_EXIT and the other's log then.
 */
export function detachScript(id: string, script: string, tag = 'op'): string {
  const inner = `( ${script}\n); echo "${EXIT_MARK}$?"`;
  const safe = tag.replace(/[^A-Za-z0-9_.-]/g, '_');
  // "@" is in no stack's name: "web--x" was also one of stack "web-"'s files, so "web" waited for it.
  const name = `${safe}@${id}`;
  return [
    'd="${XDG_CACHE_HOME:-$HOME/.cache}/burrow/ops"',
    'mkdir -p "$d" || exit 1',
    'find "$d" \\( -name "*.log" -o -name "*.pid" \\) -mtime +7 -exec rm -f {} + 2>/dev/null',
    // Looking and starting as one step (mkdir is atomic): two starts at once, from two host
    // entries for one machine, both found none running (AUDIT2 DO-21). Held for a moment only;
    // one left by a start that died is taken after a minute.
    `l="$d/${safe}.lock"`,
    'i=0',
    'until mkdir "$l" 2>/dev/null; do',
    '  i=$((i+1))',
    '  if [ $i -gt 100 ]; then [ -n "$(find "$l" -maxdepth 0 -mmin +1 2>/dev/null)" ] && { rm -rf "$l"; continue; }; echo "Another start of this stack is under way on the host."; exit 1; fi',
    '  sleep 0.1 2>/dev/null || sleep 1',
    'done',
    `trap 'rmdir "$l" 2>/dev/null' EXIT`,
    // Another one for this stack, alive and not finished: refused.
    // Also the "--" of before (a job of an older Burrow may still run).
    `for p in "$d"/${safe}@*.pid "$d"/${safe}--*.pid; do`,
    '  [ -e "$p" ] || continue',
    `  grep -q '^${EXIT_MARK}' "\${p%.pid}.log" 2>/dev/null && continue`,
    `  kill -0 "$(cat "$p")" 2>/dev/null && { echo "\${p%.pid}.log"; exit ${BUSY_EXIT}; }`,
    'done',
    `f="$d/${name}.log"`,
    `s=${shellQuote(inner)}`,
    'if command -v setsid >/dev/null 2>&1; then setsid nohup sh -c "$s" >"$f" 2>&1 </dev/null & else nohup sh -c "$s" >"$f" 2>&1 </dev/null & fi',
    `echo $! >"$d/${name}.pid"`,
    'echo "$f"',
  ].join('\n');
}

/**
 * Prints the log as it grows, until the exit line is printed. By byte
 * counts rather than `tail -f`, which may not have printed the last line
 * yet when it is stopped.
 */
export function followScript(file: string, from = 0): string {
  const f = shellQuote(file);
  return [
    `n=${Math.max(0, Math.floor(from))}`,
    'while :; do',
    `  s=$(wc -c < ${f}) || exit 1`,
    `  if [ "$s" -gt "$n" ]; then tail -c +$((n + 1)) ${f} | head -c $((s - n)); n=$s; fi`,
    `  grep -q '^${EXIT_MARK}' ${f} && [ "$(wc -c < ${f})" -eq "$n" ] && break`,
    '  sleep 0.3',
    'done',
  ].join('\n');
}

type Listener = (m: OpServerMessage) => void;

export interface JobControl {
  /** Runs a script detached on the host and follows it; resolves with its exit code. */
  run(script: string): Promise<number>;
  /** A line of Burrow's own in the output. */
  say(line: string): void;
  /** How it ended beyond its exit code (a rollback that worked is not "failed", W-FUNC-10). */
  outcome(o: OpOutcome): void;
}

const OP_KINDS: OpInfo['op'][] = ['up', 'pull', 'update', 'restart', 'down', 'rollback'];

/**
 * The operations still running on a host, from their files: each running
 * one's log, when its pid file was written (s), and the log's first
 * "$ <op> <project>" line, tab-separated (OPS-W-05).
 */
export function runningOpsScript(): string {
  return [
    'd="${XDG_CACHE_HOME:-$HOME/.cache}/burrow/ops"',
    'for p in "$d"/*@*.pid "$d"/*--*.pid; do',
    '  [ -e "$p" ] || continue',
    '  l="${p%.pid}.log"',
    `  grep -q '^${EXIT_MARK}' "$l" 2>/dev/null && continue`,
    '  kill -0 "$(cat "$p")" 2>/dev/null || continue',
    `  printf '%s\t%s\t%s\n' "$l" "$(stat -c %Y "$p" 2>/dev/null || echo 0)" "$(grep -m1 '^[$] ' "$l" 2>/dev/null)"`,
    'done',
  ].join('\n');
}

/** Parses runningOpsScript's lines: the log, the stack (from the file's name), the kind and when it started. */
export function parseRunningOps(out: string): { file: string; project: string; op: OpInfo['op']; startedAt: number }[] {
  return out
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const [file = '', at = '0', first = ''] = line.split('\t');
      // "<stack>@<id>.log"; "<stack>--<id>.log" from an older Burrow.
      const m = /\/([^/@]+)@[^/@]+\.log$/.exec(file) ?? /\/([^/]+)--[^/]+\.log$/.exec(file);
      if (!m) return [];
      const kind = /^\$ (\w+) /.exec(first)?.[1] as OpInfo['op'] | undefined;
      return [{ file, project: m[1]!, op: kind && OP_KINDS.includes(kind) ? kind : 'up', startedAt: Number(at) * 1000 }];
    });
}

/** The exit code in the newest log of a stack's operations, or null (none, or not ended). */
export function lastExitScript(project: string): string {
  const safe = project.replace(/[^A-Za-z0-9_.-]/g, '_');
  return [
    'd="${XDG_CACHE_HOME:-$HOME/.cache}/burrow/ops"',
    `f=$(ls -t "$d"/${safe}@*.log "$d"/${safe}--*.log 2>/dev/null | head -1)`,
    `[ -n "$f" ] && grep '^${EXIT_MARK}' "$f" | tail -1`,
    'true',
  ].join('\n');
}

export class Op {
  readonly info: OpInfo;
  output = '';
  readonly #listeners = new Set<Listener>();
  readonly done: Promise<number>;
  /** When it ended (Date.now), for the quiet time after it. */
  endedAt: number | null = null;
  outcome: OpOutcome | null = null;
  #finish!: (code: number) => void;

  constructor(info: OpInfo) {
    this.info = info;
    this.done = new Promise((r) => (this.#finish = r));
  }

  listen(fn: Listener): () => void {
    if (this.output) fn({ t: 'output', d: this.output });
    if (this.info.exitCode !== null) fn({ t: 'exit', code: this.info.exitCode, ...(this.outcome ? { outcome: this.outcome } : {}) });
    else this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  push(d: string): void {
    this.output = (this.output + d).slice(-MAX_BUFFER);
    for (const fn of this.#listeners) fn({ t: 'output', d });
  }

  end(code: number, error?: string): void {
    if (this.info.exitCode !== null) return;
    if (error) {
      this.push(`\n${error}\n`);
      for (const fn of this.#listeners) fn({ t: 'error', message: error });
    }
    this.info.exitCode = code;
    this.endedAt = Date.now();
    for (const fn of this.#listeners) fn({ t: 'exit', code, ...(this.outcome ? { outcome: this.outcome } : {}) });
    this.#listeners.clear();
    this.#finish(code);
  }
}

const newId = () => randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x');

/** Operations by id; one at a time per stack. Finished ones are kept for a while to be looked at. */
export class OpRunner {
  readonly #ops = new Map<string, Op>();
  /** Logs on the hosts being followed now ("hostId file"): one follower each. */
  readonly #followed = new Set<string>();

  constructor(
    private readonly ctx: Ctx,
    private readonly pool: SftpPool,
  ) {}

  get(id: string): Op | undefined {
    return this.#ops.get(id);
  }

  /** The operations still running, on any stack (for the "busy" pill). */
  list(): OpInfo[] {
    return [...this.#ops.values()].filter((o) => o.info.exitCode === null).map((o) => o.info);
  }

  /** After an operation: how long its stack's containers settle before an alert counts again. */
  quietMs = 120_000;
  /** Waits between following a lost operation's output again (longer each time). */
  refollowMs = 5000;

  /**
   * Burrow itself is working on this stack (an update, a deploy, a restart,
   * a rollback) or just was: what its containers do now is Burrow's doing,
   * not news (Uptime Kuma's maintenance windows). The update's own result
   * says whether it went well.
   */
  quiet(hostId: number, project: string): boolean {
    const now = Date.now();
    for (const op of this.#ops.values()) {
      if (op.info.hostId !== hostId || op.info.project !== project) continue;
      if (op.info.exitCode === null || (op.endedAt !== null && now - op.endedAt < this.quietMs)) return true;
    }
    return false;
  }

  running(hostId: number, project: string): Op | undefined {
    for (const op of this.#ops.values()) if (op.info.hostId === hostId && op.info.project === project && op.info.exitCode === null) return op;
    return undefined;
  }

  /**
   * Starts a job on a stack: one or more scripts run detached on the host
   * (`run`), with notes of Burrow's own in between (`say`), as one output.
   * Returns at once; `op.done` resolves with the exit code.
   */
  start(t: StackTarget, kind: OpInfo['op'], job: (ctl: JobControl) => Promise<number>): Op {
    if (this.running(t.hostId, t.project)) throw new HttpError(409, 'op_running', 'Another operation on this stack is still running.');
    const id = newId();
    const op = new Op({ id, hostId: t.hostId, project: t.project, op: kind, startedAt: new Date(this.ctx.now()).toISOString(), exitCode: null });
    this.#ops.set(id, op);
    this.#prune();
    let n = 0;
    const ctl: JobControl = {
      say: (line) => op.push(`${line}\n`),
      run: (script) => this.#run(t, `${id}-${++n}`, script, op),
      outcome: (o) => (op.outcome = o),
    };
    this.ctx.log.info({ hostId: t.hostId, op: kind }, `docker: ${kind} ${t.project} started`);
    void job(ctl).then(
      (code) => {
        this.ctx.log[code === 0 ? 'info' : 'warn']({ hostId: t.hostId, op: kind, code }, `docker: ${kind} ${t.project} ended with ${code}`);
        op.end(code);
      },
      (err: Error) => {
        this.ctx.log.warn({ hostId: t.hostId, op: kind }, `docker: ${kind} ${t.project} failed: ${err.message}`);
        op.end(1, err.message);
      },
    );
    return op;
  }

  /** One script, detached on the host; its output goes into the op. */
  async #run(t: StackTarget, id: string, script: string, op: Op): Promise<number> {
    const r = await this.pool.with(t.hostId, ({ client }) => exec(client, detachScript(id, script, t.project), 20_000));
    const file = r.stdout.trim().split('\n').pop() ?? '';
    if (r.code === BUSY_EXIT) {
      // One started before Burrow restarted (or no longer followed): shown again, in Activity and on the stack (OPS-W-05).
      const other = await this.adoptRunning([t.hostId]);
      throw new Error(`Another operation on this stack is still running on the host (${file})${other.length ? '; it is shown under Activity now' : ''}. Try again when it is done.`);
    }
    if (r.code !== 0 || !file) throw new Error(`Could not start on the host: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
    return this.#followFile(t.hostId, file, op);
  }

  /** Follows a log on the host to its exit line; again from where it was when the connection drops, a few times. */
  async #followFile(hostId: number, file: string, op: Op): Promise<number> {
    const key = `${hostId} ${file}`;
    this.#followed.add(key);
    try {
      let lastErr: Error | null = null;
      // Bytes of the log already shown: a follow again goes on from there.
      const seen = { bytes: 0 };
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await new Promise((w) => setTimeout(w, this.refollowMs * attempt));
        try {
          return await this.pool.with(hostId, ({ client }) => this.#follow(client, file, op, seen));
        } catch (err) {
          lastErr = err as Error;
        }
      }
      throw new Error(`Lost the connection; the operation goes on on the host (${file}): ${lastErr?.message ?? ''}`, { cause: lastErr });
    } finally {
      this.#followed.delete(key);
    }
  }

  /**
   * An operation running on the host that this Burrow did not start (or no
   * longer follows: it restarted meanwhile): followed from its log's start,
   * listed like the others. Null when it is followed already.
   */
  adopt(hostId: number, project: string, file: string, kind: OpInfo['op'] = 'up', startedAt = this.ctx.now()): Op | null {
    if (this.#followed.has(`${hostId} ${file}`)) return null;
    const id = newId();
    const op = new Op({ id, hostId, project, op: kind, startedAt: new Date(startedAt).toISOString(), exitCode: null });
    this.#ops.set(id, op);
    this.#prune();
    op.push('Started before Burrow restarted: following it on the host.\n');
    this.ctx.log.info({ hostId, op: kind }, `docker: following ${kind} ${project}, still running on the host`);
    void this.#followFile(hostId, file, op).then(
      (code) => op.end(code),
      (err: Error) => op.end(1, err.message),
    );
    return op;
  }

  /** Every operation still running on these hosts, followed again (after a restart of Burrow, OPS-W-05). */
  async adoptRunning(hostIds: number[]): Promise<Op[]> {
    const found = await Promise.all(
      hostIds.map((hostId) =>
        this.pool
          .with(hostId, ({ client }) => exec(client, runningOpsScript(), 20_000))
          .then((r) => parseRunningOps(r.stdout).map((x) => ({ hostId, ...x })))
          .catch((err: Error) => (this.ctx.log.warn({ hostId }, `docker: cannot look for running operations: ${err.message}`), [])),
      ),
    );
    return found.flat().flatMap((x) => [this.adopt(x.hostId, x.project, x.file, x.op, x.startedAt || this.ctx.now())].filter((o): o is Op => !!o));
  }

  /** The exit code of a stack's newest operation on the host; null when none ended (or none is there). */
  async lastExit(hostId: number, project: string): Promise<number | null> {
    const r = await this.pool.with(hostId, ({ client }) => exec(client, lastExitScript(project), 20_000));
    const m = new RegExp(`^${EXIT_MARK}(\\d+)`, 'm').exec(r.stdout);
    return m ? Number(m[1]) : null;
  }

  #follow(client: Client, file: string, op: Op, seen: { bytes: number }): Promise<number> {
    return new Promise((resolve, reject) => {
      void execChannel(client, endsWithChannel(followScript(file, seen.bytes))).then((ch) => {
        const dec = new TextDecoder();
        let pending = '';
        let code: number | null = null;
        const onData = (b: Buffer) => {
          pending += dec.decode(b, { stream: true });
          const nl = pending.lastIndexOf('\n');
          if (nl < 0) return;
          const chunk = pending.slice(0, nl + 1);
          pending = pending.slice(nl + 1);
          // Whole lines only count as seen: a cut-off line comes again in full.
          seen.bytes += Buffer.byteLength(chunk);
          const shown = chunk.replace(new RegExp(`^${EXIT_MARK}(\\d+)\\n`, 'm'), (_m, c: string) => {
            code = Number(c);
            return '';
          });
          if (shown) op.push(shown);
        };
        ch.on('data', onData);
        // The follow script's own complaints: shown, not part of the log.
        ch.stderr.on('data', (b: Buffer) => op.push(b.toString()));
        ch.on('close', () => {
          if (code === null) return reject(new Error('the output stopped without an exit code'));
          // A last line without its newline; when cut off, it comes again on the next follow.
          if (pending) op.push(pending);
          resolve(code);
        });
      }, reject);
    });
  }

  #prune(): void {
    const done = [...this.#ops.values()].filter((o) => o.info.exitCode !== null);
    for (const o of done.slice(0, Math.max(0, done.length - 50))) this.#ops.delete(o.info.id);
  }
}
