import { createRequire } from "node:module";
import {
  Client,
  type ClientChannel,
  type ConnectConfig,
  type ExecOptions,
  type ServerHostKeyAlgorithm,
} from "ssh2";
import type { ConnectResult, HostFacts } from "@burrow/shared";
import type { Ctx } from "../context.js";
import {
  judgeHostKey,
  preferredHostKeyAlgorithms,
  storedKeys,
  type HostKeyVerdict,
} from "./knownhosts.js";

/** A command on a host that did not end in time (its channel closed). The message as it always was: logs and tests read it. */
export class CommandTimeout extends Error {
  constructor(readonly ms: number) {
    super(`command timed out after ${ms} ms`);
  }
}

export type SshAuth =
  | { type: "key"; privateKey: string; passphrase?: string | undefined }
  | { type: "password"; password: string };

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
}

export type Failure = Exclude<ConnectResult, { status: "ok" }>;

const READY_TIMEOUT_MS = 12_000;

// ssh2's own default and supported host-key algorithm lists. Its `prepend`
// option skips algorithms already in the default list, so to put a trusted
// type first the whole list has to be passed.
const { DEFAULT_SERVER_HOST_KEY, SUPPORTED_SERVER_HOST_KEY } = createRequire(
  import.meta.url,
)("ssh2/lib/protocol/constants.js") as {
  DEFAULT_SERVER_HOST_KEY: ServerHostKeyAlgorithm[];
  SUPPORTED_SERVER_HOST_KEY: ServerHostKeyAlgorithm[];
};

/** Offer the already-trusted key types first, so the host presents a key we know. */
export function hostKeyOrder(knownTypes: string[]): ServerHostKeyAlgorithm[] {
  const first = preferredHostKeyAlgorithms(knownTypes).filter(
    (a): a is ServerHostKeyAlgorithm =>
      SUPPORTED_SERVER_HOST_KEY.includes(a as ServerHostKeyAlgorithm),
  );
  return [...new Set([...first, ...DEFAULT_SERVER_HOST_KEY])];
}

/**
 * Open an authenticated connection, enforcing the known-hosts policy. The
 * caller owns the returned client and must end() it.
 */
export function openSsh(
  ctx: Ctx,
  target: SshTarget,
): Promise<{ client: Client } | Failure> {
  return new Promise((resolve) => {
    const client = new Client();
    let verdict: HostKeyVerdict | null = null;
    let settled = false;
    const started = Date.now();
    const who = `${target.username}@${target.host}:${target.port}`;
    const done = (r: { client: Client } | Failure) => {
      if (settled) return;
      settled = true;
      if ("client" in r) {
        ctx.log.debug({ ms: Date.now() - started }, `ssh ${who} connected`);
        client.on("close", () => ctx.log.debug(`ssh ${who} closed`));
      } else {
        ctx.log.warn(
          {
            status: r.status,
            ...("message" in r ? { reason: r.message } : {}),
          },
          `ssh ${who} failed: ${r.status}`,
        );
        client.end();
      }
      resolve(r);
    };

    const known = storedKeys(ctx, target.host, target.port).map(
      (r) => r.keyType,
    );
    const cfg: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: 15_000,
      hostVerifier: (key: Buffer) => {
        verdict = judgeHostKey(ctx, target.host, target.port, key);
        return verdict.kind === "trusted";
      },
      ...(known.length
        ? { algorithms: { serverHostKey: hostKeyOrder(known) } }
        : {}),
    };
    if (target.auth.type === "key") {
      cfg.privateKey = target.auth.privateKey;
      if (target.auth.passphrase) cfg.passphrase = target.auth.passphrase;
    } else {
      cfg.password = target.auth.password;
      // Many hosts only offer keyboard-interactive for passwords.
      cfg.tryKeyboard = true;
      const pw = target.auth.password;
      client.on("keyboard-interactive", (_n, _i, _l, prompts, finish) =>
        finish(prompts.map(() => pw)),
      );
    }

    // Nagle on this side with the host's delayed ACK held every small
    // request (an SFTP stat, a key typed in a terminal) about 40 ms for the
    // ACK of the one before (OPS-W-01).
    client.on("ready", () => {
      client.setNoDelay(true);
      done({ client });
    });
    client.on("error", (err: Error & { level?: string }) => {
      const v = verdict as HostKeyVerdict | null;
      if (v?.kind === "unknown") {
        done({
          status: "unknown_host_key",
          keyType: v.keyType,
          fingerprint: v.fingerprint,
        });
      } else if (v?.kind === "mismatch") {
        done({
          status: "host_key_mismatch",
          keyType: v.keyType,
          fingerprint: v.fingerprint,
          knownFingerprint: v.knownFingerprint,
        });
      } else if (err.level === "client-authentication") {
        done({
          status: "auth_failed",
          message: "The host rejected the credentials.",
        });
      } else if (
        err.level === "client-socket" ||
        err.level === "client-timeout"
      ) {
        done({ status: "unreachable", message: err.message });
      } else {
        done({ status: "error", message: err.message });
      }
    });
    client.on("close", () =>
      done({ status: "error", message: "Connection closed during handshake." }),
    );
    try {
      client.connect(cfg);
      // The handshake's round trips too.
      client.setNoDelay(true);
    } catch (err) {
      // ssh2 throws synchronously for an unparseable key or passphrase.
      done({ status: "error", message: (err as Error).message });
    }
  });
}

