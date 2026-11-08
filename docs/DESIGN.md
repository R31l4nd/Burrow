# Design

Burrow is one container: a Fastify server (TypeScript, Node 24) that serves
the Svelte 5 single-page app and a JSON API, keeps its state in SQLite, and
talks to hosts over SSH. Larger decisions are recorded as ADRs in
[adr/](adr/); this page is the map.

```
browser / PWA --HTTPS--> reverse proxy --> burrow :8080
                                             +- SQLite  (/data/burrow.db)
                                             +- master key (/data/secret.key or BURROW_SECRET)
                                             +- ssh2 --> hosts
```

## Code layout

| Path | What |
|---|---|
| `shared/` | Zod schemas and types used by both sides; group inheritance (`effective.ts`). |
| `server/src/auth/` | Setup gate, sessions, passkeys, TOTP, recovery codes, throttle, routes and the access rules. |
| `server/src/hosts/` | Groups, hosts, `ssh_config` import, reachability monitor. |
| `server/src/keys/` | Key vault. |
| `server/src/ssh/` | Connecting with the known-hosts policy, host-key probe, facts, `authorized_keys`. |
| `server/migrations/` | SQL migrations, applied in order at start-up. Never edited after release. |
| `web/src/` | The app: pages, components, i18n (`lib/i18n`), API client with step-up retry. |
| `server/src/terminal/` | Server-owned terminal sessions, viewers, sharing and recordings. |
| `server/src/files/`, `server/src/lsp/`, `server/src/workspace/` | Files over SFTP, language servers, workspaces (search, git, sudo saves). |
| `server/src/docker/` | Container overview (polling while watched) and log streams, over SSH with the docker CLI; stacks, updates, rollback. |
| `server/src/alerts/`, `server/src/notify/`, `server/src/reports/` | Alerts, notification channels and push, scheduled reports. |
| `server/src/ai/` | Model providers, log analysis, command suggestions, the log filter from a question. |
| `server/src/proxmox/` | Proxmox VE guests over SSH with qm and pct. |
| `server/src/apps/` | App tabs: CRUD, discovery from container labels, the frame check and icons. |
| `server/src/android/`, `server/src/auth/devices.ts` | APK download, asset links; paired phones and their device keys. |
| `android/` | The Android app (Kotlin): WebView shell, bridge, device key, app tabs (ADR 7); the direct SSH route (ADR 8). |
| `web/src/direct/`, `web/direct.html` | The direct route's page, bundled into the APK. |
| `e2e/` | Playwright tests. |

## Access rules

Every `/api` route declares who may call it in its `config`
(`auth: public | user | admin`, `stepUp`, `allowIncomplete`). A route that
declares nothing is **admin-only with a finished account**, so a forgotten
annotation fails closed. `enforceAccess` in `auth/routes.ts` applies the
rules in one place.

`stepUp` (a sign-in in the last 15 minutes) guards what changes who gets in,
who reads which files, or what runs unattended: users, invites, sign-in methods, keys and host
credentials, opening a terminal and sharing or recording one, sudo reads and saves, containers and stacks, Burrow updating itself and the
automatic updates' settings, a command on several hosts, a paired phone's
new direct-route SSH key (the same key reported again needs none),
notification channels (where alerts and their stored secrets go). Deliberately not:
the file browser's saves, uploads and renames, and typing in a terminal.
They are the person's own work in their session, done all day, with the
same rights the host gives that user; each change is in the audit log. A
route asks for a step-up itself (`requireStepUp`) for part of what it does:
deleting, unpacking and copying over existing files, and writing a file that
grants a shell (keys, a shell's start-up files, cron, sudoers, units;
`grantsAShell` in `files/access.ts`).

