import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Stats } from 'ssh2';
import { z } from 'zod';
import {
  absPath,
  archiveInput,
  bookmarkInput,
  chmodInput,
  chownInput,
  createInput,
  extractInput,
  pathsInput,
  renameInput,
  saveInput,
  searchInput,
  TEXT_SAVE_BODY_LIMIT,
  transferInput,
  uploadInit,
  type Bookmark,
  type UploadState,
} from '@burrow/shared';
import { audit } from '../audit.js';
import { requireStepUp } from '../auth/sessions.js';
import type { Ctx } from '../context.js';
import { fileBookmarks, uploads as uploadRows } from '../db/schema.js';
import { getHost } from '../hosts/service.js';
import { actor, contentDisposition, HttpError, idParam, noContent, parse, requireAuth } from '../http.js';
import type { FileAccessGuard } from './access.js';
import { Jobs } from './jobs.js';
import type { SftpPool } from './pool.js';
import * as fs from './service.js';

// MIME types Burrow shows inline. Everything else is a download: a file from
// a host must never run as a page in Burrow's origin (HTML, SVG, XML could
// carry scripts), so those are served as downloads even when asked inline.
const INLINE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
};

const ext = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';

const CHUNK_MAX = 16 * 1024 * 1024;

interface Upload {
  id: string;
  userId: number;
  hostId: number;
  dir: string;
  name: string;
  size: number;
  tmp: string;
  overwrite: boolean;
  /** Last init or chunk: an upload left alone this long is given up. */
  touched: number;
}

// An upload nobody continues (the tab closed for good) is dropped after a
// day, with its hidden temporary file on the host.
const UPLOAD_TTL_MS = 24 * 60 * 60_000;

