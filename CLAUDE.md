# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Burrow is a self-hosted homelab admin app (SSH terminals, files, containers and logs, alerts, reports) with a Svelte web UI and an Android WebView app. docs/DESIGN.md, docs/DEV.md, docs/UI.md and docs/adr/ hold the design decisions. docs/PRIOR-ART.md says how comparable projects (Termix, Dockge, Arcane, Dozzle, Beszel, ...) handle each feature: look there, and add to it, before building or changing one.

## Commands

Nothing runs on the host except bash, git, make and Docker (and openssl for the gate's backup step and the Android test). `scripts/node.sh` runs any node/npm/npx command in the pinned Node 24 image with the repo mounted at `/app`.

```sh
bash scripts/node.sh npm ci
make dev                 # API :8080, Vite :5173 (deploy/dev.env)
make lint                # eslint . --max-warnings 0
make unused              # knip: unused files, exports, dependencies (knip.jsonc)
make typecheck           # tsc for shared/server, svelte-check for web
make test                # unit tests (shared, server, web)
make test-int            # server integration tests against a throwaway sshd
make check               # lint, unused, typecheck, unit: the gate's cheap steps, minutes
make gate                # everything below; must be green before a commit or push
make gate RESUME=1       # after a red gate and a targeted fix: unchanged steps reused, e2e only the failed/changed specs
bash scripts/gate-snapshot.sh            # the gate on a snapshot in ../Burrow-gate: the working tree may change meanwhile
bash scripts/gate-snapshot.sh resume     # after a fix made in the snapshot (and here): RESUME there
bash scripts/gate-snapshot.sh commit -m "..."   # commit exactly the tree that passed onto main
bash scripts/android-test.sh   # Android app on an API 35 emulator (needs /dev/kvm, ~13 min, includes updating from the release before; not in the gate)
make apk                 # build the APK and offer it for download in the running Burrow
make repin               # pinned images that moved upstream (the gate's pins NOTE) to their new digest, the F-Droid draft's Node with them
make bugs [ID=<id>]      # problem reports sent from the app; ID copies one to artifacts/bugreports/
make replay ID=<id>      # a report's input recording (terminal, last 30 s) played again on the e2e setup
```

Single tests:

```sh
bash scripts/node.sh sh -c 'cd server && npx vitest run test/unit/docker.test.ts'
bash scripts/node.sh sh -c 'npx vitest run --root web src/conventions.test.ts'
bash scripts/test-integration.sh test/integration/reports.test.ts
bash scripts/e2e.sh tests/workspace-crud.spec.ts   # still runs the setup project; specs share one instance, so a lone spec can fail on missing hosts/channels made by others
bash scripts/e2e.sh --no-deps --project=setup --project=desktop --project=mobile --grep "claims a fresh instance|builds a group and a host|<your test>"   # just those, in order (~20 s after the build): setup, the test host, then yours
E2E_KEEP=1 bash scripts/e2e.sh ...; E2E_REUSE=1 bash scripts/e2e.sh --no-deps --project=<p>   # keep the instance up, then repeat one project on it
TOUR_ONLY=<screen-regex> bash scripts/e2e.sh --no-deps --project=setup --project=desktop --project=look --grep "claims a fresh|builds a group|every page and dialog"   # a few tour screens
```

`--no-deps` runs use one worker (setup must finish first). Parallel e2e workers sign in with their own passkey (`.state/passkey.json` for the first, `passkey-N.json` for the others, one per `parallelIndex`, made in setup.spec): a shared one races on the signature counter.

`scripts/gate.sh` steps: compose (valid, and the hardening and limits users run with: `scripts/check-compose.sh`), public (nothing private in what git would commit: secrets, keys, the names in `deploy/local/private-patterns.txt`: `scripts/check-public.sh`), pins (images on digest; Renovate's managers match every pin: `scripts/renovate-check.mjs`; the F-Droid draft's toolchain: `scripts/fdroid-check.sh`), deps (npm audit, critical in dev dependencies too; fails when the audit cannot run; an install script not named in `allowScripts` fails `npm ci`, `.npmrc`), lint, unused (knip), typecheck, build, unit (server, shared and web/src/lib coverage floors), integration (floor), e2e, image (trivy on `burrow:e2e`, HIGH/CRITICAL; exceptions with why and until when in `.trivyignore.yaml`; no setuid files), webcoverage (the web app's lines in functions e2e runs: function-level, not branches; floor), controls (every control the tour sees is pressed by some test, a click counting only when the page did something within 2 s; `e2e/controls-allow.json` says why not, `e2e/controls-todo.json` lists the ones still to press and may only shrink), routes (every API route used by some test, or excepted with a reason in `server/test/route-exceptions.json`), go (Android WireGuard: gofmt, vet, tests, govulncheck), backup, versions (every package.json and the lock agree), leftovers (the run left no test container, volume or untagged image of its own behind; test scripts remove containers with `docker rm -fv` and build with `rebuild` from `scripts/docker-lib.sh`). Raise coverage floors, never lower them. The gate takes about an hour: run it once, before the commit, after `make check` and the e2e specs (and `TOUR_ONLY` screens) the change touches are green; a cheap step failing skips the expensive ones (`FULL=1` runs all), and a test that passes on its one retry is a NOTE (make it steady), not a failure. After a red gate: fix, check the fix with a targeted run, then `make gate RESUME=1` (state in `.gate/`), never a whole run again for one failure. Run the targeted e2e check of a fix with `E2E_RESUME=1`: without it scripts/e2e.sh clears the gate's e2e results, and the resume runs all of e2e again. Logs of a failed e2e run: the `logs:` path the gate prints, `e2e.log` inside it; screenshots and traces in `e2e/test-results/artifacts/`.

The e2e specs share one Burrow instance. The `desktop` project runs its specs one at a time in file order (later ones use what earlier ones made); then `look` (the tour's six passes, one test each, and the sizes), `mobile` and the other browsers run side by side, and the `press*` projects last, then `replay` (e2e/playwright.config.ts). Never take "the first" host, workspace or channel from a list, other specs add theirs; pick yours by name or path. A spec that only looks may run beside others: what it writes must be the same whoever writes it first. Integration tests read `shared` as built (`bash scripts/node.sh npm run build -w shared` after changing it).

Integration, e2e and the Android test use fixed container names on this machine's Docker: never run them beside each other or beside a running gate. Run the gate through `scripts/gate-snapshot.sh`: it gates a snapshot of the tree (tracked and untracked files, not ignored ones) in its own worktree, so work goes on here meanwhile (code, docs, unit tests, lint, typecheck; no integration, e2e or Android test). A red gate: fix in the snapshot (`bash scripts/gate-snapshot.sh path`) and in the tree, then `resume`; `commit` puts exactly the passed tree on main and keeps the work done since in the tree. The Android test of a passed snapshot runs in it after `bash scripts/gate-snapshot.sh env` (copies the .env files); `prepare` makes a new snapshot of the tree and refuses over a passed one not yet committed. A plain `make gate` in the tree still works, but then the tree must not change while it runs (it reads tests live and builds the image from the tree).

Never run prettier or another formatter: there is no config, and it rewrites whole files. The code is hand-formatted: single quotes, long lines.

## Architecture

npm workspaces: `shared` (types, zod schemas and pure logic used by both sides; build it before typechecking the others), `server` (Fastify 5), `web` (Svelte 5 runes + Vite), `e2e` (Playwright). `android/` is a Kotlin WebView app plus `android/wg` (wireguard-go through gomobile).

- **One container**, non-root, read-only root filesystem. Burrow never gets the Docker socket: everything on a host, Docker included, goes over SSH as the host's configured user (`server/src/ssh`, pooled connections in `files/pool.ts`; `execChannel` waits for a free channel under sshd's MaxSessions).
- **Terminals are server-owned** (ADR 0004): the server holds the SSH shell (optionally inside tmux on the host) and viewers attach over a WebSocket, so a session survives closing the tab. In the web app `components/TermSession.svelte` is one session on screen (connection kept in `lib/termpool.ts` when it goes out of sight, history and snippets for completion, `TermView`); the terminal page and the bottom panel (terminal + logs under a workspace or a stack) both use it.
- **Database:** better-sqlite3 + Drizzle. Migrations are hand-written SQL in `server/migrations/NNNN_name.sql`; never edit a released one, and keep `server/src/db/schema.ts` in step. Secrets are encrypted at rest (`server/src/crypto.ts`, master key in the data volume).
- **Unsaved work:** `warnUnsaved()` (`web/src/lib/unsaved.svelte.ts`) registers a guard with the hash router (`guardLeave`) and `beforeunload`; every page with unsaved work (forms, Editor, Workspace) uses it, so the menu, history and links ask too. Pages do not ask on their own Back. Forms with a Save button carry `data-unsaved` (the tour checks Settings).
- **Writing files:** saves go through `files/service.ts`: one at a time per file (`oneAtATime`), through a symlink to its target, keeping owner and mode, refused with a conflict when the file changed since it was read (base hash). Sudo saves (`workspace/sudo.ts`) replace the file in one `mv`.
- **Failed is not empty:** a command on a host that fails must not read as "nothing there" or "fine". The docker state commands exit with `EXIT_NO_LIST`/`EXIT_NO_STATS` (`docker/parse.ts`), report log reads carry `@@burrow-exit` (`reports/generate.ts`), host stats and SMART are checked for missing sections (`hosts/stats.ts`). A rollback or self-update is "rolled back" only when the old image is seen running and healthy. A stack deploy from its review sends the review's digest of `docker compose config`; the server refuses when anything changed since.
- **Access control:** every `/api` route declares its access in `config` (`auth: 'user'`, `stepUp: true`, ...) and `enforceAccess` in `server/src/auth/routes.ts` applies it. Acting on a host (terminals, commands, container and stack actions, deletes, sudo) and changing users, sign-in, devices or updates need a fresh step-up (`server/test/integration/access.test.ts` checks each); saving a file does not, unless the file grants a shell (keys, shell start-up files, cron, sudoers, units: `grantsAShell` in `server/src/files/access.ts`). The web client handles the 403 `step_up_required` in `web/src/lib/api.ts`.
- **Docker:** `docker/monitor.ts` polls hosts that someone watches and streams snapshots over `/api/docker/ws` (`web/src/lib/docker.svelte.ts`). Logs of several containers stream over one SSH channel per host (a small awk-prefixed script in `docker/logs.ts`). Updates, auto-update in a maintenance window, and rollback live in `docker/updates.ts` and `docker/autoupdate.ts`.
- **AI:** providers (Ollama, Anthropic, OpenAI-compatible) in `server/src/ai`. Log lines are grouped and masked before they leave. Burrow's own risk rules (`shared/src/risk.ts`) can only raise a model's risk label. AI suggestions are never run automatically.
- **Self-update** (`server/src/selfupdate.ts`): over SSH to the host that runs the `burrow` compose service; it pulls or builds, keeps the old image as `burrow-rollback:<container>`, one update at a time (a lock on that host), and writes its state to `~/.burrow-update.json` on that host.
- **Web routing** is hash-based (`web/src/lib/router.svelte.ts`); `App.svelte` maps sections to pages. The direct route (`web/src/direct`) is a separate entry the Android app uses when Burrow itself is unreachable.

## UI conventions and the tour

docs/UI.md holds the UI rules. They are enforced:

- `e2e/tests/workspace-tour.spec.ts` visits every page and dialog on phone, desktop, Dutch at 343 px, dark mode on a phone, Dutch on an 820 px tablet and dark Dutch on a 1440 px computer. `lookAt()` in `e2e/tests/checks.ts` runs layout checks on every screenshot (axe, cut-off text, room for the main content, even button rows, and more). A UI problem found by hand becomes a new check there.
- Every `<Dialog>` needs a `tour="name"` and must be seen by some test; pages are listed in `e2e/tests/pages.ts` (`web/src/pages.test.ts` checks the list against App.svelte).
- Every `data-testid` must be used in an e2e or androidTest (`web/src/testids.test.ts`); `web/src/conventions.test.ts` holds more rules.
- All UI text goes through i18n: `web/src/lib/i18n/en.json` is the source, `nl.json` the Dutch (flat JSON, the format Weblate edits; `nl.ts` types it against `en.json`). Plurals use `{n:one|other}`, and a test checks that counts have a singular form.

## Tests

- A fix starts with a test that fails on the old code; check that it does (take the fix out, run, put it back). A test that passes on the buggy code proves nothing.
- Every reported problem gets a row in `docs/REGRESSIONS.md` naming its test as `` `path :: title` ``; `web/src/regressions.test.ts` checks that the test exists, so it cannot be renamed or dropped silently.
- Pressing a control is not enough: assert its effect (saved, removed, navigated, the message shown).
- The tour shows each screen's states too: empty, loading, error, many items, long names. `e2e/tests/workspace-sizes.spec.ts` runs the 16 main pages it lists (not the editor, a workspace, a stack, a report or a container's page) at 11 sizes (343x640 up to 2560x1080, a foldable with the keyboard up among them); the tour covers the rest in its six passes.
- When one UI problem is fixed, look for the same kind elsewhere; a problem found by hand becomes a check in `checks.ts`.
- Before a release: `make bugs`, the gate, `bash scripts/android-test.sh`, `make fresh-install-test`, and look at the screenshots of every changed screen yourself.
- Open work is tracked in GitHub issues. A local `TASKS.MD` at the repo root (git-ignored through `.git/info/exclude`) may hold a working list: keep it updated when it exists.

## Conventions

- Plain ASCII for punctuation and symbols everywhere (UI text, code, comments, docs, commits): `...`, straight quotes, `-`, `->`; symbols on buttons are SVG icons. Letters of Dutch words stay. `web/src/ascii.test.ts` checks it.
- Long-running actions show progress and when the result is expected.
- Logs sent to a model are grouped and masked first (`shared/src/analysis.ts`): as few tokens as possible, never secrets.
- Code, comments, commits and docs in English. Conventional Commits; Keep a Changelog with a *Verified* section per release, and a `### Breaking` section for anything the person updating must do (the self-update shows it before updating). A release starts with `bash scripts/bump-version.sh X.Y.Z` (every `package.json`, `package-lock.json`, `android/version-code.txt`, the F-Droid draft, the CHANGELOG section and the app's "What's new" files; the gate's versions step checks them). docs/MAINTAINING.md has the release steps, Renovate's pull requests and the exceptions that expire.
- Tests and helper containers carry the label `burrow.ignore=true`, because a Burrow you run on the same machine watches its Docker. Tests build the image `burrow:e2e`, never `burrow:local`, the tag a running install uses (the gate checks this).
- Secrets stay out of git: `.env*`, `secrets/*`, `android/keystore/`. `deploy/local/` (git-ignored) holds an installation's own make targets and `private-patterns.txt`, names the gate's `public` step (`scripts/check-public.sh`) keeps out of every commit.
