# Development

Everything runs in Docker; the host needs bash, git, make and Docker. A few test scripts also use tools of the host itself: `scripts/test-backup.sh` (the gate's backup step) and `scripts/android-test.sh` openssl, `scripts/test-fresh-install.sh` curl, sha512sum, ssh-keygen and openssl; they say so when one is missing.
`scripts/node.sh` runs any node/npm/npx command in the pinned Node 24 image
with the repo mounted.

```sh
bash scripts/node.sh npm ci   # install (native modules come prebuilt)
make dev                      # API on :8080, Vite on :5173 -> open http://localhost:5173
make test                     # unit tests
make test-int                 # integration tests against a throwaway sshd
make e2e                      # Playwright against the built image
make apk                      # build the Android app, offer it in Burrow
bash scripts/android-test.sh  # the app on an API 35 emulator (needs /dev/kvm)
ONLY=PhoneFilesTest bash scripts/android-test.sh   # one class or Class#method alone, set up and paired first
make gate                     # everything that must pass before a push
make gate RESUME=1            # after a red gate and a fix: unchanged steps reused, e2e only the failed specs
bash scripts/gate-snapshot.sh # the gate on a snapshot in ../Burrow-gate, so you can keep working; `resume`, `commit -m ...`
make hooks                    # install the pre-push hook (once per clone)
```

`make dev` uses `deploy/dev.env`: `BURROW_ORIGIN=http://localhost:5173`, data
in `./data/dev`. Browsers treat `http://localhost` as secure, so passkeys and
the `Secure` cookie work without TLS. The setup token is printed in the
terminal.

## Dependencies

- Versions are pinned exactly (`npm i -E`), installs use `npm ci`.
- Install scripts are disabled (`allowScripts` in package.json):
  `better-sqlite3` and `argon2` ship prebuilt binaries, `ssh2`'s optional
  native crypto (and `cpu-features`) is not needed, and esbuild installs
  its platform binary as a dependency. A new package with an install
  script fails `npm ci` loudly instead of running code at install time:
  `.npmrc` sets `strict-allow-scripts` (npm 11 only warns without it), the
  images' `npm ci` reads it too, and the gate's deps step checks it
  (`scripts/test-install-scripts.sh`). Review a new one, then name it in
  `allowScripts` (`false` to skip its script, `true` to allow it).
- Images are pinned on digest. The gate blocks an unpinned image and notes
  a drifted one; Renovate proposes the updates.

## Tests

| Layer | Where | Runs against |
|---|---|---|
| Unit | `shared/src/*.test.ts`, `server/test/unit`, `web/src/**/*.test.ts` | in-memory SQLite, Fastify `inject`, a controllable clock |
| Integration | `server/test/integration` | OpenSSH + tmux in `server/test/sshd`; one with the real docker CLI on the test machine's Docker, through a filter that shows it only the tests' own containers (`server/test/sshd/docker-filter.mjs`: named `burrowtest-*` or made through it; no prune, no other image removed), and a throwaway `burrowtest` stack it starts, changes and removes itself (labelled `burrow.ignore=true`) |
| End to end | `e2e/tests` | the production image with the compose hardening, Chrome desktop and Pixel 7, Firefox and WebKit (phone), a virtual WebAuthn authenticator |
| Android (JVM) | `android/app/src/test` | plain JUnit with a line-coverage floor (`checkUnitTestCoverage` in `android/app/build.gradle.kts`), and Android lint (any warning fails; exceptions with a reason in `android/app/lint.xml` and `build.gradle.kts`), part of every `make apk` and of the device test |
| Android (device) | `android/app/src/androidTest` | an API 35 emulator against the production image behind a throwaway TLS proxy (`scripts/android-test.sh`); the phone in English, then a tablet and the phone dark in Dutch (`PASSES`), the tests finding Burrow's buttons by their text in that language (`web/src/lib/i18n`); a black screenshot fails; the last steps stop Burrow and open a terminal over the direct route. Names, ports, limits and scratch can be set to run beside another run (see the script's head). `ONLY=<Class[#method]>[,...]` runs those tests alone, after what they need (pairing, the WireGuard server, the direct route turned on); no `.env` is needed (the build image gets a stand-in `BURROW_ORIGIN`). It ends with the line coverage of the device test alone and together with the JVM tests (JaCoCo, `deviceCoverageReport` and `combinedCoverageReport` in `android/app/build.gradle.kts`; per file in `android/app/build/reports/coverage/combined/html/`), no floor |
| Backup | `scripts/test-backup.sh` | a throwaway instance with its own volume and backup folder, removed afterwards |

Both the e2e suite and the Android device test also take a screenshot of
every screen they pass - `e2e/test-results/tour/` (phone and desktop) and
`artifacts/android-screens/` - to be looked at before a release: layout
slips, things that stay on screen and missing ways back are found there
first, and each one found becomes an automatic check.

What the tests must reach, checked by the gate itself:

- **Every route used.** The integration and e2e tests log each API route
  they used successfully (`BURROW_ROUTE_LOG`); `scripts/route-coverage.mjs`
  fails the gate for a route no test used, unless
  `server/test/route-exceptions.json` says why (and fails again when that
  reason is no longer true).
