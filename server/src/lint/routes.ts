import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { absPath, type Diagnostic } from '@burrow/shared';
import type { Ctx } from '../context.js';
import type { FileAccessGuard } from '../files/access.js';
import type { SftpPool } from '../files/pool.js';
import { getHost } from '../hosts/service.js';
import { HttpError, idParam, parse } from '../http.js';
import { findOnPath, toolEnv } from '../lsp/servers.js';
import { exec } from '../ssh/connect.js';
import { shellQuote } from '../ssh/quote.js';

// Checks that are not language servers: hadolint for Dockerfiles (runs here,
// on the text) and `docker compose config` for compose files (runs on the
// host, where the referenced .env and paths are).

interface HadolintItem {
  line: number;
  column: number;
  level: 'error' | 'warning' | 'info' | 'style';
  code: string;
  message: string;
}

/**
 * hadolint on a Dockerfile: its findings. It not finishing, failing or
 * answering something that is not its JSON is an error, never "no
 * findings" (AUDIT2 FS-21). It exits 1 when it found something.
 */
export function hadolint(content: string, timeoutMs = 15_000): Promise<Diagnostic[]> {
  const bin = findOnPath('hadolint');
  if (!bin) return Promise.reject(new HttpError(404, 'no_linter', 'hadolint is not installed in this Burrow image.'));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['--no-color', '--format', 'json', '-'], { stdio: ['pipe', 'pipe', 'pipe'], env: toolEnv() });
    let out = '';
    let err = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    child.on('error', reject);
    // Said at once: what it started may hold its output open a while longer.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      reject(new HttpError(504, 'lint_timeout', `hadolint did not finish in ${Math.max(1, Math.round(timeoutMs / 1000))} s.`));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0 && code !== 1) return reject(new HttpError(502, 'lint_failed', err.trim().split('\n').pop() || `hadolint exited with ${code}`));
      let items: HadolintItem[];
      try {
        items = JSON.parse(out) as HadolintItem[];
        if (!Array.isArray(items)) throw new Error('not a list');
      } catch {
        return reject(new HttpError(502, 'lint_failed', 'hadolint gave no readable answer.'));
      }
      resolve(
        items.map((i) => ({
          line: i.line,
          column: Math.max(1, i.column),
          severity: i.level === 'error' ? 'error' : i.level === 'warning' ? 'warning' : 'info',
          message: i.message,
          source: 'hadolint',
          code: i.code,
        })),
      );
    });
    child.stdin.on('error', () => {});
    child.stdin.end(content);
  });
}

/**
 * Best-effort place of a compose error: a "line N" or "at L4.C12" in the text; else the key it
 * names, found along the path it starts with ("services.web.imagee false schema": imagee under
 * web, not another service's), or a quoted one ("services.web additional properties 'imagee'
 * not allowed"). Compose v5 words them so; the key used to be taken from the last word.
 */
export function composeDiagnostics(output: string, content: string): Diagnostic[] {
  const lines = content.split('\n');
  /** The first line from `from` on that holds `key:`. */
  const keyLine = (key: string, from: number) => {
    const re = new RegExp(`^\\s*-?\\s*['"]?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*:`);
    for (let i = Math.max(0, from); i < lines.length; i++) if (re.test(lines[i]!)) return i;
    return -1;
  };
  const out: Diagnostic[] = [];
  for (const raw of output.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const msg = raw.replace(/^(validating|error while interpolating) \S+:\s*/i, '');
    let line = 1;
    let column = 1;
    const at = /\bL(\d+)\.C(\d+)\b/.exec(msg);
    const m = /line (\d+)/i.exec(msg);
    if (at) {
      line = Number(at[1]);
      column = Number(at[2]);
    } else if (m) line = Number(m[1]);
    else {
      // Each key of the path below the one before it; list indexes ("ports.0") are no keys.
      let idx = -1;
      const path = /^([\w-]+(?:\.[\w-]+)+)(?:\s|$)/.exec(msg)?.[1] ?? '';
      for (const key of path.split('.').filter((k) => k && !/^\d+$/.test(k))) {
        const i = keyLine(key, idx + 1);
        if (i < 0) break;
        idx = i;
      }
      const quoted = /'([^']+)'/.exec(msg)?.[1];
      const key = quoted ?? (idx < 0 ? msg.split(/[\s.]/).filter((w) => /^[\w-]+$/.test(w)).pop() : undefined);
      const i = key ? keyLine(key, idx + 1) : -1;
      if (i >= 0) idx = i;
      if (idx >= 0) line = idx + 1;
    }
    out.push({ line, column, severity: 'error', message: msg, source: 'docker compose' });
  }
  return out;
}

export function registerLintRoutes(app: FastifyInstance, ctx: Ctx, pool: SftpPool, access: FileAccessGuard): void {
  app.post('/api/lint/dockerfile', async (req) => {
    const { content } = parse(z.object({ content: z.string().max(1024 * 1024) }), req.body);
    return hadolint(content);
  });

  /**
   * Validate unsaved compose text with the host's `docker compose config`:
   * written to a hidden file next to the real one (so relative paths and
   * .env resolve the same), checked, removed. That file is a write like any
   * other: checked as one (a folder whose files grant a shell asks for a
   * fresh step-up first, audit 2026-11-05).
   */
  app.post('/api/files/:hostId/compose-check', async (req) => {
    const hostId = idParam(req, 'hostId');
    getHost(ctx, hostId);
    const b = parse(z.object({ path: absPath, content: z.string().max(1024 * 1024) }), req.body);
    const dir = posix.dirname(b.path);
    const tmp = `${dir}/.burrow-check-${randomBytes(4).toString('hex')}.${posix.basename(b.path)}`;
    return pool.with(hostId, async (conn) => {
      const { client, sftp } = conn;
      await access.check(req, hostId, conn, tmp, 'write');
      await new Promise<void>((resolve, reject) => sftp.writeFile(tmp, b.content, { mode: 0o600 }, (err) => (err ? reject(err) : resolve()))).catch(
        (err: Error) => {
          throw new HttpError(502, 'sftp_error', `Could not write a check file in ${dir}: ${err.message}`);
        },
      );
      try {
        const r = await exec(client, `cd ${shellQuote(dir)} && docker compose -f ${shellQuote(tmp)} config -q 2>&1`, 30_000);
        if (r.code === 127 || /docker: .*not found|is not a docker command/.test(r.stdout)) {
          throw new HttpError(400, 'tool_missing', 'docker compose is not available on this host.');
        }
        return { ok: r.code === 0, diagnostics: r.code === 0 ? [] : composeDiagnostics(r.stdout.replaceAll(tmp, posix.basename(b.path)), b.content) };
      } finally {
        await new Promise<void>((resolve) => sftp.unlink(tmp, () => resolve()));
      }
    });
  });
}
