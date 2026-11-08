import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { setupBanner } from './auth/setup.js';
import { loadConfig } from './config.js';
import { checkMasterKey, loadMasterSecret, MasterKeyError, SecretBox } from './crypto.js';
import { openDb } from './db/index.js';

async function main() {
  // The database holds password hashes and sealed secrets; nothing Burrow
  // writes needs to be readable by anyone else.
  process.umask(0o077);
  const config = loadConfig();
  config.publicDir = process.env.BURROW_PUBLIC_DIR ?? fileURLToPath(new URL('../public/', import.meta.url));
  mkdirSync(config.dataDir, { recursive: true });

  const generated: string[] = [];
  const secret = loadMasterSecret({
    secret: config.secret,
    secretFile: config.secretFile,
    dataDir: config.dataDir,
    onGenerated: (p) => generated.push(p),
  });
  const db = openDb(join(config.dataDir, 'burrow.db'));
  const box = new SecretBox(secret);
  const source = config.secret ? 'BURROW_SECRET' : config.secretFile ? `BURROW_SECRET_FILE ${config.secretFile}` : generated.length ? `${generated[0]}, generated just now as none was found` : join(config.dataDir, 'secret.key');
  let keyCheck: ReturnType<typeof checkMasterKey>;
  try {
    keyCheck = checkMasterKey(db.$client, box, { source, now: Date.now() });
  } catch (err) {
    // A key made just now over a database it does not open is not kept: a restore puts the old one in its place.
    if (err instanceof MasterKeyError) for (const p of generated) rmSync(p, { force: true });
    throw err;
  }
  const { app, gate, status, terminals } = await buildApp({ config, db, box });
  // A promise rejected without a handler (a background job's bug): said, and Burrow goes on. Node
  // ended the process for it, with every terminal session and job of everyone in it.
  process.on('unhandledRejection', (reason) => app.log.error({ err: reason }, 'unhandled rejection (Burrow goes on)'));
  // A throw nothing caught leaves the process in a state nobody knows: said in Burrow's own log
  // first (Node's own message went only to stderr), then ended, for the container to be started again.
  process.on('uncaughtException', (err) => {
    app.log.fatal({ err }, 'uncaught exception: Burrow stops');
    process.exit(1);
  });

  if (keyCheck === 'unsaved') app.log.warn('The master key check could not be saved (the data disk full?); it is saved at a later start.');
  for (const p of generated) {
    app.log.warn(`Generated a new master key at ${p}. Back it up: without it stored SSH keys cannot be decrypted.`);
  }
  // Printed straight to stdout, not through the JSON logger, so it is
  // readable in `docker compose logs`.
  gate.announce((token) => process.stdout.write(setupBanner(token, config.origin)));

  status.start(config.statusIntervalSeconds);
  terminals.start();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    db.$client.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