**Files an operator may open** (`files/access.ts`, ADR 15): per operator
and host an allowed and a denied list of folders (`file_access`); the
longest folder that holds a path decides, a denied one on a tie; no rule,
no files. Every file route checks the path as it really is on the host
(SFTP `realpath`, links resolved, the rule's folders resolved too) before
it reads; listings, searches, quick open, git status and bookmarks drop
what is closed. Closed whatever is granted: `.ssh` folders, host keys,
`/etc/shadow`, `/proc`, Burrow's master key, database and backups (by
name), a folder that holds a `burrow.db` (Burrow's data folder, wherever
it is mounted), and Burrow's own compose folder on its host.

State-changing requests must carry `Origin` equal to `BURROW_ORIGIN`, on top
of the `SameSite=Strict` cookie. The Origin check also covers sibling apps on
the same site (`*.home.example.com`) that SameSite does not.

## Secrets

`SecretBox` (AES-256-GCM, key from HKDF over the master secret) seals every
secret column. The column name is bound as additional data, so a ciphertext
moved to another column does not decrypt. The cookie token is stored as a
SHA-256 hash; recovery codes likewise (they carry ~79 bits, so a slow hash
adds nothing the throttle does not already give). A stored secret goes with
its destination (`secretFor` in `http.ts`): when an ntfy server, a mail
server (or its TLS), an OpenAI-compatible address or the single sign-on
issuer changes and the secret is not given again, the stored one is
dropped instead of being sent to the new address.

## Hosts and groups

A host's connection settings are resolved field by field: the host's own
value, else the nearest ancestor group's, else the built-in default
(`effectiveConnection`). The same function runs in the browser to show
"from group: ..." hints. Keys referenced from group defaults (JSON) are
checked by hand before a key is deleted; hosts use a foreign key.

## Known hosts

One entry per host, port and key type. The server offers the already-trusted
key types first during the handshake, so a host with several keys keeps
presenting the one we know. A different key of any type is a mismatch. The
Android app's direct route judges keys by the same rule (`HostKeys.kt`),
with this table's keys in its offline cache.

## Terminal sessions

The server owns each session: an SSH connection, a PTY and an
`@xterm/headless` terminal fed with the same output (`terminal/manager.ts`).
Browser tabs attach over a WebSocket and receive a serialized snapshot of the
headless screen, then the live stream. Output is broadcast from the headless
terminal's write callback, so a snapshot plus the broadcasts after it are
exactly the stream - nothing is lost or sent twice when a viewer joins.

tmux mode runs the shell in `tmux -L burrow -f /dev/null`: Burrow's own tmux
server, isolated from the user's. The alternate screen is disabled on that
server, so output scrolls into the viewer's scrollback (how scrolling works
on a phone). A row in `terminal_sessions` lets Burrow re-attach after a
restart. Memory-mode rows are removed at start-up. See ADR 4.
`$TMUX` stays set in its shell (the shell integration and `.bashrc` lines
that start tmux when it is empty rely on it), but names the person's own
default server (`default-command`): a plain `tmux`, `tmux ls` or
`tmux attach -t main` there reaches their tmux, not Burrow's. When tmux
refuses to nest, the shell runs in a tmux of their own already; the
terminal says so (TermSession).

The size follows the last active device: typing, focusing or opening the
terminal makes a viewer the owner and the PTY takes its size. On a wide
screen the page shows up to four sessions side by side (`TermSession`
per pane, the layout kept per device); typing into all of them at once
goes through each session's own input.

A session can be shared with other Burrow users to watch: their viewers
are read-only on the server (input, resize and scrolling from them are
ignored), and the owner can record it on request (`terminal/recorder.ts`:
asciicast v2 in the data volume, 64 MB at most, kept 30 days; one still
being written is kept until it ends). Everyone
watching sees that it is recorded. The minute sweep keeps a watcher (an
operator too) while their sign-in holds and the session is still shared
with them. The stored host password is not typed into a session that is
shared or recorded (it is echoed away from a hidden prompt). A person
removed or no longer an admin has their sessions closed, tmux on the
host too; a removed person's id leaves every share list.

## Auto-complete

