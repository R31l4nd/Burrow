# Threat model

What Burrow protects, from whom, and how; what it leaves to you. The
design behind each point is in [DESIGN.md](DESIGN.md); how to report a
problem is in [SECURITY.md](../SECURITY.md).

## What is worth taking

- **A shell on every host.** Burrow holds SSH keys and passwords for the
  hosts you add, as the users you gave it. Whoever controls Burrow controls
  those hosts with those users' rights, Docker included where the user may
  use it.
- **The master key** in the data volume. With it and a copy of the
  database every stored secret opens.
- **What the hosts show**: files, logs, container settings and their
  environment, terminal output and history.
- **The sign-in of the people using it**: passkeys, passwords, TOTP
  secrets, recovery codes, sessions, paired phones.

## Who might try

| Who | Can reach | Burrow's answer |
| --- | --- | --- |
| Someone on the internet | Nothing, as installed: Burrow belongs on your LAN or behind a VPN (README). | Not a supported setup. The sign-in is still built for it: no default account, throttled attempts, step-up for what matters. |
| Someone on your network | The sign-in page. | Passkeys first, password + TOTP otherwise, attempts throttled per account and address in the database (a restart hands out no fresh tries), one at a time per account, address and sign-in session (attempts sent together all passed the throttle before, audit 2026-11-09). |
| A web page you visit | Your browser, which holds Burrow's cookie. | `SameSite=Strict` cookie and an `Origin` check on every change; a strict CSP (own scripts only, no framing of Burrow). |
| An invited operator | Hosts' statistics, containers, logs, and files only in the folders an admin allows per host; no shell, no changes. | Every `/api` route declares who may use it; one that declares nothing is admin-only. Every file path an operator reads is judged as it really is on the host against their folders; keys, `/etc/shadow`, `/proc` and Burrow's own secrets stay closed whatever is allowed. A configured log source that is a link to one of those is not read either (operators stream every source). |
| An admin's stolen session | Everything an admin sees, for a short while. | What changes hosts, users, sign-in, channels or updates needs a fresh step-up (15 minutes), as do writes that grant a shell (keys, shell start-up files, cron, sudoers, units, login messages, log rotation, APT hooks), unpacking archives, copying or uploading over files and deleting terminal recordings; sessions can be ended at once, from another device too. Step-up does not cover typing in a terminal: a stolen session can attach to a running session and type, and tmux sessions live on until closed (`TERMINAL_IDLE_MINUTES` sets a limit). It then shows in that session's list of viewers; the terminal's completion runs nothing for a sign-in that is not one of them. |
| A lost or stolen phone | The app, behind the phone's lock and Burrow's own fingerprint prompt. | The device key lives in the phone's keystore and needs the fingerprint; unpair it from another device (USAGE.md: lost phone). |
| A host you manage, taken over | What it sends back: file names, file contents, log lines, command output. | Treated as untrusted text: escaped in the page, never served as a document of Burrow's own (only images, video and PDF inline, each under a CSP without scripts), never run. A log file it turns into a link to a key is refused; a very long line is cut before it is masked (a line built to make the masking slow froze Burrow for minutes before, audit 2026-11-09). |
| A container image or registry | What its labels and release notes say. | Shown as text; an update runs only when someone asks or within the update window they set, and Burrow checks the image is healthy before calling it done. |
| An AI model (when you set one up) | What Burrow sends it: log lines, and a file's text when someone asks about it in the editor. | Log lines are grouped and masked first, a file's text is masked the same way (passwords, tokens, keys of the known shapes, credentials in URLs, on command lines (quoted values too), in SQL statements, config files of words and values and XML, URL-encoded ones, webhook addresses, long random-looking strings, e-mail and, for a model off your network, IP addresses); its suggestions are shown, never run; Burrow's own risk rules can only raise its risk label. |

## What stays outside

- **The hosts' own users and sudo.** Burrow acts with the rights you give
  its SSH user. Give it a user without root where you can; root edits then
  go through sudo, asked each time.
- **Your reverse proxy and TLS.** Burrow assumes the proxy in front of it
  is yours and terminates TLS. It takes the client address from
  `X-Forwarded-For` only from the proxy named in `TRUST_PROXY` (none by
  default), for the audit log and the rate limits. Through a proxy it was
  not told about, Burrow says so (a warning in its log, a hint on
  `/healthz`) and counts sign-in attempts per proxy and the client the
  proxy names, so one client cannot lock everyone out; that name is not
  verified, so the per-account limit is then what holds. A step-up is
  counted per sign-in session: failures for the same account elsewhere do
  not block it.