/**
 * Fetch the host key without authenticating: the handshake stops as soon as
 * the key is seen. Used to confirm that the key being trusted is the one the
 * user was shown.
 */
export function probeHostKey(
  host: string,
  port: number,
): Promise<Buffer | Failure> {
  return new Promise((resolve) => {
    const client = new Client();
    let key: Buffer | null = null;
    let settled = false;
    const done = (r: Buffer | Failure) => {
      if (settled) return;
      settled = true;
      client.end();
      resolve(r);
    };
    client.on("error", (err: Error & { level?: string }) => {
      if (key) done(key);
      else if (err.level === "client-socket" || err.level === "client-timeout")
        done({ status: "unreachable", message: err.message });
      else done({ status: "error", message: err.message });
    });
    client.on("close", () =>
      done(
        key ?? {
          status: "error",
          message: "Connection closed during handshake.",
        },
      ),
    );
    client.connect({
      host,
      port,
      username: "burrow-probe",
      readyTimeout: READY_TIMEOUT_MS,
      hostVerifier: (k: Buffer) => {
        key = Buffer.from(k);
        return false;
      },
    });
  });
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Output went beyond maxBytes and was cut there: what came is not all of it. */
  truncated?: boolean;
  /** keepEnd and cut: the output's first line (a header such as a log file's zone), the end follows in stdout. */
  head?: string;
}

/**
 * A command that ends on the host when its channel does not wait for it
 * any more (exec's time-out ends the channel's stdin): closing the channel
 * alone left it running there, and sshd kept its session while it ran (a
 * hung dockerd, a stale NFS mount), until a connection's ten (MaxSessions)
 * were taken and every command was refused. The command's own stdin is
 * /dev/null (it ends at once, as an ended one did); the channel's is held by
 * a watcher that ends the command's process group when it ends while the
 * shell still runs. After a command that ended by itself sshd ends that
 * stdin too: the shell is gone then and nothing is ended (a job it left
 * running in the background, an update started with nohup, lives on).
 * Never around endsWithChannel: that one reads the channel's stdin itself.
 */
export function endsOnTimeout(command: string): string {
  return `exec 3<&0 </dev/null; { cat <&3 >/dev/null 2>&1; kill -0 $$ 2>/dev/null || exit 0; trap '' TERM; kill 0; sleep 2; kill -9 0; } >/dev/null 2>&1 & exec 3<&-; ${command}`;
}

/** How long a timed-out command's channel may take to close (ended on the host) before it counts as stuck there. */
export const STUCK_AFTER_MS = 5000;
/** Channels stuck on one connection before it is ended: sshd gives a connection ten sessions, and a stuck one (a process in D state) holds one for good. */
export const STUCK_LIMIT = 3;
const stuck = new WeakMap<Client, number>();

/** A timed-out command's channel still open a while later: counted; at the limit the connection is ended (its pool opens a new one). */
function watchStuck(client: Client, stream: ClientChannel, closed: () => boolean): void {
  let counted = false;
  const t = setTimeout(() => {
    if (closed()) return;
    counted = true;
    const n = (stuck.get(client) ?? 0) + 1;
    if (n < STUCK_LIMIT) return void stuck.set(client, n);
    stuck.delete(client);
    client.end();
  }, STUCK_AFTER_MS);
  t.unref?.();
  stream.once("close", () => {
    clearTimeout(t);
    if (counted && stuck.has(client)) stuck.set(client, Math.max(0, stuck.get(client)! - 1));
  });
}

