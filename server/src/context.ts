import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { SecretBox } from './crypto.js';
import type { Db } from './db/index.js';

// Everything a route or service needs, passed explicitly so tests can swap in
// an in-memory database, a fixed clock or a fake SSH layer.
export interface Ctx {
  config: Config;
  db: Db;
  box: SecretBox;
  log: FastifyBaseLogger;
  now: () => number;
}
