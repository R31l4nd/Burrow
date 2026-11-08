import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/**
 * Open (or create) the database and bring the schema up to date. Pass
 * ':memory:' for tests.
 */
export function openDb(file: string, migrationsDir = MIGRATIONS_DIR): Db {
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  migrate(sqlite, migrationsDir);
  return drizzle(sqlite, { schema }) as Db;
}

/**
 * Apply every migrations/NNNN_*.sql that has not run yet, each in its own
 * transaction. Files are never edited after release; a change is a new file.
 */
export function migrate(sqlite: Database.Database, dir: string): string[] {
  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set(
    sqlite
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((r) => (r as { version: string }).version),
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(`${dir}/${f}`, 'utf8');
    sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(f, Date.now());
    })();
    applied.push(f);
  }
  return applied;
}

export { schema };
