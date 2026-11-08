import { and, desc, eq, lt, ne, or, sql } from 'drizzle-orm';
import { skipReason, type SnippetSuggestion } from '@burrow/shared';
import { SUGGEST_MIN_COUNT, worthSuggesting } from '@burrow/shared/snippets';
import type { Ctx } from '../context.js';
import { appSettings, commandHistory, commandPairs } from '../db/schema.js';

// Command history per host, for auto-complete. Stored encrypted; an HMAC of
// the command finds repeats so they are counted, not duplicated.
//
// Not everything is kept: a command that starts with a space (the shell
// convention of HISTCONTROL=ignorespace), and anything that looks like it
// carries a secret, is never written.

const CONTEXT = 'command_history';
// Kept per host; the least used and oldest go first.
const MAX_PER_HOST = 5000;

const MAX_PAIRS_PER_HOST = 5000;

/**
 * Record a command; returns false if it was skipped. `previous`: the command
 * run just before it in the same session, so the pair is learnt too ("after
 * cd /srv/app comes docker compose logs -f").
 */
export function recordCommand(ctx: Ctx, hostId: number, raw: string, at = ctx.now(), previous?: string | null): boolean {
  const command = raw.replace(/\r?\n$/, '');
  if (skipReason(command) !== null) return false;
  const hash = ctx.box.mac(command, CONTEXT);
  if (previous && previous !== command && skipReason(previous) === null) recordPair(ctx, hostId, ctx.box.mac(previous, CONTEXT), hash, at);
  ctx.db
    .insert(commandHistory)
    .values({ hostId, hash, commandEnc: ctx.box.seal(command, CONTEXT), count: 1, firstAt: at, lastAt: at })
    .onConflictDoUpdate({
      target: [commandHistory.hostId, commandHistory.hash],
      // An older use coming in later (an imported history) keeps the newer time (AUDIT2 FS-29).
      set: { count: sql`${commandHistory.count} + 1`, lastAt: sql`max(${commandHistory.lastAt}, ${at})`, firstAt: sql`min(${commandHistory.firstAt}, ${at})` },
    })
    .run();
  prune(ctx, hostId, hash);
  return true;
}

/** Used once and not again in this long: a one-off, forgotten (report 94c9eb). */
const ONE_OFF_MS = 30 * 86_400_000;

function prune(ctx: Ctx, hostId: number, keep: string): void {
  // Not the one just written (an imported history's old lines come in one by one).
  ctx.db
    .delete(commandHistory)
    .where(and(eq(commandHistory.hostId, hostId), eq(commandHistory.count, 1), lt(commandHistory.lastAt, ctx.now() - ONE_OFF_MS), ne(commandHistory.hash, keep)))
    .run();
  const n = ctx.db.select({ n: sql<number>`count(*)` }).from(commandHistory).where(eq(commandHistory.hostId, hostId)).get()?.n ?? 0;
  if (n <= MAX_PER_HOST) return;
  const drop = ctx.db
    .select({ id: commandHistory.id })
    .from(commandHistory)
    .where(eq(commandHistory.hostId, hostId))
    .orderBy(commandHistory.count, commandHistory.lastAt)
    .limit(n - MAX_PER_HOST)
    .all();
  for (const d of drop) ctx.db.delete(commandHistory).where(eq(commandHistory.id, d.id)).run();
}

function recordPair(ctx: Ctx, hostId: number, prevHash: string, nextHash: string, at: number): void {
  ctx.db
    .insert(commandPairs)
    .values({ hostId, prevHash, nextHash, count: 1, lastAt: at })
    .onConflictDoUpdate({ target: [commandPairs.hostId, commandPairs.prevHash, commandPairs.nextHash], set: { count: sql`${commandPairs.count} + 1`, lastAt: at } })
    .run();
  const n = ctx.db.select({ n: sql<number>`count(*)` }).from(commandPairs).where(eq(commandPairs.hostId, hostId)).get()?.n ?? 0;
  if (n <= MAX_PAIRS_PER_HOST) return;
  const drop = ctx.db.select({ id: commandPairs.id }).from(commandPairs).where(eq(commandPairs.hostId, hostId)).orderBy(commandPairs.count, commandPairs.lastAt).limit(n - MAX_PAIRS_PER_HOST).all();
  for (const d of drop) ctx.db.delete(commandPairs).where(eq(commandPairs.id, d.id)).run();
}

