import { and, desc, lt } from 'drizzle-orm';
import type { AuditEntry } from '@burrow/shared';
import type { Ctx } from './context.js';
import { auditLog } from './db/schema.js';

// Who did what, when and from where. Terminal content is never logged; the
// details field carries identifiers, not payloads.

export interface Actor {
  userId: number | null;
  username: string | null;
  ip: string | null;
}

export function audit(
  ctx: Ctx,
  actor: Actor,
  action: string,
  target?: string | null,
  details?: Record<string, unknown>,
): void {
  // Also in the container log, as a readable line: "auth.login admin".
  // Failures stand out as warnings.
  const line = { user: actor.username, ip: actor.ip, ...(details ?? {}) };
  const msg = target ? `${action} ${target}` : action;
  if (/failed|denied|blocked|revoked/.test(action)) ctx.log.warn(line, msg);
  else ctx.log.info(line, msg);
  ctx.db
    .insert(auditLog)
    .values({
      at: ctx.now(),
      userId: actor.userId,
      username: actor.username,
      ip: actor.ip,
      action,
      target: target ?? null,
      details: details ? JSON.stringify(details) : null,
    })
    .run();
}

export function listAudit(ctx: Ctx, opts: { limit: number; before?: number }): AuditEntry[] {
  const rows = ctx.db
    .select()
    .from(auditLog)
    .where(opts.before ? and(lt(auditLog.id, opts.before)) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(opts.limit)
    .all();
  return rows.map((r) => ({
    id: r.id,
    at: new Date(r.at).toISOString(),
    username: r.username,
    ip: r.ip,
    action: r.action,
    target: r.target,
    details: r.details ? (JSON.parse(r.details) as Record<string, unknown>) : null,
  }));
}
