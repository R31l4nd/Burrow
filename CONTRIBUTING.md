# Contributing

Thanks for wanting to help. Burrow is a shell into every host its users
add, so changes are held to a high bar; this page says what that bar is.

## Before you start

- A bug: open an issue with the steps, what you expected and what
  happened. From Burrow itself, an admin can turn a problem report into a
  filled-in issue (Settings -> Reports received). Security problems go
  privately, see [SECURITY.md](SECURITY.md).
- A feature: open an issue first, so we can agree on the approach before
  you spend time on it.

## Making a change

The toolchain runs in Docker; the host needs bash, git, make and Docker.
[docs/DEV.md](docs/DEV.md) has the commands and the test layers,
[docs/DESIGN.md](docs/DESIGN.md) and [docs/adr/](docs/adr/) the design,
[docs/UI.md](docs/UI.md) the rules for the interface.

- `make gate` must pass. It runs lint, unused-code and type checks, unit,
  integration and end-to-end tests with coverage floors, a tour that looks
  at every page and dialog on a phone, a computer, in Dutch and dark mode
  (what each pass checks: [docs/UI.md](docs/UI.md)), and checks that every
  button is pressed by some test and every API route is used by one.
- A fix comes with a test that fails without it. Reported problems go in
  [docs/REGRESSIONS.md](docs/REGRESSIONS.md) with the test that catches
  them.
- Every text in the interface goes through i18n: English in
  `web/src/lib/i18n/en.json` and Dutch in `nl.json` (see Translations).
- Code is hand-formatted (single quotes, long lines). Do not run a
  formatter over files you did not otherwise change.
- Database changes are a new SQL file in `server/migrations/`; a released
  migration is never edited.
- Every `/api` route declares who may use it (`config.auth`), and whether
  it needs a fresh confirmation (`config.stepUp`: acting on a host, users,
  sign-in, devices, updates); `server/test/integration/access.test.ts`
  checks that each of those refuses without one.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/);
  user-visible changes get a line in [CHANGELOG.md](CHANGELOG.md).

## Translations

The web app's texts are flat JSON files, one per language, keyed the same:
`web/src/lib/i18n/en.json` is the source, `nl.json` the Dutch. The Android
app's own few texts are Android string resources:
`android/app/src/main/res/values/strings.xml` and `values-nl/strings.xml`.
Both are formats Weblate reads and writes as they are:

| Component | File mask | Base file | Format |
| --- | --- | --- | --- |
| Web | `web/src/lib/i18n/*.json` | `web/src/lib/i18n/en.json` | JSON file (flat keys) |
| Android | `android/app/src/main/res/values-*/strings.xml` | `android/app/src/main/res/values/strings.xml` | Android String Resource |

In a text:

- `{name}` is filled in by Burrow; keep it, in any place in the sentence.
- `{n:one|other}` picks the first form when `n` is 1 and the second
  otherwise: `{n:1 file|{n} files}`. Keep the braces and the bar.
- Plain ASCII punctuation (`'`, `"`, `-`, `...`), letters of the language
  itself are fine. Arrows are written `->`.

Tests check that a translation has every key of `en.json` and no others,
the same placeholders, and a singular form wherever a count comes before a
noun. A new language takes, besides its JSON file, a line in
`web/src/lib/i18n/index.svelte.ts` (the `Locale` type, `load()` and
`locales`) and a typed wrapper like `nl.ts`.

## Android

The app is in `android/`. `bash scripts/android-test.sh` runs it on an
emulator (needs `/dev/kvm`, about 15 minutes) against a real Burrow, sshd
and a WireGuard server.

## Licence

By contributing you agree that your work is published under the
[AGPL-3.0](LICENSE), like the rest of Burrow.