export interface HistoryEntry {
  command: string;
  count: number;
  lastAt: string;
  // Frecency score: frequency weighted by how recent the last use was.
  score: number;
  /** What usually comes next after this command (most often first, at most three). */
  next: string[];
}

/** Frecency: each use counts, and weighs less the longer ago the last one was. */
export function frecency(count: number, lastAt: number, now: number): number {
  const days = Math.max(0, (now - lastAt) / 86_400_000);
  const recency = days < 1 ? 4 : days < 7 ? 2 : days < 30 ? 1 : days < 90 ? 0.5 : 0.25;
  return Math.round(Math.log2(1 + count) * recency * 1000) / 1000;
}

export function listHistory(ctx: Ctx, hostId: number, limit: number): HistoryEntry[] {
  const now = ctx.now();
  const rows = ctx.db.select().from(commandHistory).where(eq(commandHistory.hostId, hostId)).orderBy(desc(commandHistory.lastAt)).limit(MAX_PER_HOST).all();
  const byHash = new Map(rows.map((r) => [r.hash, ctx.box.open(r.commandEnc, CONTEXT)]));
  // After each command: the ones that followed it most often (and still exist).
  const next = new Map<string, string[]>();
  const pairs = ctx.db.select().from(commandPairs).where(eq(commandPairs.hostId, hostId)).orderBy(desc(commandPairs.count), desc(commandPairs.lastAt)).all();
  for (const p of pairs) {
    const after = byHash.get(p.nextHash);
    if (!after || !byHash.has(p.prevHash)) continue;
    const list = next.get(p.prevHash) ?? [];
    if (list.length < 3) next.set(p.prevHash, [...list, after]);
  }
  return rows
    .map((r) => ({
      command: byHash.get(r.hash)!,
      count: r.count,
      lastAt: new Date(r.lastAt).toISOString(),
      score: frecency(r.count, r.lastAt, now),
      next: next.get(r.hash) ?? [],
    }))
    .sort((a, b) => b.score - a.score || b.lastAt.localeCompare(a.lastAt))
    .slice(0, limit);
}

export function clearHistory(ctx: Ctx, hostId: number): number {
  ctx.db.delete(commandPairs).where(eq(commandPairs.hostId, hostId)).run();
  return ctx.db.delete(commandHistory).where(eq(commandHistory.hostId, hostId)).run().changes;
}

export function deleteCommand(ctx: Ctx, hostId: number, command: string): boolean {
  const hash = ctx.box.mac(command, CONTEXT);
  // Forgotten: not suggested after anything, nor followed by anything.
  ctx.db.delete(commandPairs).where(and(eq(commandPairs.hostId, hostId), or(eq(commandPairs.prevHash, hash), eq(commandPairs.nextHash, hash)))).run();
  return ctx.db.delete(commandHistory).where(and(eq(commandHistory.hostId, hostId), eq(commandHistory.hash, hash))).run().changes > 0;
}

// Suggested snippets (report 8f829d): the commands typed most often, on
// all hosts together, that are not a snippet yet and were not hidden.
const DISMISSED_KEY = 'snippets.dismissed';
const MAX_DISMISSED = 500;

function dismissed(ctx: Ctx): string[] {
  const v = ctx.db.select().from(appSettings).where(eq(appSettings.key, DISMISSED_KEY)).get()?.value;
  try {
    return v ? (JSON.parse(v) as string[]) : [];
  } catch {
    return [];
  }
}