- **Every route guarded.** `server/test/integration/access.test.ts` goes
  through all routes as they are registered: signed out (401), an operator
  on an admin route (403), no fresh confirmation (403), and odd parameters,
  wrong bodies and broken JSON (never a 500). What must ask for a fresh
  confirmation is also a list of its own there, not read from the routes'
  settings, so a route that lost its `stepUp` fails.
- **Containers the tests start are labelled.** The live Burrow on a
  developer's machine watches the same Docker: `server/test/unit/testlabels.test.ts`
  fails for a `docker run` or a started compose service in the tests
  without `burrow.ignore=true`.
- **Every reported problem.** `docs/REGRESSIONS.md` names the test that
  catches each problem reported so far; `web/src/regressions.test.ts`
  fails when a named test is gone. It and the other source checks
  (`web/src/testids.test.ts`, `pages.test.ts`, `conventions.test.ts`)
  read the source as text: a name in a comment or a skipped test still
  counts, so they keep the lists honest, they do not prove behaviour.
- **Every way of typing.** `e2e/tests/mobile-matrix.spec.ts` tries each
  kind of session with each way of typing and the gestures;
  `web/src/lib/textinput.fuzz.test.ts` throws thousands of keyboard edits at
  the input layer.
- **A reported problem played again.** A report from a terminal carries
  its last 30 seconds of input (`web/src/lib/inputlog.ts`, saved as
  `recording.json`); `make replay ID=<id>` plays it on the e2e setup
  (`e2e/tests/replay.spec.ts`) and prints what the terminal and the
  suggestions then show. Without an id the gate plays a kept recording
  (`e2e/fixtures/recording.json`), so the replay itself keeps working.
- **The web app's code.** The e2e tests count which of its functions ran
  (`e2e/tests/fixtures.ts`, by source file through the source maps); the
  gate wants the floor in `scripts/gate.sh` (`COVERAGE_WEB`) of its lines (step webcoverage); floors only go up.
- **Every control pressed.** Each screen the tour and other looks show
  notes its controls; each test notes what it pressed. A click counts as
  a press only when something followed within 2 s (the page changed, a
  request or socket message went out, the address, focus or clipboard
  changed, a dialog, window or file chooser opened, a link went
  somewhere): a handler that does nothing is not pressed. A control no test
  presses fails the gate (step controls), unless `e2e/controls-allow.json`
  says why (a link out of Burrow, something only the Android app has), or
  it is on `e2e/controls-todo.json`, the list still to do, which may only
  shrink. `e2e/tests/press-all.spec.ts` runs near the end (only the
  replay of a recorded report comes after) and presses whatever is
  left on every page, desktop and phone, watching for page errors and
  failed answers; what removes or ends something it presses on things made
  for it.
- **Unused code.** `knip.jsonc`: an unused file, export or dependency fails
  the gate (`make unused`).

The e2e setup project claims a fresh instance and makes a passkey for each
parallel worker (`.state/passkey-N.json`, one per `parallelIndex`); a worker
loads its own into its virtual authenticator and saves it again after each
sign-in, because the server rejects a signature counter that goes backwards
(as it should: that is how a cloned key shows), and a key shared between
workers raced on that counter.

The README's pictures come from `e2e/tests/workspace-readme.spec.ts`, a
made-up homelab with the API and the containers' socket mocked; it runs
only when asked (`README_SHOTS=1`, see the spec) and writes to
`e2e/test-results/readme/`; the chosen ones go to `docs/screenshots/`.

## Conventions

- Code, comments, commits and public docs in English; the UI in English and
  Dutch (`web/src/lib/i18n`: flat JSON per language, `en.json` the source;
  `nl.ts` types `nl.json` against it).
- Conventional Commits. Keep a Changelog, with a *Verified* section per release.
  A change that asks something of the person updating goes under a
  `### Breaking` heading, one bullet each: Settings -> About shows these
  before a self-update (server/src/selfupdate.ts).
- New migration = new file `server/migrations/NNNN_name.sql`; never edit a
  released one. Update `server/src/db/schema.ts` to match.
- Every `/api` route declares its access in `config`; see docs/DESIGN.md.
- Comments, test names, REGRESSIONS.md and the changelog cite findings as
  `AUDIT XX-NN`, `AUDIT2 XX-NN` (also `AUDIT2 P0`, its first priority) or
  `A3-XXX-NN`: three internal reviews of the whole code, and the 2026-10-16
  review of how Burrow works in use (`OPS-W-NN`, `W-FUNC-NN`, `UIA-NN`,
  `UIB-NN`, and `decision NN` for the product decisions taken on it), all
  October 2026, whose reports are not kept in the repository (every
  finding was fixed or decided). The comment next to such
  an ID says the reason itself; the ID only ties fixes of one finding
  together. Reports from users are cited by their six-character id.

## Releasing

[MAINTAINING.md](MAINTAINING.md) has the release steps
(`scripts/bump-version.sh`, the tag CI releases from, signing the app),
Renovate's pull requests and the checks that expire.