Completion runs in the browser (`web/src/lib/complete`). The input line is
read from the terminal buffer: with the shell integration Burrow knows the
prompt text and whether the shell waits at a prompt; without it a prompt
ending (`$ # % >`) is guessed. The engine walks the command's Fig spec
(served as static modules under `/fig/`, loaded per CLI) and merges history,
spec items and snippets. Generators and path listings run on the session's
own SSH connection (`/complete/run`, `/complete/ls`), so they reach the right
host and directory without new logins.

The shell integration reports through escape sequences that the server's
headless terminal parses: OSC 133 (prompt/command marks), OSC 7 (directory)
and OSC 6973 (prompt text, command line). Inside tmux they are wrapped for
passthrough; Burrow's tmux server allows it. History is recorded server-side
from these reports, so every device sees the same history. Output can carry
the same sequences (a file shown with `cat`, a log line, the motd), so a
command report counts only at a command start that follows an Enter someone
typed (one per Enter, within a minute).

## Files and the editor

`server/src/files`: one SSH connection with an SFTP channel per host
(`SftpPool`, closed after a minute idle), shared by all file operations.
SFTP for listing, reading, writing and renaming; the host's own tools over
the same connection for recursive work (`rm -rf`, `cp -a`, `chmod -R`,
archives, `du`, `find`). A copy between hosts pipes `tar -c` on the source
into `tar -x` on the destination through Burrow. Long operations are jobs
the client polls, so they never hit a proxy timeout.

Saving writes a temporary file next to the target and renames it over the
original with the `posix-rename` extension (atomic replace); the editor sends
the hash of what it loaded and a mismatch returns the current content.

`server/src/lsp`: a WebSocket per editor to a language server process
(stdio, JSON-RPC framing). The bridge answers `workspace/configuration`
itself and replays `initialize` to a reconnecting editor. Processes stop ten
minutes after their editor goes away. Native tools (shellcheck, shfmt,
hadolint, taplo, ruff) are downloaded at pinned versions and checksums in the
Dockerfile.

## Android app and app tabs

`android/`: `MainActivity` shows Burrow in a WebView with `FLAG_SECURE`, a
fingerprint lock at start and after five minutes away, and edge-to-edge
insets so the keyboard pushes the page up. `Bridge` answers the page
(`web/src/lib/android.ts`): the device key (`DeviceKey`, signs only
`DeviceMessage`s), open-with and share (files fetched from Burrow's origin
with the page's cookie, handed out through a `FileProvider`, an edited copy
offered back for upload), the share target (files held by token and read in
1 MiB pieces into the normal upload queue), a foreground service while
transfers run, and host shortcuts. `AppTabsActivity` keeps a WebView per app
with its own profile. Details and reasons: ADR 7.

The phone's own files (Files -> This phone, `web/src/pages/PhoneFiles.svelte`)
come through the same bridge from `PhoneFolders`: only folders the person
picked in Android's folder picker (`ACTION_OPEN_DOCUMENT_TREE`, a persisted
URI permission each, given back when the folder is removed or another
server is chosen; no storage permission). The page names a file as
`/<folder id>/<names>` (`PhonePaths`): no `..`, no document id or path of
its own; each name is looked up among the children of the one before,
through the granted tree's URIs, which the provider checks again. Text goes
to the editor (`EditorPane`'s `source`: up to 5 MB, saved only over the
SHA-256 it read), pictures to the viewer as blobs read in 1 MiB pieces
(held files, up to 30 MB), a log file to `LogView`'s `text` (no analysis);
the rest opens in another app with a read grant. Nothing of it goes to
Burrow's server: the editor's language servers, hadolint and the Compose and
nginx checks are off for it, and a problem report names only the page. A
copy to a host holds the files like the share target and uploads them from
the share page; a copy from a host is the app's own download into the
folder (`Downloads.Target.Document`).

