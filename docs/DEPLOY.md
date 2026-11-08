# Deploy

## Requirements

- Docker with Compose v2.
- A reverse proxy with TLS on a Docker network (SWAG, Traefik, Caddy, nginx
  proxy manager, ...). Burrow publishes no port.
- Reach it over LAN or VPN only. **Do not expose Burrow to the internet.**

## Configure

```sh
cp .env.example .env
```

Point the proxy at `http://burrow:8080`. WebSocket upgrades must be passed
through: the terminal uses them. SWAG's default `proxy.conf` does this.

| Variable | Meaning |
|---|---|
| `BURROW_ORIGIN` | The https URL you open Burrow on. Passkeys are bound to its hostname. Required. |
| `PROXY_NETWORK` | The Docker network your proxy is on (default `proxy`, must exist). |
| `TRUST_PROXY` | **Set it behind a proxy**: IP or CIDR of the proxy (usually the proxy network's subnet: `docker network inspect proxy -f '{{(index .IPAM.Config 0).Subnet}}'`). Empty, every request seems to come from the proxy: ten failed sign-ins from any device block sign-in for everyone for 15 minutes, and the audit log shows only the proxy. Leave it empty only without a proxy. Requests through a proxy it does not name (empty, or an address the proxy no longer has) are said in the log, on `/healthz` (`hints: ["trust_proxy"]`) and to admins at the top of Settings, with the network to set. |
| `BURROW_DATA` | Named volume (default) or host path for the database and master key. A host path must exist and be owned by uid 1000 first (`sudo mkdir -p /srv/burrow && sudo chown 1000:1000 /srv/burrow`): Docker would make it root's, and Burrow could not write. A path in the checkout starts with `./` (`./data/live`, relative to `compose.yaml`; without the `./` it is taken for a volume name): `data/` is git-ignored and outside the image's build context. Keep it out of a folder another backup copies file by file while Burrow runs (its SQLite files change during the copy); Burrow's own backups are consistent. |
| `BURROW_SECRET` | Optional master key (32+ characters). Empty: generated in the data volume. As an environment value it shows in `docker inspect`; a file is better, see [The master key as a file](#the-master-key-as-a-file). |
| `SWAG_ENABLE` | `enable` lets SWAG's auto-proxy pick Burrow up from its labels. Off by default: serve `SWAG_URL` to your LAN or VPN only first (docs/INSTALL.md, SWAG). |
| `SWAG_URL` | The name SWAG's auto-proxy serves Burrow on (default `burrow.local.*`). |
| `TERMINAL_MAX_SESSIONS` | Most terminal sessions open at once (default 20). A session without tmux keeps its 5000 lines of history in Burrow's memory, about 8 MB once full; one in tmux (the default where the host has tmux) keeps it on the host. Raising this, or lowering `BURROW_MEM_LIMIT`, leave room for that: near the limit output slows down, and when Node runs out every session without tmux goes at once. |
| `BURROW_MEM_LIMIT`, `BURROW_PIDS_LIMIT`, `BURROW_TMP_SIZE` | Limits of Burrow's container: memory (default `2g`), processes (`512`) and its `/tmp`, which is memory too (`256m`). `BACKUP_MEM_LIMIT` (`2g`) and `BACKUP_PIDS_LIMIT` (`64`) for the backup service; a backup round needs about three times the database in memory. |
| `TERMINAL_IDLE_MINUTES` | Close sessions nobody watches after this many idle minutes; 0 (default) never. |
| `STATUS_INTERVAL_SECONDS` | How often each host's SSH port is tried for the online dot on Hosts, in seconds (default 60); 0 turns it off. |
| `APPS_BASE_DOMAIN` | Fills the `*` in SWAG `swag_url` labels when finding apps. Default: the origin's last two labels (`burrow.home.example.com` -> `example.com`). |
| `UPDATE_CHECK_EXCLUDE` | Images the update check skips, as a regular expression on the image name, e.g. `^registry\.example\.com/` for a private registry. |
| `BURROW_IGNORE_LABEL` | A container label (default `burrow.ignore`): containers with it set to `true` get no alerts, update checks or reports, but are still listed. Useful for throwaway and CI containers. |
| `REGISTRY_ENDPOINTS` | Where Burrow reaches a registry whose name means something else inside its container, e.g. `localhost:5000=http://172.17.0.1:5000`. Comma separated. |
| `LOG_LEVEL` | Burrow's log level (default `info`; `debug` adds every read). Warnings and errors are also kept in Burrow's database for 30 days (Settings -> About). |
| `LOG_MAX_SIZE`, `LOG_MAX_FILES` | Docker's log of each container: the size of one file (default `10m`) and how many are kept (`5`). |
| `HEARTBEAT_URL` | A dead-man switch: Burrow calls this address (a plain GET) every five minutes while it runs well, and a service there, such as Healthchecks or an Uptime Kuma push monitor, tells you when the calls stop: Burrow down, stuck, its data disk full, or its host gone. Burrow's own notifications cannot tell you that. |
| `BACKUP_DIR` | Where the backups go (default `./backups`, owned by uid 1000). |
| `BURROW_ANDROID_CERT_SHA256` | Signing certificate fingerprint(s) of the Android app for `assetlinks.json`. Only needed for passkeys in the app on a public hostname; leave empty. |

`TERMINAL_MAX_SESSIONS`, `TERMINAL_IDLE_MINUTES`, `STATUS_INTERVAL_SECONDS`, `APPS_BASE_DOMAIN`, `UPDATE_CHECK_EXCLUDE`, `REGISTRY_ENDPOINTS` and `HEARTBEAT_URL` can also be set by an admin in Settings -> System, without a restart. A value set there goes before the `.env`'s; a field left empty there keeps the `.env`'s value, and says what it is.

### The master key as a file

Instead of `BURROW_SECRET` (visible in `docker inspect`), a Docker secret,
in a `compose.override.yaml` next to `compose.yaml`:

```yaml
services:
  burrow:
    environment:
      BURROW_SECRET_FILE: /run/secrets/burrow_secret
    secrets: [burrow_secret]
secrets:
  burrow_secret:
    file: ./secrets/burrow_secret
```

```sh
(umask 077; openssl rand -base64 48 > secrets/burrow_secret)
sudo chown 1000:1000 secrets/burrow_secret   # Burrow's user; it refuses a key others can read
```

For a new installation: an existing one keeps its key in the data volume
(`secret.key`), and a different key cannot read the stored secrets. Back
the file up like the backup key: it is not in any backup.

## First start

```sh
docker compose up -d --build
docker compose logs burrow
```

The log shows a one-time setup token. Open `BURROW_ORIGIN`, enter it, pick a
username, register a passkey (or a password plus an authenticator app), and
store the ten recovery codes somewhere safe. The token changes on every
restart until setup is finished.

## Backups

Burrow's state is the SQLite database and the master key. Enable the backup
container. It runs as uid 1000, so the key file and the backup folder must
be readable and writable by that user (Docker would make a missing folder
owned by root):

```sh
(umask 077; openssl rand -base64 48 > secrets/backup_encryption_key)
mkdir -p backups
# Private from the start (umask), then given to uid 1000: chmod after the
# chown would no longer be yours to run.
sudo chown 1000:1000 secrets/backup_encryption_key backups
echo COMPOSE_PROFILES=backup >> .env
docker compose up -d
```

Then make the first one and check it; only when this works are backups set
up (Settings -> Backups shows the last one too):

```sh
make backup
make verify-backup FILE=backups/<the file it wrote>
```

It writes `backups/burrow-<timestamp>.tar.gz.enc` daily (AES-256-GCM, with a
SHA-256 file) and keeps every backup of the last 30 days
(`BACKUP_RETENTION_DAYS`), but at most the newest 60
(`BACKUP_RETENTION_MAX`: every deploy, update and *Back up now* adds a
round), and always the newest 30 (`BACKUP_RETENTION_COUNT`) whatever their
age, so a backup service that stopped working does not end with none. A
copy cut off by a kill (`*.partial`) is removed after a day. A restart of the backup
service makes no extra round when the last one is younger than
`BACKUP_INTERVAL_SECONDS`. The backup service turns unhealthy when its
last good round is older than `BACKUP_HEALTH_MAX_AGE_MINUTES` (default
1560, 26 hours): raise it with a longer interval. `BACKUP_REMOTE_ENABLED=1` with
`BACKUP_REMOTE_DIR` on another disk adds a verified second copy (that
folder owned by uid 1000 as well).

- Now: `make backup`
- Check one without touching anything: `make verify-backup FILE=backups/...`
- Restore: `bash scripts/restore.sh backups/...`. It decrypts and checks the
  backup while Burrow still runs, then stops Burrow (and the backup service)
  only for the swap. The database and key it replaced are kept in the data
  volume under `.before-restore/`.

### What to keep to recover

A backup holds the database and, when there is one, `secret.key`. To
recover on a new machine you need all of these, kept apart from the machine:

| What | Why |
|---|---|
| The backup archive and its `.sha256` | The database (hosts, keys, users, settings, history). |
| `secrets/backup_encryption_key` | Without it the archive cannot be opened. |
| `BURROW_SECRET` (or `BURROW_SECRET_FILE`'s file), if you set one | It is the master key then, not `secret.key`, and it is not in any backup. It wins over a restored `secret.key`: restore with the same value, or the stored passwords and keys cannot be read. |
| `.env` and any compose override you use | How Burrow was configured (origin, networks, profiles). |
| `android/keystore/` and `.env.build` | Without them no app update installs over the app on the phones. |

Not in a backup: `recordings/` (terminal recordings; copy the folder from
the data volume if you want to keep them), `bugreports/` (problem reports
sent from the app, the same) and `downloads/` (the APK offered for
download: `make apk` puts it back).

### Off this machine

The second copy (`BACKUP_REMOTE_DIR`) is another disk of the same machine:
theft, fire, a power supply that takes both disks, or ransomware on the
host still loses everything. Copy the archives elsewhere as well, for
example each night with rclone to another machine or a cloud bucket (the
archives are encrypted; the key never goes along):

```sh
# crontab -e on the Docker host
30 3 * * * rclone copy /path/to/burrow/backups remote:burrow-backups --include 'burrow-*.tar.gz.enc*'
```

Keep `secrets/backup_encryption_key`, `.env` and the Android signing key
(`android/keystore/`, `.env.build`) in a password manager, not only on this
machine.

After a restore, sign in and open a host's terminal or a stored password:
that proves the master key matches, which the archive's own check cannot.

## Android app

Once per installation, make the signing key and **back it up** together
with `.env.build` - without it no update of the app can be installed over
the old one:

```sh
cp .env.build.example .env.build   # set KEYSTORE_PASSWORD (openssl rand -base64 24)
make apk-keystore
```

Then, after every Burrow update:

```sh
make apk
```

It builds the direct route's page into the app, then builds and signs the APK in a container (the first time downloads about
2 GB of Android SDK) and puts it in the running Burrow's data directory. On
the phone: Settings -> Android app -> Download, install (Android asks once to
allow this source), open, enter the server address, and pair with a code
from Settings on a signed-in device (or sign in with your password and then
tap *Use fingerprint on this phone*).

Each GitHub release also carries an APK signed with the project's key
(when the project has one). It works the same, but Android installs an
update only over an app signed with the same key: once you use one kind,
stay with it, or uninstall the app first (pairing again afterwards).

## Upgrade, roll back, recover

### Upgrade

1. Read what the new version asks of you: the `### Breaking` items in
   [CHANGELOG.md](../CHANGELOG.md) of every version after yours (Settings
   -> About lists them before a self-update; by hand
   `git fetch && git show @{u}:CHANGELOG.md`).
2. Make a backup and note its name: `make backup` (the self-update makes
   one too when the backup service runs).
3. Update:

   ```sh
   git pull
   PKG_DATE=$(date +%F) docker compose up -d --build
   ```

   `PKG_DATE` gives the backup image today's Alpine packages. Migrations
   run at start-up and only go forward. Settings -> About does the same:
   it builds (a git checkout) or pulls (prebuilt images) Burrow and its
   backup service, makes a backup first when the backup service runs, and
   starts the backup service again once Burrow is healthy; an update that
   does not become healthy is rolled back by itself.

### Roll back by hand

Migrations only go forward, so going back is the older version plus the
backup made before the upgrade (step 2), not the older version alone:

```sh
git checkout vX.Y.Z                 # the version you ran before (git tag lists them)
docker compose build                # its images, the backup service's too
docker compose up -d --no-start     # its containers, not started
bash scripts/restore.sh backups/burrow-<made before the upgrade>.tar.gz.enc
docker compose up -d
```

Back on the release line later: `git checkout main`, then upgrade as
above (a checked-out tag has no upstream to pull from).

### Recover on a new machine

What you need is listed under [What to keep to recover](#what-to-keep-to-recover).

1. Docker, then `git clone` Burrow (the same version as the backup, or a
   newer one) and `cd` into it.
2. Put back `.env` (and any compose override), `secrets/backup_encryption_key`
   (owned by uid 1000, as in [Backups](#backups)), and the archive with its
   `.sha256` in `backups/`. A data folder (`BURROW_DATA=/srv/...`) must
   exist and be owned by uid 1000 first.
3. Start it once, so there is a container and a data volume to restore
   into (`restore.sh` stops and starts that container):
   `docker compose up -d --build`. The new, empty Burrow it starts is
   replaced in the next step.
4. `bash scripts/restore.sh backups/burrow-<timestamp>.tar.gz.enc`.
5. Sign in and open a host's terminal or a stored password: that proves
   the master key matches.

### Locked out

When nobody can sign in any more (the last admin lost the passkey, the
recovery codes and the password), whoever can run a command on Burrow's
host gets a new admin account, without losing anything:

```sh
docker compose exec burrow node dist/invite-admin.js
```

It prints a one-time invite link (valid seven days, in the audit log).
Open it, make the new admin, and in Settings -> Users set the old account
right or remove it. `scripts/reset.sh` is only for starting over: it
removes everything.

Burrow refuses to start when its master key does not open the database
(a lost `secret.key`, a changed `BURROW_SECRET`): its log says so. Put the
key back (`secret.key` is in every backup; `BURROW_SECRET` is not), do not
start it with a new one, or every stored password and key is lost.

### Prebuilt images

Each release is also published as images, for amd64 and arm64:
`ghcr.io/r31l4nd/burrow` and `ghcr.io/r31l4nd/burrow-backup`, tagged with the
version (`X.Y.Z`), its minor line (`X.Y`, which follows its fixes) and
`latest`. To use them instead of building, in `.env` (`X.Y` the line you
want, such as `2.21`):

```dotenv
BURROW_IMAGE=ghcr.io/r31l4nd/burrow:X.Y
BURROW_BACKUP_IMAGE=ghcr.io/r31l4nd/burrow-backup:X.Y
```

then `docker compose pull && docker compose up -d` (no `--build`). The
self-update pulls them when Burrow's folder is not a git checkout, and
builds from the checkout when it is. A folder that is not a checkout needs
`compose.yaml`, `.env`, `secrets/` and, for restores, `scripts/restore.sh`
and `scripts/backup/` from the release (its source archive on GitHub);
building the Android app yourself needs the checkout.

### More than one Burrow on a machine

`compose.yaml` names its project, container and host `burrow`, so one
Docker host runs one Burrow. A second one (to try an upgrade first) belongs
on another machine or VM.