/**
 * Run one command and collect its output. Output beyond `maxBytes` is
 * dropped, and said so (truncated): the end of it, or with `keepEnd` the
 * start (all but the first line, kept as `head`), for a log whose newest
 * lines matter most. `input` goes to its stdin (a sudo password, for one).
 * A command that does not end in time is ended on the host (endsOnTimeout;
 * one given input only by its channel closing).
 */
export function exec(
  client: Client,
  command: string,
  timeoutMs = 15_000,
  maxBytes = 1 << 20,
  input?: string,
  opts: { keepEnd?: boolean } = {},
): Promise<ExecResult> {
  const watched = input === undefined;
  return execChannel(client, watched ? endsOnTimeout(command) : command).then(
    (stream) =>
      new Promise((resolve, reject) => {
        {
          // Its stdin: what is given, then the end of it, so a command that
          // reads it (a sudo prompt) ends at once instead of hanging until
          // the timeout. Nothing given: the command's stdin is /dev/null and
          // the channel's stays open for the watcher until the time-out.
          if (!watched) stream.end(input);
          // Bytes first, text at the end: a character split over two chunks
          // must not become two broken ones.
          let out: Buffer[] = [];
          const errs: Buffer[] = [];
          let outBytes = 0;
          let errBytes = 0;
          let closed = false;
          let head: Buffer | null = null;
          const timer = setTimeout(() => {
            if (watched) stream.end();
            stream.close();
            watchStuck(client, stream, () => closed);
            reject(new CommandTimeout(timeoutMs));
          }, timeoutMs);
          let truncated = false;
          stream.on("data", (d: Buffer) => {
            if (opts.keepEnd) {
              out.push(d);
              outBytes += d.length;
              if (outBytes <= maxBytes) return;
              // The first line kept apart, then only the newest maxBytes.
              if (!truncated) {
                const all = Buffer.concat(out);
                const nl = all.indexOf(10);
                head = nl < 0 ? all.subarray(0, Math.min(all.length, 4096)) : all.subarray(0, Math.min(nl, 4096));
                out = [all];
              }
              truncated = true;
              while (out.length > 1 && outBytes - out[0]!.length >= maxBytes) outBytes -= out.shift()!.length;
              return;
            }
            if (outBytes >= maxBytes) {
              truncated = true;
              return;
            }
            out.push(d);
            outBytes += d.length;
          });
          stream.stderr.on("data", (d: Buffer) => {
            if (errBytes >= maxBytes) return;
            errs.push(d);
            errBytes += d.length;
          });
          stream.on("close", (code: number | null) => {
            closed = true;
            clearTimeout(timer);
            let bytes = Buffer.concat(out);
            if (head) {
              // The newest maxBytes, from the first whole line in them.
              bytes = bytes.subarray(Math.max(0, bytes.length - maxBytes));
              const nl = bytes.indexOf(10);
              bytes = nl < 0 ? Buffer.alloc(0) : bytes.subarray(nl + 1);
            }
            resolve({
              // No exit status at all (the connection went) is null too, as one ended by a signal.
              code: code ?? null,
              stdout: bytes.toString("utf8"),
              stderr: Buffer.concat(errs).toString("utf8"),
              ...(truncated ? { truncated } : {}),
              ...(head ? { head: (head as Buffer).toString("utf8") } : {}),
            });
          });
        }
      }),
  );
}

const CHANNEL_FULL = /Channel open failure/i;

/**
 * client.exec, waiting a moment when sshd has no channel free: a host's
 * pooled connection is shared by everything Burrow asks it, and sshd allows
 * 10 channels on one (MaxSessions). One closes soon; up to `waitMs`.
 * A connection that went meanwhile is an error, not a throw: ssh2 throws
 * "Not connected" at once, and in a retry's timer that ended the process.
 */
export function execChannel(
  client: Client,
  command: string,
  options: ExecOptions = {},
  waitMs = 10_000,
): Promise<ClientChannel> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = (delay: number) => {
      try {
        client.exec(command, options, (err, ch) => {
          if (!err) return resolve(ch);
          if (
            !CHANNEL_FULL.test(err.message) ||
            Date.now() - started + delay > waitMs
          )
            return reject(err);
          setTimeout(() => attempt(Math.min(delay * 2, 1000)), delay);
        });
      } catch (err) {
        reject(err as Error);
      }
    };
    attempt(100);
  });
}

/**
 * A command that runs until its channel is closed (a log followed, docker
 * events), ended on the host when it is. sshd keeps the session of a closed
 * channel while its command runs on, and a quiet one (a container that logs
 * nothing) never writes again to find out: each stream stopped and started
 * held one of the ten sessions a connection gets, until the next command was
 * refused. The channel's stdin ends when it closes: then its process group
 * goes. stdin kept on fd 3 first, as an `&` list's own is /dev/null in sh.
 */