The app's own WireGuard (`android/wg`, wireguard-go on a netstack in the
app's process, no `VpnService`) is reached through a proxy on 127.0.0.1
that asks for a secret made at every start. A name sent to it is looked up
only through the tunnel's own DNS (the configuration's `DNS =` line), never
the DNS of the network the phone is on: with a full tunnel
(`AllowedIPs = 0.0.0.0/0`) that network's DNS could otherwise pick where a
plain-http app tab and its cookies go. Without a `DNS =` line, or when the
tunnel's DNS does not answer, the request fails with a 502 that says why
(also in the status line, for the direct route's sockets), and the app's
error screens repeat it (A3-AND-01).

Choices from the third audit (2026-10-11), kept so they are not undone by
accident:

- **Links and intents never act.** `burrow://open` links, push taps and
  host shortcuts only open a page of Burrow; where a page would act on what
  the link carries (connect, analyse, run), the page asks first. A host
  shortcut's CONNECT counts only through the app's own, not exported entry
  (`HostShortcut`), never when another app sends it to the exported main
  screen. The share target reads only another app's `content://` files.
- **The direct route is a task of its own** (it shows separately in the
  recent apps): starting Burrow's main screen (singleTask) no longer ends
  its sessions. Its sessions live in Kotlin, so a lost WebView renderer
  only reloads its page, which takes the shown session up again; every
  WebViewClient handles `onRenderProcessGone` (WebViewClientsTest).
- **A tunnel change never reloads Burrow's page**: the page is told
  (`resumed`) and reconnects; only the error screen loads again.
- **The lock hides the page from accessibility and keys too**, not only
  from the eye, and gives its focus settings back as they were.
- **Lock-screen notifications** of alerts say only that something came.
- **Signing**: APK Signature Scheme v3 (ADR 7), so the key can be rotated.

`server/src/apps`: app tabs are rows with a URL. Discovery runs
`docker inspect` on every host with Docker and reads `homepage.href`,
SWAG's `swag_url` (the `*` becomes `APPS_BASE_DOMAIN`, by default the last
two labels of the origin) and Traefik `Host()` rules. Adding an app fetches
it once from the server: `X-Frame-Options`/`frame-ancestors` decide whether
the browser may frame it (only those origins go into `frame-src`), and its
icon is stored and served back as an inert image.

## Containers and logs

`server/src/docker`: `DockerMonitor` polls the hosts a page watches every
5 s (one `docker inspect` over the pooled SSH connection, and every third
poll a `docker stats --no-stream` sample), keeps an hour of samples and pushes over `/api/docker/ws` a
host's whole snapshot once per watch, then each poll only what changed
(`dockerDelta`/`applyDockerDelta` in `shared/src/docker.ts`, the sparklines
growing by the same rule on both sides). Every poll sends
something, a few bytes when nothing changed, so the page marks a host that
said nothing for 20 s as not answering. `LogStream` (`logs.ts`) reads all the sources of one host
over one SSH channel: a small shell script runs `docker logs -t` per
container, `tail` per log file (on the host, through the host side of a
mount when that is readable, else inside the container) and `journalctl`
per unit, and prefixes each line with its source and stream; a source's
exit status comes last, so one that failed is said, not a quiet end. Lines
go out in batches over `/api/docker/logs/ws`, and a viewer too slow to take
them is let go (close 4008; the page connects again). The page
(`components/LogView.svelte`) merges lines by timestamp, detects levels
(`shared/src/docker.ts`) and renders ANSI colours from escaped text
(`lib/ansi.ts`). See ADR 9.

## Managing stacks and updates

