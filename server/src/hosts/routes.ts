import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  connectionDefaults,
  effectiveConnection,
  groupInput,
  hostInput,
  importApplyInput,
  importPreviewInput,
  installKeyInput,
  keyGenerateInput,
  keyImportInput,
  trustInput,
  type ConnectResult,
} from '@burrow/shared';
import { audit } from '../audit.js';
import { hostDefaults, setHostDefaults } from './defaults.js';
import type { Ctx } from '../context.js';
import { knownHosts } from '../db/schema.js';
import { keysOffHost, keysOnHost } from '../android/direct.js';
import { actor, HttpError, idParam, noContent, parse } from '../http.js';
import { deleteKey, generateKey, getKey, importKey, listKeys, unsealKey } from '../keys/vault.js';
import { authorizedKeysCommand, exec, FACTS_COMMAND, factsComplete, keysLock, openSsh, parseFacts, probeHostKey, type SshTarget } from '../ssh/connect.js';
import { fingerprintOf, judgeHostKey, listKnownHosts, toKnownHost, trustHostKey } from '../ssh/knownhosts.js';
import { previewImport } from './importer.js';
import { setIntegration } from './integration.js';
import {
  assertKeyExists,
  clearHostPassword,
  copyHost,
  createGroup,
  createHost,
  deleteGroup,
  deleteHost,
  getHost,
  groupMap,
  listGroups,
  listHosts,
  resolveTarget,
  setFacts,
  updateGroup,
  updateHost,
  useKeyForHost,
} from './service.js';
import type { SftpPool } from '../files/pool.js';
import type { TerminalManager } from '../terminal/manager.js';
import type { StatusMonitor } from './status.js';

// Changing hosts, keys or trust needs a fresh step-up; reading does not.
const change = { config: { stepUp: true } } as const;

