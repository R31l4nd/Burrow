import Database from 'better-sqlite3';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/db/index.js';

// An update from any release: a database as each release left it (its
// migrations so far), with a row in every table, brought up to date by the
// migrations since. None may fail, and no row may get lost on the way (a
// migration that rebuilds a table, a NOT NULL column without a default).

const DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const FILES = readdirSync(DIR)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();
const work = mkdtempSync(join(tmpdir(), 'burrow-migrations-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

interface Column {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}
interface ForeignKey {
  table: string;
  from: string;
}

const tables = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'").all() as { name: string }[]).map((r) => r.name);

/** One row in every table, parents first, each column given what its type and constraints ask. */
function fill(db: Database.Database): void {
  const left = new Set(tables(db));
  const done = new Set<string>();
  for (let round = 0; left.size && round < 50; round++) {
    for (const t of [...left]) {
      const fks = db.prepare(`PRAGMA foreign_key_list("${t}")`).all() as ForeignKey[];
      if (fks.some((f) => f.table !== t && !done.has(f.table))) continue;
      const cols = db.prepare(`PRAGMA table_info("${t}")`).all() as Column[];
      // CHECK (x IN ('a', 'b')): the first value allowed.
      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) as { sql: string }).sql;
      const allowed = (col: string) => new RegExp(`\\b${col}\\b"?\\s+IN\\s*\\(\\s*('[^']*'|-?\\d+)`, 'i').exec(sql)?.[1];
      // Optional columns filled too where they can be (a value that is not NULL is what a
      // rebuild could lose, AUDIT ST-20); when a CHECK allows only one of two, without them.
      const row = (optional: boolean) => {
        const names: string[] = [];
        const values: unknown[] = [];
        for (const c of cols) {
          const fk = fks.find((f) => f.from === c.name);
          const integerKey = c.pk === 1 && /INT/i.test(c.type);
          if (integerKey && !fk) continue;
          if (!c.notnull && !c.pk && (!optional || fk)) continue;
          if (c.dflt_value !== null && !optional) continue;
          names.push(`"${c.name}"`);
          const only = allowed(c.name);
          if (only !== undefined) values.push(only.startsWith("'") ? only.slice(1, -1) : Number(only));
          else if (fk) values.push((db.prepare(`SELECT rowid AS id FROM "${fk.table}" LIMIT 1`).get() as { id: number } | undefined)?.id ?? 1);
          else if (/INT/i.test(c.type)) values.push(c.notnull ? 1 : 7);
          else if (/REAL|FLOA|DOUB/i.test(c.type)) values.push(1.5);
          else if (/BLOB/i.test(c.type)) values.push(Buffer.from([1]));
          else values.push(`${t}-${c.name}`);
        }
        db.prepare(`INSERT INTO "${t}" (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...values);
      };
      try {
        row(true);
      } catch {
        row(false);
      }
      left.delete(t);
      done.add(t);
    }
  }
  expect([...left], 'tables that could not be filled').toEqual([]);
}

const counts = (db: Database.Database) => Object.fromEntries(tables(db).map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n]));

/** Every row of every table, as written. */
const snapshot = (db: Database.Database) => Object.fromEntries(tables(db).map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]]));

/** A row's key: its primary key columns, or all of the columns both versions have. */
function keyOf(db: Database.Database, t: string, common: string[]): string[] {
  const pk = (db.prepare(`PRAGMA table_info("${t}")`).all() as Column[]).filter((c) => c.pk > 0).map((c) => c.name);
  return pk.length && pk.every((c) => common.includes(c)) ? pk : common;
}

// Values a migration changes on purpose, with the migration that does.
const CHANGED: Record<string, string> = {
  // The built-in host rule gets the new 'busy' event (CPU or memory high for a while).
  'alert_rules.events': '0026_host_busy.sql',
};

/**
 * The rows still there with what they held: not only as many (a rebuild that
 * emptied a column or swapped values kept the count, AUDIT ST-20).
 */
function sameRows(before: Record<string, Record<string, unknown>[]>, db: Database.Database, from: string): void {
  const wrong: string[] = [];
  for (const [t, rows] of Object.entries(before)) {
    const cols = (db.prepare(`PRAGMA table_info("${t}")`).all() as Column[]).map((c) => c.name);
    if (!cols.length) continue;
    const common = Object.keys(rows[0] ?? {}).filter((c) => cols.includes(c) && !CHANGED[`${t}.${c}`]);
    const key = keyOf(db, t, common);
    const now = db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[];
    for (const r of rows) {
      const match = now.find((x) => key.every((k) => JSON.stringify(x[k]) === JSON.stringify(r[k])));
      if (!match) {
        wrong.push(`${t}: row ${key.map((k) => `${k}=${String(r[k])}`).join(',')} gone`);
        continue;
      }
      for (const c of common) if (JSON.stringify(match[c]) !== JSON.stringify(r[c])) wrong.push(`${t}.${c}: ${JSON.stringify(r[c])} became ${JSON.stringify(match[c])}`);
    }
  }
  expect(wrong, `values changed by the update from ${from}`).toEqual([]);
}

describe('an update from every earlier schema', () => {
  for (let n = 1; n < FILES.length; n++) {
    it(`from ${FILES[n - 1]}`, () => {
      const dir = join(work, `upto-${n}`);
      cpSync(DIR, dir, { recursive: true, filter: (src) => src === DIR || src.replace(/\/$/, '') === DIR.replace(/\/$/, '') || FILES.slice(0, n).some((f) => src.endsWith(`/${f}`)) });
      const file = join(work, `db-${n}.sqlite`);
      const old = new Database(file);
      old.pragma('foreign_keys = ON');
      migrate(old, dir);
      fill(old);
      const before = counts(old);
      const held = snapshot(old);
      old.close();
      // The current release opens it, as the server does at start.
      const db = openDb(file);
      const after = counts(db.$client);
      // Not one row fewer (a later migration may add its own, a built-in alert rule).
      for (const [t, rows] of Object.entries(before)) expect(after[t], `rows of ${t} after the update from ${FILES[n - 1]}`).toBeGreaterThanOrEqual(rows);
      sameRows(held, db.$client, FILES[n - 1]!);
      expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect((db.$client.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
      db.$client.close();
      // Thirty-odd migrations twice, beside the other test files: seconds on a busy machine.
    }, 30_000);
  }
});

describe('the write-ahead log', () => {
  it('shrinks back to a bounded size after a big prune (journal_size_limit), not kept at its largest', () => {
    const db = openDb(join(work, 'wal.db'));
    try {
      expect(db.$client.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.$client.pragma('journal_size_limit', { simple: true })).toBe(64 << 20);
    } finally {
      db.$client.close();
    }
  });
});