`server/src/docker/manage.ts` holds the routes. Container actions and exec
shells run the docker CLI over SSH; a shell is a terminal session whose
command is `docker exec -it`. Compose operations (`ops.ts`) start detached
on the host (setsid + nohup, output to
`${XDG_CACHE_HOME:-~/.cache}/burrow/ops/<stack>--<id>.log`) and
Burrow follows the file by byte counts until the exit line; a job can run
several scripts (update, then rollback) into one output. `updates.ts`
compares each image's `RepoDigests` with the registry's
`Docker-Content-Digest` (`registry.ts`: Docker's reference rules, anonymous
bearer tokens asked only over https of the registry's own domain or a known
auth service, never through a redirect; registry redirects only to https),
one request per tag; `autoupdate.ts` pulls and recreates,
watches the services and on trouble re-tags the previous image ids and runs
`up -d --pull never`. The daily window is checked every minute in the
window's own time zone. `changelog.ts` reads GitHub releases for images
with an `org.opencontainers.image.source` label. See ADR 11.

## Alerts and analysis

`server/src/alerts`: `AlertEngine` keeps one `docker events` stream per
Docker host and, per host, one stream of the logs that pattern or rate
rules cover - containers, log files and journals, through the same script
as the log view (reconciled every minute, and when the Alerts page asks).
It judges events (`events.ts`), takes the host limits that
`server/src/hosts/stats.ts` finds crossed (disk, SMART, temperature, CPU
and memory busy for a while), bundles and mutes (read or not is each person's own: `alert_reads`, read up
to a time), and sends through the `Notifier`
(`server/src/notify`, below) to the channels for alerts.
`server/src/ai/analyze.ts` groups and masks lines (`shared/src/analysis.ts`;
IP addresses as well unless the admin marked the server as on their own network,
`local` in the AI settings, never guessed from its address)
and streams the model's answer (`ai/stream.ts`: Ollama NDJSON, OpenAI SSE,
Claude SDK stream). An operator reads their own analyses and others' only
of what an operator may read itself (a container's output, a log source an
admin set up). The page renders it with a small escaping Markdown
renderer (`web/src/lib/markdown.ts`). See ADR 12.

## Reports and channels

`server/src/notify`: channels (settings with sealed secrets) and the
`Notifier` that sends a notice to every channel for its topic: ntfy, e-mail
(nodemailer), Discord (embed), webhook (JSON, HMAC-signed), and push to
devices (Web Push, UnifiedPush; `push.ts`, `webpush.ts`). Alerts, reports
and image updates all go through it. `server/src/reports`: schedules
(`schedule.ts`, weekly/daily/cron in a time zone) and `Reports`
(`generate.ts`): per container facts from Docker, the alerts and the logs of
the period, a status, a comparison with the previous report, and the
model's explanation for the containers that need it. See ADR 13.

## Users, single sign-on, host statistics

`server/src/auth/users.ts` (users, roles, invites), `auth/oidc.ts` (OpenID
Connect with openid-client: login, invite and step-up flows),
`hosts/stats.ts` (numbers from /proc, /sys and df; SMART through sudo;
samples and host alerts), `hosts/diskio.ts` (each whole disk's I/O, kept
as counters with the samples; who reads and writes, sampled from
/proc/<pid>/io only while someone looks, as root through sudo when allowed). Operator routes are marked `auth: 'user'`; the
default stays admin. See ADR 14.

## Workspaces