export async function registerFileRoutes(app: FastifyInstance, ctx: Ctx, pool: SftpPool, access: FileAccessGuard): Promise<void> {
  const jobs = new Jobs(ctx);
  // In the database: an upload goes on after Burrow restarted, and its
  // temporary file on the host is not forgotten (audit BE-14).
  const uploads = {
    get: (id: string): Upload | undefined => ctx.db.select().from(uploadRows).where(eq(uploadRows.id, id)).get(),
    set: (_id: string, u: Upload) => void ctx.db.insert(uploadRows).values(u).run(),
    delete: (id: string) => void ctx.db.delete(uploadRows).where(eq(uploadRows.id, id)).run(),
    values: (): Upload[] => ctx.db.select().from(uploadRows).all(),
    touch: (id: string) => void ctx.db.update(uploadRows).set({ touched: ctx.now() }).where(eq(uploadRows.id, id)).run(),
  };
  const sweepUploads = () => {
    const cutoff = ctx.now() - UPLOAD_TTL_MS;
    for (const u of [...uploads.values()]) {
      if (u.touched >= cutoff) continue;
      // The record goes once the partial file has: a host away keeps both for the next sweep (AUDIT2 FS-12).
      void pool
        .with(u.hostId, ({ sftp }) => fs.removeIfThere(sftp, u.tmp))
        .then((gone) => gone && uploads.delete(u.id), () => {});
    }
  };

  const hostOf = (req: FastifyRequest) => {
    const id = idParam(req, 'hostId');
    getHost(ctx, id);
    return id;
  };
  const q = <T extends z.ZodType>(schema: T, req: FastifyRequest) => parse(schema, req.query);

  // ---------------------------------------------------------------- browsing

  // Every path an operator reads goes through access.check (the folders an admin granted them,
  // A3-SRV-01); every write too, where a file that grants a shell asks for a step-up (A3-SRV-08).
  app.get('/api/files/:hostId/list', { config: { auth: 'user' } }, async (req) => {
    const { path } = q(z.object({ path: z.string().max(4096).default('~') }), req);
    const hostId = hostOf(req);
    return pool.with(hostId, async (conn) => {
      const dir = await access.check(req, hostId, conn, fs.normalize(path, conn.home));
      const listing = await fs.list(conn.sftp, conn.home, dir);
      const open = new Set(await access.filter(req, hostId, conn, dir, listing.entries.map((e) => e.path), false));
      return { ...listing, entries: listing.entries.filter((e) => open.has(e.path)) };
    });
  });

  app.get('/api/files/:hostId/du', { config: { auth: 'user' } }, async (req) => {
    const { path } = q(z.object({ path: absPath }), req);
    const hostId = hostOf(req);
    return pool.with(hostId, async (conn) => fs.du(conn.client, await access.check(req, hostId, conn, path)));
  });

  app.get('/api/files/:hostId/search', { config: { auth: 'user' } }, async (req) => {
    const s = q(searchInput, req);
    const hostId = hostOf(req);
    return pool.with(hostId, async (conn) => {
      const dir = await access.check(req, hostId, conn, s.dir);
      return access.filter(req, hostId, conn, dir, await fs.search(conn.client, dir, s.name));
    });
  });

  /** A file's bytes: inline for media and plain text, else as a download. Supports Range. */
  app.get('/api/files/:hostId/raw', { config: { auth: 'user' } }, async (req, reply) => {
    const { path, download } = q(z.object({ path: absPath, download: z.coerce.boolean().default(false) }), req);
    const hostId = hostOf(req);
    return pool.with(hostId, async (conn) => {
      const { sftp } = conn;
      const real = await access.check(req, hostId, conn, path);
      const st = await fs.stat(sftp, real);
      if (!st || (st.mode & 0o170000) !== 0o100000) throw new HttpError(404, 'not_found', `${path} is not a file.`);
      sendFile(req, reply, sftp, real, st, download);
      // Keep the connection in use until the stream is done.
      await new Promise<void>((resolve) => reply.raw.on('close', resolve));
      return reply;
    });
  });

  function sendFile(req: FastifyRequest, reply: FastifyReply, sftp: import('ssh2').SFTPWrapper, path: string, st: Stats, download: boolean) {
    const type = INLINE[ext(path)];
    const inline = !download && type !== undefined;
    const name = posix.basename(path);
    reply.header('X-Content-Type-Options', 'nosniff');
    // Even an allowed type is locked down: no scripts, no plugins, no forms.
    reply.header('Content-Security-Policy', type === 'application/pdf' ? "default-src 'none'; object-src 'self'" : "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    reply.header('Content-Type', inline ? type : 'application/octet-stream');
    reply.header('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', name));
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'private, no-store');
    const size = st.size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = size - 1;
    if (range && size > 0) {
      start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        reply.code(416).header('Content-Range', `bytes */${size}`);
        return reply.send();
      }
      reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    reply.header('Content-Length', size === 0 ? 0 : end - start + 1);
    if (size === 0) return reply.send('');
    return reply.send(sftp.createReadStream(path, { start, end }));
  }

  // ---------------------------------------------------------------- changes

  app.post('/api/files/:hostId/create', async (req) => {
    const b = parse(createInput, req.body);
    const hostId = hostOf(req);
    await pool.with(hostId, async (conn) => fs.create(conn.sftp, await access.check(req, hostId, conn, b.path, 'write'), b.kind));
    audit(ctx, actor(req), b.kind === 'dir' ? 'file.mkdir' : 'file.create', b.path, { hostId });
    return { ok: true };
  });

  app.post('/api/files/:hostId/rename', async (req) => {
    const b = parse(renameInput, req.body);
    const hostId = hostOf(req);
    await pool.with(hostId, async (conn) => {
      await access.check(req, hostId, conn, b.from, 'write');
      return fs.rename(conn.sftp, b.from, await access.check(req, hostId, conn, b.to, 'write'));
    });
    audit(ctx, actor(req), 'file.rename', b.from, { hostId, to: b.to });
    return { ok: true };
  });

  // Deleting cannot be undone: a fresh step-up is required.
  app.post('/api/files/:hostId/delete', { config: { stepUp: true } }, async (req) => {
    const b = parse(pathsInput, req.body);
    const hostId = hostOf(req);
    await pool.with(hostId, async (conn) => {
      for (const path of b.paths) await access.check(req, hostId, conn, path, 'write');
      return fs.remove(conn.client, conn.home, b.paths);
    });
    audit(ctx, actor(req), 'file.delete', b.paths.length === 1 ? b.paths[0]! : `${b.paths.length} items`, { hostId, paths: b.paths.slice(0, 50) });
    return { ok: true };
  });

  app.post('/api/files/:hostId/chmod', async (req) => {
    const b = parse(chmodInput, req.body);
    const hostId = hostOf(req);
    await pool.with(hostId, async (conn) => fs.chmod(conn.client, await access.check(req, hostId, conn, b.path, 'write'), b.mode, b.recursive));
    audit(ctx, actor(req), 'file.chmod', b.path, { hostId, mode: b.mode.toString(8), recursive: b.recursive });
    return { ok: true };
  });

  app.post('/api/files/:hostId/chown', async (req) => {
    const b = parse(chownInput, req.body);
    const hostId = hostOf(req);
    await pool.with(hostId, async (conn) => fs.chown(conn.client, conn.home, await access.check(req, hostId, conn, b.path, 'write'), b.owner, b.group, b.recursive));
    audit(ctx, actor(req), 'file.chown', b.path, { hostId, owner: b.owner, group: b.group, recursive: b.recursive });
    return { ok: true };
  });

  // ---------------------------------------------------------------- jobs

  /** Copy or move, within a host or between two. Runs as a job; poll it. */
  app.post('/api/files/transfer', async (req) => {
    const b = parse(transferInput, req.body);
    // Two items of one name would land on the same spot: the second
    // replaced the first, and a move then deleted both sources.
    const seen = new Set<string>();
    const twice = b.paths.map((x) => posix.basename(x)).filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
    if (twice.length) throw new HttpError(400, 'same_name', `More than one item named ${[...new Set(twice)].join(', ')}: copy them one at a time.`);
    getHost(ctx, b.fromHostId);
    getHost(ctx, b.toHostId);
    const clash = b.clash ?? (b.overwrite ? 'replace' : 'fail');
    const overwrite = clash === 'replace';
    // Replacing what is there cannot be undone either: like deleting, a fresh step-up (A3-SRV-08).
    if (overwrite) requireStepUp(ctx, req);
    await pool.with(b.fromHostId, async (conn) => {
      for (const p of b.paths) await access.check(req, b.fromHostId, conn, p, b.move ? 'write' : 'read');
    });
    await pool.with(b.toHostId, async (conn) => {
      for (const p of b.paths) await access.check(req, b.toHostId, conn, posix.join(b.toDir, posix.basename(p)), 'write');
    });
    const who = actor(req);
    return jobs.start(requireAuth(req).user.id, b.move ? 'move' : 'copy', async (job) => {
      const started = performance.now();
      // A name taken there: skipped, or kept beside it (report dfda31). Which are taken, now.
      const taken = clash === 'skip' || clash === 'rename' ? await pool.with(b.toHostId, ({ client }) => fs.clashes(client, b.paths, b.toDir)) : [];
      const paths = clash === 'skip' ? b.paths.filter((p) => !taken.includes(p)) : b.paths;
      if (clash === 'skip') job.skipped = taken.length;
      // Kept beside: into a folder of its own in the destination first, then each under a free name.
      const into = clash === 'rename' && taken.length ? await pool.with(b.toHostId, ({ client }) => fs.keepBothFolder(client, b.toDir)) : b.toDir;
      const names = paths.map((p) => posix.basename(p));
      const place = () => (into === b.toDir ? Promise.resolve() : pool.with(b.toHostId, ({ client }) => fs.placeKeepingBoth(client, into, names, b.toDir)).then(() => {}));
      try {
        if (!paths.length) {
          // Every item skipped: nothing to do.
        } else if (b.fromHostId === b.toHostId) {
          await pool.with(b.fromHostId, ({ client }) => fs.copyLocal(client, paths, into, b.move, overwrite));
          await place();
        } else {
          job.phase = 'copying';
          let checked: Map<string, Map<string, string>> | null = null;
          await pool.with(b.fromHostId, (src) =>
            pool.with(b.toHostId, async (dst) => {
              await fs.copyBetweenHosts(src.client, dst.client, paths, into, overwrite, (n) => (job.bytes = n));
              // Then each file's sha256 on both sides: a mismatch fails the job (and a move keeps its source).
              job.phase = 'checking';
              const v = await fs.verifyCopy(src.client, dst.client, paths, into);
              if ('files' in v) {
                job.verified = v.files;
                checked = v.sources;
              } else job.unverified = v.skipped as 'source' | 'destination';
            }),
          );
          job.phase = null;
          // In place before a move deletes anything.
          await place();
          // A move between hosts deletes the source only after the copy succeeded
          // (and matched), and while the source is still what was checked.
          if (b.move)
            await pool.with(b.fromHostId, async ({ client, home }) => {
              if (checked) {
                const changed = await fs.sourcesUnchanged(client, paths, checked);
                if (changed.length) {
                  const names = `${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ` (+${changed.length - 5})` : ''}`;
                  throw Object.assign(new HttpError(409, 'source_changed', `Copied, but kept where it was: changed during the move (${names}).`), { detail: names });
                }
              }
              await fs.remove(client, home, paths);
            });
        }
      } catch (err) {
        // What arrived in the folder of its own is put in place all the same, as a copy that fails
        // otherwise leaves what it copied: nothing is lost in a hidden folder (a move had moved some).
        if (into !== b.toDir) await place().catch(() => {});
        throw err;
      }
      audit(ctx, who, b.move ? 'file.move' : 'file.copy', b.paths.length === 1 ? b.paths[0]! : `${b.paths.length} items`, {
        fromHostId: b.fromHostId,
        toHostId: b.toHostId,
        toDir: b.toDir,
        bytes: job.bytes,
      });
      job.message = `${Math.round(performance.now() - started)} ms`;
    });
  });

  app.post('/api/files/:hostId/archive', async (req) => {
    const b = parse(archiveInput, req.body);
    const hostId = hostOf(req);
    await pool.with(hostId, async (conn) => {
      for (const p of b.paths) await access.check(req, hostId, conn, p);
      await access.check(req, hostId, conn, b.dest, 'write');
    });
    const who = actor(req);
    return jobs.start(requireAuth(req).user.id, 'archive', async () => {
      await pool.with(hostId, ({ client, sftp }) =>
        fs.stat(sftp, b.dest).then((st) => {
          if (st) throw new HttpError(409, 'exists', `${posix.basename(b.dest)} already exists.`);
          return fs.archive(client, b.paths, b.dest);
        }),
      );
      audit(ctx, who, 'file.archive', b.dest, { hostId, items: b.paths.length });
    });
  });

  app.post('/api/files/:hostId/extract', async (req) => {
    const b = parse(extractInput, req.body);
    const hostId = hostOf(req);
    // Unpacking replaces files of the same name (unzip -o, tar): like deleting, a fresh step-up (A3-SRV-08).
    requireStepUp(ctx, req);
    await pool.with(hostId, async (conn) => {
      await access.check(req, hostId, conn, b.path);
      await access.check(req, hostId, conn, b.toDir, 'write');
    });
    const who = actor(req);
    return jobs.start(requireAuth(req).user.id, 'extract', async () => {
      await pool.with(hostId, ({ client }) => fs.extract(client, b.path, b.toDir));
      audit(ctx, who, 'file.extract', b.path, { hostId, toDir: b.toDir });
    });
  });

  app.get('/api/files/jobs/:id', async (req) => jobs.get(requireAuth(req).user.id, (req.params as { id: string }).id));

  // ---------------------------------------------------------------- text

  app.get('/api/files/:hostId/text', { config: { auth: 'user' } }, async (req) => {
    const { path } = q(z.object({ path: absPath }), req);
    const hostId = hostOf(req);
    return pool.with(hostId, async (conn) => {
      const real = await access.check(req, hostId, conn, path);
      // writable: whether a save as the SSH user can work; root's files go through sudo (W-FUNC-01).
      return { ...(await fs.readText(conn.sftp, real)), path, writable: await fs.writable(conn.sftp, real) };
    });
  });

  // As large as what the editor opens (the app-wide limit is 1 MB).
  app.put('/api/files/:hostId/text', { bodyLimit: TEXT_SAVE_BODY_LIMIT }, async (req, reply) => {
    const b = parse(saveInput, req.body);
    const hostId = hostOf(req);
    const r = await pool.with(hostId, async (conn) => {
      await access.check(req, hostId, conn, b.path, 'write');
      return fs.writeText(conn.sftp, b.path, b.content, b.baseHash, hostId);
    });
    if (!r.ok) return reply.code(409).send({ error: 'conflict', message: 'The file changed on the host since you opened it.', current: r.current });
    audit(ctx, actor(req), 'file.save', b.path, { hostId, bytes: r.file.size });
    return r.file;
  });

  // ---------------------------------------------------------------- uploads
  // Chunked with resume: init, then PUT chunks at an offset, then finish.
  // The data goes to a hidden temporary file next to the target and is
  // renamed into place only when complete.

  app.post('/api/files/:hostId/uploads', async (req): Promise<UploadState> => {
    const b = parse(uploadInit, req.body);
    const hostId = hostOf(req);
    // Replacing what is there: a fresh step-up, as copying over it (A3-SRV-08, audit 2026-10-30).
    if (b.overwrite) requireStepUp(ctx, req);
    sweepUploads();
    const target = `${b.dir}/${b.name}`;
    const id = randomBytes(12).toString('base64url');
    const tmp = `${b.dir}/.${b.name}.burrow-upload-${id}`;
    await pool.with(hostId, async (conn) => {
      const { sftp } = conn;
      await access.check(req, hostId, conn, target, 'write');
      if (!b.overwrite && (await fs.stat(sftp, target))) throw new HttpError(409, 'exists', `${b.name} already exists.`);
      await new Promise<void>((resolve, reject) =>
        sftp.open(tmp, 'w', 0o600, (err, h) => (err ? reject(err) : sftp.close(h, () => resolve()))),
      ).catch((err: { code?: number; message?: string }) => {
        throw new HttpError(err.code === 3 ? 403 : 502, err.code === 3 ? 'permission_denied' : 'sftp_error', err.code === 3 ? `No permission to write in ${b.dir}.` : (err.message ?? ''));
      });
    });
    uploads.set(id, { id, userId: requireAuth(req).user.id, hostId, dir: b.dir, name: b.name, size: b.size, tmp, overwrite: b.overwrite, touched: ctx.now() });
    return { id, offset: 0, size: b.size };
  });

  const uploadOf = (req: FastifyRequest): Upload => {
    const u = uploads.get((req.params as { id: string }).id);
    if (!u || u.userId !== requireAuth(req).user.id) throw new HttpError(404, 'not_found', 'Unknown upload; start it again.');
    return u;
  };

  /** Where to resume: the size of the temporary file on the host. */
  app.get('/api/files/uploads/:id', async (req): Promise<UploadState> => {
    const u = uploadOf(req);
    const st = await pool.with(u.hostId, ({ sftp }) => fs.stat(sftp, u.tmp));
    if (!st) {
      uploads.delete(u.id);
      throw new HttpError(404, 'not_found', 'The partial upload is gone; start it again.');
    }
    return { id: u.id, offset: st.size, size: u.size };
  });

  await app.register(async (sub) => {
    sub.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: CHUNK_MAX }, (_req, body, done) => done(null, body));
    sub.put('/api/files/uploads/:id', async (req): Promise<UploadState> => {
      const u = uploadOf(req);
      const { offset } = q(z.object({ offset: z.coerce.number().int().min(0) }), req);
      const chunk = req.body as Buffer;
      if (!Buffer.isBuffer(chunk)) throw new HttpError(400, 'invalid_request', 'Send the chunk as application/octet-stream.');
      if (offset + chunk.length > u.size) throw new HttpError(400, 'too_long', 'More data than the announced size.');
      await pool.with(u.hostId, async ({ sftp }) => {
        const st = await fs.stat(sftp, u.tmp);
        // Chunks are written in order; a retry of the last one is harmless.
        if (!st || st.size < offset) throw new HttpError(409, 'offset', `Resume at ${st?.size ?? 0}.`);
        await new Promise<void>((resolve, reject) => {
          sftp.open(u.tmp, 'r+', (err, h) => {
            if (err) return reject(err);
            sftp.write(h, chunk, 0, chunk.length, offset, (err2) => sftp.close(h, () => (err2 ? reject(err2) : resolve())));
          });
        });
      });
      uploads.touch(u.id);
      return { id: u.id, offset: offset + chunk.length, size: u.size };
    });
  });

  app.post('/api/files/uploads/:id/finish', async (req) => {
    const u = uploadOf(req);
    const target = `${u.dir}/${u.name}`;
    await pool.with(u.hostId, async ({ sftp }) => {
      const st = await fs.stat(sftp, u.tmp);
      if (!st || st.size !== u.size) throw new HttpError(409, 'incomplete', `Only ${st?.size ?? 0} of ${u.size} bytes arrived.`);
      // A file it replaces keeps its mode (a secret stays 0600, a script
      // executable); a new one gets 0644.
      const existing = u.overwrite ? await fs.stat(sftp, target) : null;
      // Its owner and group too, or refused: replaced as this user, another user's file became this user's (AUDIT2 FS-09).
      if (existing) await fs.keepOwnerAndMode(sftp, u.tmp, existing, target);
      else await new Promise<void>((resolve, reject) => sftp.chmod(u.tmp, 0o644, (err) => (err ? reject(err) : resolve()))).catch(() => {});
      // "Do not overwrite" holds here too: something may have arrived at that
      // name since the upload began (another upload of the same name).
      if (u.overwrite) await fs.replaceWith(sftp, u.tmp, target, !!existing);
      else
        await fs.placeNew(sftp, u.tmp, target).catch(async (err) => {
          // Taken meanwhile: this upload is over, its temporary file goes.
          if (err instanceof HttpError && err.status === 409) {
            uploads.delete(u.id);
            await new Promise<void>((resolve) => sftp.unlink(u.tmp, () => resolve()));
          }
          throw err;
        });
    });
    uploads.delete(u.id);
    audit(ctx, actor(req), 'file.upload', target, { hostId: u.hostId, bytes: u.size });
    return { ok: true, path: target };
  });

  app.delete('/api/files/uploads/:id', async (req, reply) => {
    const u = uploadOf(req);
    // Stopped: its record goes with its partial file; one that cannot be removed now is left
    // for the sweep, not forgotten on the host (AUDIT2 FS-12).
    const gone = await pool.with(u.hostId, ({ sftp }) => fs.removeIfThere(sftp, u.tmp)).catch(() => false);
    if (gone) uploads.delete(u.id);
    else uploads.touch(u.id);
    return noContent(reply);
  });

  // ---------------------------------------------------------------- bookmarks

  const toBookmark = (r: typeof fileBookmarks.$inferSelect): Bookmark => ({ id: r.id, hostId: r.hostId, path: r.path, name: r.name });

  // Every host's favourite folders, for the Files start page; an operator's, those they may open.
  app.get('/api/files/bookmarks', { config: { auth: 'user' } }, async (req) =>
    ctx.db
      .select()
      .from(fileBookmarks)
      .orderBy(fileBookmarks.name)
      .all()
      .filter((b) => access.shown(req, b.hostId, b.path))
      .map(toBookmark),
  );

  app.get('/api/files/:hostId/bookmarks', { config: { auth: 'user' } }, async (req) =>
    ctx.db
      .select()
      .from(fileBookmarks)
      .where(eq(fileBookmarks.hostId, hostOf(req)))
      .orderBy(fileBookmarks.name)
      .all()
      .filter((b) => access.shown(req, b.hostId, b.path))
      .map(toBookmark),
  );

  app.post('/api/files/:hostId/bookmarks', async (req) => {
    const b = parse(bookmarkInput, req.body);
    const hostId = hostOf(req);
    const row = ctx.db
      .insert(fileBookmarks)
      .values({ hostId, path: b.path, name: b.name, createdAt: ctx.now() })
      .onConflictDoUpdate({ target: [fileBookmarks.hostId, fileBookmarks.path], set: { name: b.name } })
      .returning()
      .get();
    return toBookmark(row);
  });

  app.delete('/api/files/bookmarks/:id', async (req, reply) => {
    ctx.db.delete(fileBookmarks).where(eq(fileBookmarks.id, idParam(req))).run();
    return noContent(reply);
  });
}
