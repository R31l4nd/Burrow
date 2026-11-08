// The hardening of compose.yaml as users run it, read from `docker compose
// config --format json` (scripts/check-compose.sh): e2e starts the image with
// flags of its own, so losing one of these in compose.yaml passed the gate
// (A3-OPS-20). Run with the default settings (no .env) and with compose.try.yaml.
import { readFileSync } from 'node:fs';

const [defaults, trying, folder] = process.argv.slice(2, 5).map((f) => JSON.parse(readFileSync(f, 'utf8')));
// The checkout as compose sees it (on the host, not in the node container this runs in).
const root = process.argv[5];
const bad = [];
const want = (ok, what) => ok || bad.push(what);

for (const name of ['burrow', 'backup']) {
  const s = defaults.services?.[name];
  if (!s) {
    bad.push(`no service ${name}`);
    continue;
  }
  want(s.read_only === true, `${name}: read_only`);
  want((s.cap_drop ?? []).includes('ALL'), `${name}: cap_drop ALL`);
  want((s.cap_add ?? []).length === 0, `${name}: no cap_add`);
  want((s.security_opt ?? []).includes('no-new-privileges:true'), `${name}: no-new-privileges`);
  want(!s.privileged, `${name}: not privileged`);
  want((s.tmpfs ?? []).some((t) => t.split(':')[0] === '/tmp'), `${name}: /tmp on a tmpfs`);
  want(!s.ports?.length, `${name}: no published port`);
  want(!(s.volumes ?? []).some((v) => String(v.source).includes('docker.sock')), `${name}: no Docker socket`);
  want(s.logging?.options?.['max-size'], `${name}: log rotation`);
  // Bounded, so a runaway language server or fork loop cannot starve the
  // Docker host and the services beside it (A3-OPS-09).
  want(Number(s.mem_limit) > 0, `${name}: mem_limit`);
  want(Number(s.pids_limit) > 0, `${name}: pids_limit`);
}
const app = defaults.services?.burrow ?? {};
const backup = defaults.services?.backup ?? {};
// The image runs as the node user (USER node); compose must not override it with root.
want(!app.user || !/^(0|root)(:|$)/.test(app.user), 'burrow: not root');
want(app.init === true, 'burrow: init');
want((app.tmpfs ?? []).some((t) => /^\/tmp:.*size=/.test(t)), 'burrow: /tmp tmpfs with a size');
want(backup.user === '1000:1000', 'backup: user 1000:1000');
want(backup.network_mode === 'none', 'backup: no network');
// SWAG's auto-proxy only when asked for (SWAG_ENABLE=enable): on by default it
// published Burrow on a stranger's internet-facing SWAG (A3-OPS-02).
want(app.labels?.swag === 'disable', 'burrow: the swag label is disable by default');
// Trying it (compose.try.yaml): published on this machine's loopback only.
const ports = trying.services?.burrow?.ports ?? [];
want(ports.length > 0 && ports.every((p) => p.host_ip === '127.0.0.1'), 'compose.try.yaml: burrow published on 127.0.0.1 only');

// The data: the named volume by default; a folder given relative to the
// checkout (BURROW_DATA=./data/live, deploy/local) is that folder, for
// Burrow and its backup alike: out of a folder (such as /srv/appdata) that the host's
// file-by-file backup copies while the database changes (report 4b9965).
const dataOf = (cfg, name) => (cfg.services?.[name]?.volumes ?? []).find((v) => v.target === '/data');
for (const name of ['burrow', 'backup']) {
  const d = dataOf(defaults, name);
  want(d?.type === 'volume' && d.source === 'burrow-data', `${name}: /data on the burrow-data volume by default`);
  if (!folder) continue;
  const f = dataOf(folder, name);
  want(f?.type === 'bind' && f.source === `${root}/data/live`, `${name}: BURROW_DATA=./data/live is ${root}/data/live (got ${f?.type} ${f?.source})`);
}

if (bad.length) {
  console.log(`compose.yaml lost its hardening:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log('compose.yaml: hardening in place for burrow and backup');