export function registerHostRoutes(app: FastifyInstance, ctx: Ctx, status: StatusMonitor, terminals: TerminalManager, files: SftpPool): void {
  // ---------------------------------------------------------------- groups

  app.get('/api/groups', { config: { auth: 'user' } }, async () => listGroups(ctx));

  app.post('/api/groups', change, async (req) => {
    const g = createGroup(ctx, parse(groupInput, req.body));
    audit(ctx, actor(req), 'group.create', g.name, { id: g.id });
    return g;
  });

  app.put('/api/groups/:id', change, async (req) => {
    const g = updateGroup(ctx, idParam(req), parse(groupInput, req.body));
    audit(ctx, actor(req), 'group.update', g.name, { id: g.id });
    return g;
  });

  // "All hosts": what every host gets when neither it nor a group sets a field.
  app.get('/api/host-defaults', { config: { auth: 'user' } }, async () => hostDefaults(ctx));

  app.put('/api/host-defaults', change, async (req) => {
    const input = parse(connectionDefaults, req.body);
    assertKeyExists(ctx, input.keyId);
    const d = setHostDefaults(ctx, input);
    audit(ctx, actor(req), 'hosts.defaults', 'All hosts', d);
    return d;
  });

  app.delete('/api/groups/:id', change, async (req, reply) => {
    const g = deleteGroup(ctx, idParam(req));
    audit(ctx, actor(req), 'group.delete', g.name, { id: g.id });
    return noContent(reply);
  });

  // ---------------------------------------------------------------- hosts

  app.get('/api/hosts', { config: { auth: 'user' } }, async () => listHosts(ctx));

  app.get('/api/hosts/status', { config: { auth: 'user' } }, async () => status.all());

  app.get('/api/hosts/:id', { config: { auth: 'user' } }, async (req) => {
    const h = getHost(ctx, idParam(req));
    return { ...h, effective: effectiveConnection(h, groupMap(ctx), hostDefaults(ctx)) };
  });

  app.post('/api/hosts', change, async (req) => {
    const h = createHost(ctx, parse(hostInput, req.body));
    audit(ctx, actor(req), 'host.create', h.name, { id: h.id, address: h.address });
    void status.checkOne(h.id, h.address, effectiveConnection(h, groupMap(ctx), hostDefaults(ctx)).port);
    return h;
  });

  // The account a host entry points at, with what logs in there; null when it cannot connect.
  const targetOf = (id: number): SshTarget | null => {
    try {
      return resolveTarget(ctx, id);
    } catch {
      return null;
    }
  };
  const account = (t: SshTarget | null) => (t ? `${t.username}@${t.host.toLowerCase()}:${t.port}` : null);

  app.put('/api/hosts/:id', change, async (req) => {
    const id = idParam(req);
    const before = targetOf(id);
    const h = updateHost(ctx, id, parse(hostInput, req.body));
    // New address or credentials: the pooled file connection is stale.
    files.drop(h.id);
    // Another account now: the phones' keys come off the old one and go onto
    // the new one (AUDIT2 MON-01: they stayed, and a later removal went to the new one).
    let directKeys: { left: string[]; notOn: string[] } | null = null;
    if (before && account(before) !== account(targetOf(id))) {
      const off = await keysOffHost(ctx, id, before);
      const notOn = await keysOnHost(ctx, id, off.deviceIds);
      if (off.left.length || notOn.length) directKeys = { left: off.left, notOn };
    }
    audit(ctx, actor(req), 'host.update', h.name, { id: h.id, address: h.address, ...(directKeys ? { directKeys } : {}) });
    return directKeys ? { ...h, directKeys } : h;
  });

  app.post('/api/hosts/:id/copy', change, async (req) => {
    const h = copyHost(ctx, idParam(req));
    audit(ctx, actor(req), 'host.create', h.name, { id: h.id, copyOf: idParam(req) });
    return h;
  });

  app.delete('/api/hosts/:id', change, async (req, reply) => {
    const id = idParam(req);
    await terminals.closeForHost(id, actor(req));
    files.drop(id);
    // The phones' keys off first: with the host gone nothing could take them off later (AUDIT2 MON-01).
    const { left } = await keysOffHost(ctx, id, targetOf(id));
    const h = deleteHost(ctx, id);
    audit(ctx, actor(req), 'host.delete', h.name, { id: h.id, ...(left.length ? { directKeysLeft: left } : {}) });
    return left.length ? { directKeys: { left, notOn: [] } } : noContent(reply);
  });

  /** Forget the stored password, e.g. once a key is installed. */
  app.delete('/api/hosts/:id/password', change, async (req) => {
    const h = clearHostPassword(ctx, idParam(req));
    audit(ctx, actor(req), 'host.password_removed', h.name, { id: h.id });
    return h;
  });

  /**
   * Connect, authenticate and read the host's facts (OS, tmux, Docker). An
   * unknown host key returns its fingerprint for the user to confirm.
   */
  app.post('/api/hosts/:id/test', async (req): Promise<ConnectResult> => {
    const id = idParam(req);
    const target = resolveTarget(ctx, id);
    const r = await connectAndDetect(ctx, id, target);
    audit(ctx, actor(req), 'host.test', getHost(ctx, id).name, { id, status: r.status });
    return r;
  });

  /**
   * Trust the host key the user was shown. The key is fetched again and must
   * match the fingerprint the user confirmed; otherwise nothing is stored.
   */
  app.post('/api/hosts/:id/trust', change, async (req) => {
    const id = idParam(req);
    const { fingerprint } = parse(trustInput, req.body);
    const h = getHost(ctx, id);
    const port = effectiveConnection(h, groupMap(ctx), hostDefaults(ctx)).port;
    const key = await probeHostKey(h.address, port);
    if (!Buffer.isBuffer(key)) throw new HttpError(502, key.status, 'message' in key ? key.message : undefined);
    if (fingerprintOf(key) !== fingerprint) {
      throw new HttpError(409, 'fingerprint_changed', 'The host now presents a different key than the one you confirmed.');
    }
    const verdict = judgeHostKey(ctx, h.address, port, key);
    if (verdict.kind === 'mismatch') {
      throw new HttpError(409, 'host_key_mismatch', 'A different key is already trusted for this host. Remove it first.');
    }
    const kh = verdict.kind === 'trusted' ? listKnownHosts(ctx).find((k) => k.fingerprint === fingerprint)! : trustHostKey(ctx, h.address, port, key);
    audit(ctx, actor(req), 'known_host.trust', `${h.address}:${port}`, { fingerprint });
    return kh;
  });

  /** ssh-copy-id: log in once with a password and install a vault key. */
  app.post('/api/hosts/:id/install-key', change, async (req): Promise<ConnectResult> => {
    const id = idParam(req);
    const body = parse(installKeyInput, req.body);
    const key = getKey(ctx, body.keyId);
    if (!key) throw new HttpError(400, 'unknown_key');
    const target = resolveTarget(ctx, id, { password: body.password });
    const installed = await keysLock(target, async (): Promise<ConnectResult | null> => {
      const conn = await openSsh(ctx, target);
      if (!('client' in conn)) return conn;
      try {
        const r = await exec(conn.client, authorizedKeysCommand(key.publicKey));
        return r.code !== 0 ? { status: 'error', message: r.stderr.trim() || `exit code ${r.code}` } : null;
      } finally {
        conn.client.end();
      }
    });
    if (installed) return installed;
    // Proved before it is kept: a key sshd refuses (AuthorizedKeysFile
    // elsewhere, a forced command) must not replace a way in that works
    // (AUDIT2 MON-05).
    const sealed = unsealKey(ctx, key.id);
    if (!sealed) throw new HttpError(400, 'unknown_key');
    const proof = await connectAndDetect(ctx, id, { ...target, auth: { type: 'key', ...sealed } });
    if (proof.status !== 'ok') return proof;
    useKeyForHost(ctx, id, key.id);
    audit(ctx, actor(req), 'host.install_key', getHost(ctx, id).name, { id, key: key.name });
    return proof;
  });

  /** Install or remove the shell integration (prompt, directory and command reporting). */
  app.put('/api/hosts/:id/shell-integration', change, async (req): Promise<ConnectResult> => {
    const id = idParam(req);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    const target = resolveTarget(ctx, id);
    const conn = await openSsh(ctx, target);
    if (!('client' in conn)) return conn;
    try {
      await setIntegration(conn.client, enabled);
    } catch (err) {
      return { status: 'error', message: (err as Error).message };
    } finally {
      conn.client.end();
    }
    audit(ctx, actor(req), enabled ? 'host.integration_install' : 'host.integration_remove', getHost(ctx, id).name, { id });
    return connectAndDetect(ctx, id, target);
  });

  // ---------------------------------------------------------------- known hosts

  app.get('/api/known-hosts', async () => listKnownHosts(ctx));

  app.delete('/api/known-hosts/:id', change, async (req, reply) => {
    const row = ctx.db.select().from(knownHosts).where(eq(knownHosts.id, idParam(req))).get();
    if (!row) throw new HttpError(404, 'not_found');
    ctx.db.delete(knownHosts).where(eq(knownHosts.id, row.id)).run();
    const kh = toKnownHost(row);
    audit(ctx, actor(req), 'known_host.delete', `${kh.host}:${kh.port}`, { fingerprint: kh.fingerprint });
    return noContent(reply);
  });

  // ---------------------------------------------------------------- keys

  app.get('/api/keys', async () => listKeys(ctx));

  app.post('/api/keys/generate', change, async (req) => {
    const body = parse(keyGenerateInput, req.body);
    const k = generateKey(ctx, body.name, body.comment);
    audit(ctx, actor(req), 'key.generate', k.name, { fingerprint: k.fingerprint });
    return k;
  });

  app.post('/api/keys/import', change, async (req) => {
    const body = parse(keyImportInput, req.body);
    const k = importKey(ctx, body.name, body.privateKey, body.passphrase);
    audit(ctx, actor(req), 'key.import', k.name, { fingerprint: k.fingerprint });
    return k;
  });

  app.delete('/api/keys/:id', change, async (req, reply) => {
    const k = deleteKey(ctx, idParam(req));
    audit(ctx, actor(req), 'key.delete', k.name, { fingerprint: k.fingerprint });
    return noContent(reply);
  });

  // ---------------------------------------------------------------- import

  app.post('/api/import/ssh-config/preview', async (req) => {
    const { text } = parse(importPreviewInput, req.body);
    try {
      return previewImport(ctx, text);
    } catch (err) {
      throw new HttpError(400, 'invalid_ssh_config', (err as Error).message);
    }
  });

  app.post('/api/import/ssh-config/apply', change, async (req) => {
    const body = parse(importApplyInput, req.body);
    const created = ctx.db.transaction(() =>
      body.entries.map((e) =>
        createHost(ctx, {
          name: e.alias,
          address: e.address,
          port: e.port,
          username: e.username,
          keyId: e.keyId,
          authMethod: e.keyId ? 'key' : null,
          groupId: body.groupId ?? null,
          tags: [],
          favorite: false,
        }),
      ),
    );
    audit(ctx, actor(req), 'import.ssh_config', null, { count: created.length });
    return created;
  });
}

async function connectAndDetect(ctx: Ctx, id: number, target: SshTarget): Promise<ConnectResult> {
  const conn = await openSsh(ctx, target);
  if (!('client' in conn)) return conn;
  try {
    const r = await exec(conn.client, FACTS_COMMAND);
    if (!factsComplete(r.code, r.stdout)) return { status: 'error', message: r.stderr.trim().split('\n').pop() || `The host did not answer the facts command (exit ${r.code}).` };
    const facts = parseFacts(r.stdout, ctx.now());
    setFacts(ctx, id, facts);
    return { status: 'ok', facts };
  } catch (err) {
    return { status: 'error', message: (err as Error).message };
  } finally {
    conn.client.end();
  }
}