export function commandSuggestions(ctx: Ctx, snippetCommands: string[], limit = 8): SnippetSuggestion[] {
  const skip = new Set([...dismissed(ctx), ...snippetCommands.map((c) => ctx.box.mac(c.trim(), CONTEXT))]);
  const rows = ctx.db.select().from(commandHistory).all();
  const byHash = new Map<string, { enc: string; count: number; hostIds: Set<number>; lastAt: number }>();
  for (const r of rows) {
    if (skip.has(r.hash)) continue;
    const e = byHash.get(r.hash);
    if (e) {
      e.count += r.count;
      e.hostIds.add(r.hostId);
      e.lastAt = Math.max(e.lastAt, r.lastAt);
    } else byHash.set(r.hash, { enc: r.commandEnc, count: r.count, hostIds: new Set([r.hostId]), lastAt: r.lastAt });
  }
  const out: SnippetSuggestion[] = [];
  for (const e of [...byHash.values()].filter((e) => e.count >= SUGGEST_MIN_COUNT).sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)) {
    // Opened only for the ones in the running: a few, not every command.
    const command = ctx.box.open(e.enc, CONTEXT);
    if (!worthSuggesting(command)) continue;
    out.push({ command, count: e.count, hostIds: [...e.hostIds].sort((a, b) => a - b), lastAt: new Date(e.lastAt).toISOString() });
    if (out.length >= limit) break;
  }
  return out;
}

/** Not suggested again (the history itself is kept: completion still offers it). */
export function dismissSuggestion(ctx: Ctx, command: string): void {
  const hash = ctx.box.mac(command, CONTEXT);
  const list = [hash, ...dismissed(ctx).filter((h) => h !== hash)].slice(0, MAX_DISMISSED);
  const value = JSON.stringify(list);
  ctx.db
    .insert(appSettings)
    .values({ key: DISMISSED_KEY, value, updatedAt: ctx.now() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: ctx.now() } })
    .run();
}

/**
 * Parse a bash or zsh history file. zsh's extended format prefixes lines
 * with ": <epoch>:<duration>;". Multi-line entries (a trailing backslash)
 * are joined.
 */
/**
 * A shell's history files read in (parseHistoryFile each), each entry once:
 * the lines an earlier import of this host took are skipped, so importing
 * twice does not count every command twice (AUDIT2 FS-29). An entry is
 * known by its command and its time, or (no time in the file) by how many
 * times the same command came before it in that file.
 */
export function importHistory(ctx: Ctx, hostId: number, files: string[], undated: number): { imported: number; skipped: number } {
  const key = `history_import:${hostId}`;
  const row = ctx.db.select().from(appSettings).where(eq(appSettings.key, key)).get();
  const before = new Set<string>(row ? (JSON.parse(row.value) as string[]) : []);
  const now: string[] = [];
  let imported = 0;
  let skipped = 0;
  for (const part of files) {
    // In the file's order: which command followed which is learnt too.
    let previous: string | null = null;
    const seen = new Map<string, number>();
    for (const e of parseHistoryFile(part)) {
      const mac = ctx.box.mac(e.command, CONTEXT);
      const n = (seen.get(mac) ?? 0) + 1;
      seen.set(mac, n);
      const id = `${mac.slice(0, 16)}:${e.at ?? `#${n}`}`;
      now.push(id);
      if (before.has(id)) skipped++;
      else if (recordCommand(ctx, hostId, e.command, e.at ?? undated, previous)) imported++;
      else skipped++;
      previous = e.command;
    }
  }
  const value = JSON.stringify(now.slice(-20_000));
  ctx.db.insert(appSettings).values({ key, value, updatedAt: ctx.now() }).onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: ctx.now() } }).run();
  return { imported, skipped };
}

export function parseHistoryFile(text: string): { command: string; at: number | null }[] {
  const out: { command: string; at: number | null }[] = [];
  let pending: string | null = null;
  let pendingAt: number | null = null;
  let nextAt: number | null = null;
  for (const rawLine of text.split('\n')) {
    let line = rawLine.replace(/\r$/, '');
    if (pending === null) {
      // bash HISTTIMEFORMAT comment line: #1712345678
      const ts = /^#(\d{9,11})$/.exec(line);
      if (ts) {
        nextAt = Number(ts[1]) * 1000;
        continue;
      }
      const z = /^: (\d{9,11}):\d+;(.*)$/.exec(line);
      if (z) {
        nextAt = Number(z[1]) * 1000;
        line = z[2]!;
      }
    }
    const continues = line.endsWith('\\');
    const part = continues ? line.slice(0, -1) : line;
    if (pending === null) {
      pending = part;
      pendingAt = nextAt;
      nextAt = null;
    } else {
      pending += `\n${part}`;
    }
    if (!continues) {
      if (pending.trim()) out.push({ command: pending, at: pendingAt });
      pending = null;
      pendingAt = null;
    }
  }
  return out;
}