export function endsWithChannel(command: string): string {
  return `exec 3<&0; { cat <&3 >/dev/null 2>&1; kill 0; } >/dev/null 2>&1 & exec 3<&-; ${command}`;
}

// One round trip that answers everything the UI wants to know about a host.
// POSIX sh only: the login shell may be anything, routers run busybox.
export const FACTS_COMMAND = [
  'echo "kernel=$(uname -sr 2>/dev/null)"',
  '(. /etc/os-release 2>/dev/null && echo "os=$PRETTY_NAME") || echo "os="',
  'echo "shell=$SHELL"',
  "command -v tmux >/dev/null 2>&1 && echo tmux=1 || echo tmux=0",
  'test -f "$HOME/.burrow/shell-integration.sh" && echo integration=1 || echo integration=0',
  // `docker info` also proves this user may talk to the daemon, which is what
  // Docker-over-SSH needs; a binary without access counts as no Docker.
  'command -v docker >/dev/null 2>&1 && docker info --format "{{.ServerVersion}}" >/dev/null 2>&1 && echo docker=1 || echo docker=0',
  // A Proxmox VE node: its guests on the host's page (F5).
  '{ command -v qm || command -v pct; } >/dev/null 2>&1 && echo pve=1 || echo pve=0',
  // The MAC address of the interface with the default route, for Wake-on-LAN.
  'i=$(ip route show default 2>/dev/null | awk \'{print $5; exit}\'); [ -n "$i" ] && echo "mac=$(cat /sys/class/net/$i/address 2>/dev/null)" || echo mac=',
].join("; ");

/**
 * The facts command answered whole: every line it prints there. A forced
 * command, a broken login shell or a banner script printed something else
 * and the host's known tmux and Docker became "none" (AUDIT2 MON-10).
 */
export function factsComplete(code: number | null, stdout: string): boolean {
  if (code !== 0) return false;
  const keys = new Set(stdout.split("\n").map((l) => l.slice(0, l.indexOf("=")).trim()));
  return ["kernel", "os", "shell", "tmux", "integration", "docker", "mac"].every((k) => keys.has(k));
}

export function parseFacts(stdout: string, now: number): HostFacts {
  const kv = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const val = (k: string) => kv.get(k) || null;
  return {
    os: val("os"),
    kernel: val("kernel"),
    shell: val("shell"),
    hasTmux: kv.get("tmux") === "1",
    hasDocker: kv.get("docker") === "1",
    hasShellIntegration: kv.get("integration") === "1",
    proxmox: kv.get("pve") === "1",
    mac:
      /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(kv.get("mac") ?? "") &&
      kv.get("mac") !== "00:00:00:00:00:00"
        ? kv.get("mac")!.toLowerCase()
        : null,
    checkedAt: new Date(now).toISOString(),
  };
}

const keyLocks = new Map<string, Promise<unknown>>();

/**
 * One change to an account's authorized_keys at a time (AUDIT2 MON-02): a
 * removal reads the file and writes it back, so an install or another
 * removal in between was lost or undone. Keyed by the account itself, not
 * the host entry: two entries can be the same account.
 */
export function keysLock<T>(t: Pick<SshTarget, "host" | "port" | "username">, fn: () => Promise<T>): Promise<T> {
  const key = `${t.username}@${t.host.toLowerCase()}:${t.port}`;
  const run = (keyLocks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  keyLocks.set(key, tail);
  void tail.then(() => {
    if (keyLocks.get(key) === tail) keyLocks.delete(key);
  });
  return run;
}

/** Append a public key to ~/.ssh/authorized_keys unless it is already there (ssh-copy-id). */
export function authorizedKeysCommand(publicKeyLine: string): string {
  if (!/^[a-z0-9-]+ [A-Za-z0-9+/=]+( [\w@.:-]*)?$/.test(publicKeyLine)) {
    throw new Error("refusing to install a malformed public key line");
  }
  const q = `'${publicKeyLine}'`;
  return [
    "umask 077",
    'mkdir -p "$HOME/.ssh"',
    'touch "$HOME/.ssh/authorized_keys"',
    `(grep -qxF ${q} "$HOME/.ssh/authorized_keys" || printf '%s\\n' ${q} >> "$HOME/.ssh/authorized_keys")`,
    'chmod 700 "$HOME/.ssh"',
    'chmod 600 "$HOME/.ssh/authorized_keys"',
  ].join(" && ");
}
