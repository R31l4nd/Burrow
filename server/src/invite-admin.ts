import { join } from 'node:path';
import { consoleAdminInvite } from './auth/users.js';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';

// An admin invite from the console, for an owner locked out of Burrow
// (docs/DEPLOY.md, "Locked out"):
//
//   docker compose exec burrow node dist/invite-admin.js
//
// Prints a one-time link (seven days) that makes a new admin account.

const config = loadConfig();
const db = openDb(join(config.dataDir, 'burrow.db'));
const invite = consoleAdminInvite({ db, now: Date.now, config });
db.$client.close();
console.log(['', '  An admin invite, once, for seven days. Open it to make a new admin account:', '', `  ${invite.url}`, '', '  Then sign in with it and, in Settings -> Users, set the old account right or remove it.', ''].join('\n'));