`server/src/workspace`: saved workspaces, the file list and search (`rg`,
else `grep`), replace (per file, through the editor's atomic save), git
(`git -C root` over SSH, with `core.fsmonitor` off, hooks off and no `ext::`
transport; a repository whose own config, includes included, sets anything
that runs a command is refused, since anything writing as the SSH user's uid
can plant one) and sudo read/save. A sudo save walks the path
first and refuses one that goes through a symbolic link root does not own
(a link a less trusted user planted would send root's write elsewhere). The page
(`pages/Workspace.svelte`) has the tree, tabs of `components/EditorPane.svelte`,
quick open, search and git panels. See ADR 10.

## Logging

One JSON line per API call (method, route, status, error code, time, user;
reads only when they fail, or at debug level), every audit event as a line,
SSH connections that fail, and container monitoring and log streams
starting and stopping. Never bodies, cookies or file content.

Warnings and errors are kept in the database as well (`log_events`,
`server/src/logevents.ts`), because the container's log goes with every
deploy: a pino hook groups them by kind (the message without its numbers)
with a count, first and last time, and the newest message masked like a
model's input; written every 10 seconds, kept 30 days after a kind was last
seen, at most 500 kinds. A request refused with a 4xx (a step-up asked, a
page not found) is how Burrow answers, not a problem of its own: not kept. Admins read them on Settings -> About.

## The direct route

When Burrow is away the Android app connects by itself (ADR 8).
`server/src/android/direct.ts` puts the phone's public key on the hosts an
admin picks (`authorized_keys`, marked `burrow-direct:<id>:`) and serves the
offline cache; `android/.../Direct*.kt` has the Keystore key, the encrypted
cache, the host-key rule (`HostKeys`, the same as `ssh/knownhosts.ts`) and the
sshj session. The page is `web/direct.html`, built separately
(`web/vite.direct.config.ts`) and bundled into the APK by
`scripts/direct-assets.sh`; it reuses `components/TermView.svelte`, the
completion engine and `shared/src/shellwatch.ts`.

## AI

`server/src/ai` has one provider interface (Ollama, Anthropic SDK,
OpenAI-compatible HTTP; Gemini through Google's OpenAI-compatible endpoint)
that returns schema-validated objects. See ADR 5.
A question about logs in words goes out with the source names only (no
line); the answer is Burrow's own filters (search, levels, stream, range,
sources), set on the controls where they can be changed or undone.

## Proxmox VE

`server/src/proxmox`: a host whose facts show `qm` or `pct` lists its
guests (both lists in one SSH round trip, each with its exit status) and
starts, shuts down, stops or reboots them as root or through `sudo -n`; no
API token is kept. Actions need a fresh step-up and go in the audit log. A
guest's address (from `pct` or the QEMU guest agent) fills in the host
form to add it as a host.

## Trade-offs worth knowing

- **Hash router** instead of history routing: works in the Android WebView
  and behind any proxy without rewrites.
- **Hand-written SQL migrations** instead of drizzle-kit: one fewer dev
  dependency chain, and the SQL is what runs.
- **In-memory challenges and TOTP tickets**: they live for minutes; a restart
  simply asks the user to try again. Throttle counters are in SQLite so a
  restart does not hand out fresh attempts. They count per address and per
  account; a step-up per sign-in session. Without `TRUST_PROXY` behind a
  proxy every client had the proxy's address, so ten failures by anyone
  blocked every sign-in: such requests are counted per proxy and the client
  it names in `X-Forwarded-For` (unverified, so the account limit is what
  holds), the same for the per-address request limit, and Burrow warns
  once per proxy and puts `hints: ["trust_proxy"]` on `/healthz`.
- **A full data disk is said, not a bare 500** (`server/src/diskspace.ts`):
  SQLite's `SQLITE_FULL` (and I/O errors, `ENOSPC`) answer `507 disk_full`
  with what to do, `/healthz` answers 503 with `hints: ["disk_full"]` while
  under 50 MB is free (so the container turns unhealthy), and the channels
  get one message (topic alerts) until there is room again.
- **No JWT**: sessions must be revocable immediately.
- **A push address is whatever the device gives** (`server/src/notify/push.ts`),
  http included, so a self-hosted ntfy on the home network works as a
  UnifiedPush distributor. Any signed-in user, an operator too, can so make
  Burrow POST to an address of their choosing: an accepted risk. What goes
  there is encrypted for the device with fixed headers, and the answer is
  never shown, only whether one came; an operator learns at most that
  something listens at an address, which is little next to what they may
  see already (every host and container). Redirects are not followed and a
  person has at most 20 devices. An address belongs to the person who
  turned it on: someone else sending the same address (two accounts in one
  browser) is refused until the first turns theirs off, instead of taking
  the device over. Worth looking at again if people are
  invited who are trusted less than that.
