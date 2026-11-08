# Maintaining Burrow

How to keep Burrow healthy and release it, written for whoever maintains it
next: the owner, a contributor, or an AI assistant with no memory of how it
was built. [DEV.md](DEV.md) has the commands and the test layers,
[CLAUDE.md](../CLAUDE.md) the short version of the rules.

The GitHub repository is the source. Work happens on branches and pull
requests against `main`; a tag `vX.Y.Z` on `main` releases.

## The checks

- `make check` (minutes): lint, unused code, types, unit tests.
- The gate (`make gate`, one to two hours):
  everything, end-to-end tests and the tour included. CI runs it on every
  push and pull request (`.github/workflows/ci.yml`). Locally, run it
  through `bash scripts/gate-snapshot.sh`: it gates a copy of the tree in
  `../Burrow-gate` (a git worktree), so you can keep working meanwhile.
  That folder is never part of the repository; remove it with
  `git worktree remove --force ../Burrow-gate` when you need the space,
  the next snapshot makes it again.
- A red gate: fix, check the fix with a targeted run, then
  `make gate RESUME=1` (or `bash scripts/gate-snapshot.sh resume`): it
  reruns only what failed or changed. DEV.md has the targeted commands.
- A test that passed only on its retry is a NOTE, not a failure: make it
  steady when you can.

## Routine work

### Renovate pull requests

Renovate (`renovate.json`; install the Renovate GitHub app on the
repository once) opens pull requests for npm packages, pinned images,
GitHub Actions and the editor tools in the Dockerfile. Digest updates and
the lock file come grouped on Monday mornings.

1. Let CI run on the pull request. Green: read what changed (release notes
   of anything with a new major version), then merge.
2. Red: check out the branch, find the failing step in the CI log (the
   `Playwright report` artifact holds e2e traces), fix on the branch.
3. Things that move together, or the gate fails:
   - `@playwright/test` and the `mcr.microsoft.com/playwright` image
     (Renovate groups them);
   - Node in the Dockerfile and in `scripts/node.sh`;
   - an editor tool's version in the Dockerfile and its SHA-256 per
     architecture (download the release file, `sha256sum` it).
4. `make repin` moves every pinned image to the digest its tag points at
   now (what the gate's `pins` NOTE lists), the F-Droid draft's Node with
   it, for a manual round between Renovate's.

### Expiring exceptions

Some checks let a known problem through until a date, then fail again on
purpose, so it is looked at:

- `.trivyignore.yaml`: image advisories (trivy, the gate's `image` step
  and the release scan). Fix by updating the package; if there is no fixed
  version yet and the advisory cannot reach Burrow, extend the date with a
  new reason.
- `scripts/audit-allow.json`: npm advisories without a fix (`deps` step),
  the same way.
- `e2e/controls-todo.json`: controls no test presses yet. It may only
  shrink.

SECURITY.md lists the advisories that were judged not to apply; keep it in
step.

### Problem reports

People report problems from inside Burrow (Settings -> Reports received);
an admin turns one into a filled-in GitHub issue. A fix starts with a test
that fails without it, and gets a row in `docs/REGRESSIONS.md`.

## Releasing

1. `bash scripts/bump-version.sh X.Y.Z` (semantic versioning: a fix is
   the patch number, a feature the minor, a change people must act on
   the major). It writes the version into every `package.json`,
   `package-lock.json`, `android/version-code.txt` and the F-Droid draft,
   opens the CHANGELOG section from `[Unreleased]`, and makes empty
   "What's new" files for the Android app.
2. Write:
   - CHANGELOG.md, section `[X.Y.Z]`: what changed for the person using
     Burrow, a `### Breaking` part for anything they must do (the
     self-update shows it before updating), and `### Verified`: how it
     was tested.
   - `android/fastlane/metadata/android/en-US/changelogs/<code>.txt` and
     `nl-NL/...`: a few sentences, 500 characters at most; the app shows
     them as "What's new".
3. The gate green (CI on the pull request, or locally). For a change to
   the Android app also `bash scripts/android-test.sh` (an emulator, needs
   `/dev/kvm`); for a change to installing, `make fresh-install-test`.
   Look at the screenshots of every screen you changed (`e2e` artifacts).
4. Merge to `main`, then tag and push the tag:
   `git tag vX.Y.Z && git push origin vX.Y.Z`.
5. CI then: checks the tag against the versions and the CHANGELOG
   (`scripts/release-tag.sh`), builds and scans the images for amd64 and
   arm64, pushes them to `ghcr.io/r31l4nd/burrow` and
   `ghcr.io/r31l4nd/burrow-backup` (tags `X.Y.Z`, `X.Y`, and `latest` for
   the newest stable release), builds the signed APK and makes the GitHub
   release with the CHANGELOG section as its notes.
6. Check the run, the release page (the APK attached) and the package
   page on GitHub.

A release whose CI failed after the tag was pushed: do not move the tag.
Fix on `main` and release `X.Y.Z+1`.

Installations update from Settings -> About (the self-update): a git
checkout pulls `main` and builds, an install on the prebuilt images pulls
them. Burrow checks once a day and tells the channels for image updates
when a new version is out.

## Signing the Android app

A phone installs an update only when it is signed with the same key as the
app on it. The key is `android/keystore/burrow.jks` (alias `burrow`), never
in git; its password is `KEYSTORE_PASSWORD` in `.env.build`.

- Keep a copy of the key file and its password somewhere safe besides this
  machine (a password manager). Lost, no update can reach installed apps:
  people must uninstall and install a new one.
- CI signs with the repository secrets `ANDROID_KEYSTORE_BASE64` (the key
  file, `base64 -w0 android/keystore/burrow.jks`) and `KEYSTORE_PASSWORD`.
  Without them CI releases the images and no APK.
- `make apk` builds the app here and offers it in the running Burrow
  (Settings -> Android app), for an install of your own.
- `BURROW_ANDROID_CERT_SHA256` (printed by `make apk`) is only needed for
  passkeys inside the app.

## GitHub settings, once

- Settings -> Security: private vulnerability reporting on (SECURITY.md
  sends reports there).
- The two Actions secrets above.
- After the first release: the `burrow` and `burrow-backup` packages on
  the profile's Packages page -> Package settings -> visibility Public, so
  installs can pull them without signing in.
- Renovate: install the GitHub app for the repository.

## Your own installation

`deploy/local/` is git-ignored: put your own make targets there (a
`Makefile` there is included by the main one, for example a `deploy`
target), and `private-patterns.txt` with the names of your own
installation (host names, paths, addresses), one per line: the gate's
`public` step then fails when one of them gets into a commit.