- **Backups of the data volume.** A backup holds the master key next to
  the database: keep it as safe as the hosts it opens (INSTALL.md).
- **Other projects on the same Docker host.** Burrow never gets the Docker
  socket; it reaches Docker over SSH like any other user, so it can do
  only what that user may.

## Accepted risks

- **Write access to the database is full access.** Someone who can write
  `burrow.db` without the master key can still add a passkey, replace a
  password hash, make an account admin, or point a host at another
  machine together with its host key, and so receive that host's
  password. Sealed values are bound to their column, not their row: one
  host's sealed password copied to another host opens there too. Binding
  them to their row as well would close only that copy, not the rest, so
  it is not done (A3-SRV-18). Keep the data volume as safe as the hosts it
  opens: only Burrow's own user writes it.
- **A push address is whatever a device gives** (DESIGN.md, trade-offs):
  a signed-in user can make Burrow send an encrypted POST to an address of
  their choosing and learn whether something answered. Redirects are not
  followed and each person has at most 20 devices.
- **The Android app allows plain http** (`usesCleartextTraffic`) for app
  tabs: a LAN app is often `http://nas:7878`. Burrow itself is https only
  (the app refuses another address when pairing), the main WebView never
  leaves Burrow's origin, and the direct route goes over SSH.
- **Single sign-on trusts the provider's name for an account.** The first
  sign-in through it links the Burrow account whose username (or verified
  e-mail, as Settings -> Single sign-on chooses) the provider gives. A
  provider where people pick or change their own username could hand
  someone an existing account, an admin's too: use the e-mail claim with a
  provider that verifies addresses, or one whose usernames only you set.
  An admin can unlink an account (Users).
- **Another app on the phone that listens on 127.0.0.1**, together with a
  page in an app tab that sends the tab there, could ask for the app's
  WireGuard proxy secret: the app answers the proxy's question by its
  address and realm, and Android does not say which port asks. That
  secret opens only the proxy, which reaches what your tunnel reaches.
  Such an app can also keep opening connections to the proxy to slow the
  app's own requests: the proxy takes 32 not signed in at once, closes the
  oldest when another comes and reads 64 KB of headers each, so holding
  sockets open no longer shuts the app out. Install apps you trust on the
  phone that carries your tunnel.
- **App tabs share one cookie store on an old WebView** (one without
  profiles, before about version 110): the apps' cookies sit beside
  Burrow's own and each other's, and the app says so once. Burrow's cookie
  is HttpOnly, Secure and SameSite=Strict, so a page in a tab can neither
  read it nor send it along; what the apps' own cookies allow among
  themselves is theirs. Keep Android System WebView up to date (A3-AND-17).
- **"All files" gives the page the whole phone** (report 862305): with it
  switched on in the app and allowed in Android, the Files page can read,
  change and copy every file of the phone and its memory card, so whoever
  controls the Burrow server (or a fault in its page) could too. Off by
  default; switched on only after a warning, off again at once, and off
  when another server is chosen. Without it the page sees only the folders
  picked in Android's own picker.
- **Masking goes by patterns.** A secret in a shape the patterns do not
  know goes to a model as it is. Use a local model (Ollama) for logs and files where
  that matters, or read the masked text first (*Copy*).
- **A recording holds what the screen showed** (F3), a secret printed
  there included; it is made only on request, said to everyone watching,
  readable by admins only, and removed after 30 days.
- **A person's own work is not stepped up**: saving most files,
  uploading, renaming and typing in a terminal are done all day with the
  host's rights; each is in the audit log. Deleting, unpacking, copying
  over files and writing a file that grants a shell ask for a step-up.
- **Known advisories in dependencies** that cannot do harm here are listed
  with why and until when (SECURITY.md); the gate fails on them again after
  that date.

## How it is checked

- Every route is called by some test, the access rules of each by
  `server/test/integration/access.test.ts`, which also sends bad input to
  every route.
- Secrets at rest, masking, the risk rules and the throttle have unit tests;
  the step-up, the CSP, the Origin check and the WebView's limits are
  exercised end to end.
- Dependencies, the Go module and the built image are scanned on every
  gate run (`npm audit`, `govulncheck`, trivy).
