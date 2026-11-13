# Changelog

All notable changes. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [Semantic Versioning](https://semver.org/). Every release
says how it was verified.

## [Unreleased]

## [2.26.0] - 2026-11-13

### Added

- A host's *Processes*, htop-like (report 387b0e): for admins the CPU and Memory tiles on a host's statistics open the busiest and the largest processes now, with their user, container and command line, ordered by CPU or by memory, measured only while open.

### Fixed

- Two sign-ins at the same moment from one address (two people behind one router, two browsers) both get in: the second waits its turn instead of being refused, which the sign-in page called "Too many failed attempts". Failed attempts are still checked one at a time.
- The tabs atop a terminal on a phone no longer move up and get cut off at the top while swiping between them: every row that scrolls sideways (tabs, chips, keys, paths) now scrolls sideways only (report e020bc). A new layout check finds any row laid out side by side that scrolls up and down too.

### Verified

- The processes: the parser with a sample answer (unit), against the test host's real /proc as the SSH user with a process burning a core on top, root's processes seen too (integration), opened from both tiles on the statistics page, sorted by CPU and by memory, measured again while open and no more once closed (e2e), and in the tour on every size and theme, by CPU, by memory and failed.
- Two sign-ins at the same moment: a unit test failing on 2.25.0 (200 and 429) and passing now; the test that sends 30 wrong attempts together still lets no more through than the block allows. An e2e sign-in in the gate had hit it (a NOTE on its retry).
- The tabs: an e2e test on a phone failing on 2.25.0 (the row scrolled 3 px) and passing now; the new layout check found exactly that row on 2.25.0, and the whole tour and the sizes pass it.
- The gate, the Android app's test on an emulator, and a fresh install.

## [2.25.0] - 2026-11-12

### Added

- A folder only root may read opens with sudo from its "No permission" message, for an admin after a step-up, with the host's stored sudo password or one given (kept in that tab only): to look and to open its files in the editor (read and saved through sudo); nothing is moved, added or deleted in it as root (report 4d30e6). The path above a refused folder names it, not "/".
- A right click on a terminal tab brings it in front with its menu (rename, share, close), as tabs on a computer do; a double click still renames it, a finger's hold on a phone too (report 076380).

### Fixed

- A container's log on a phone follows again with long lines: they wrap to rows there, and a new line counted at a placeholder's height until it was drawn, so the view stood above the real end and stopped following (report 27519a). The last 100 lines are always drawn.
- Typing straight into the terminal on a phone with the keyboard up: a row of suggestions that comes no longer covers the line typed on; the terminal follows its cursor when the room for it shrinks (report c2f122).
- A container's details on a phone draw CPU and memory once, in the history; above it they say the numbers now, without the last hour's lines beside them (report fd6d27).
- The Dutch app says the errors of Files and the editor in Dutch too ("Geen toegang tot ...", copying, archives, saving); they were in English.

### Verified

- Each fix with a test that failed on the code before it (integration and
  e2e), the screens it changes looked at in the tour and at every size.
- Reports 723e9d, 371c18 and c3b3ab (a Claude Code session garbled after
  folding the phone, empty rows under it): not Burrow. Ink, the renderer
  Claude Code uses, leaves the same rows behind in tmux and in xterm.js
  alone; Burrow shows the screen as tmux has it. Ctrl+L in Claude Code
  draws it again whole, tried on a stand-in in tmux and in xterm.js.
- The gate, the Android test on the emulator and a fresh install on a new
  Debian VM, before the release.

## [2.24.0] - 2026-11-10

Eleven reports from the computer and the phone: the containers sorted by
their columns and in one line, a container's details and the editor's
find panel tidied, a host's remembered commands from the side rail, the
phone's status bar held sideways, the app fetched from the release, and a
program in Burrow's tmux drawn right after a switch of tabs.

### Added

- Burrow gets the app from GitHub (report a5ace5): an update of Burrow
  builds no app, so the one it offered stayed behind. When it offers none,
  or one older than itself, an admin can press *Get the app X from GitHub*
  under Settings -> Android app: Burrow downloads the APK from the release
  of the version it runs, keeps it only when it is that version with the
  SHA-256 the release names, and offers it to the phones. Nothing is
  fetched unless an admin asks (docs/DEPLOY.md).

- Containers sorted by a column's name (report faf150): on a wider screen,
  Name, Status, CPU or Memory pressed in a stack's table puts every stack
  in that order, the same as the order menu; pressed again, the other way
  round. The column in use has an arrow; kept on this device.

### Fixed

- The editor's find panel on a narrow phone: with a match chosen, the close
  button fell to a row of its own and Replace stretched over the options'
  row, three rows over the keyboard. Now two: the field, the count and its
  buttons, then the options with Replace as wide as its word and as high
  as the field and the options beside it (reports 696298, 703c76).
- The columns of the Containers page in one line in every stack (report
  94465b): each stack's table sized its state and update columns by what
  it held, so Status, CPU and Memory stood elsewhere in each. The state
  column has a set width now, and the update column is as wide in every
  stack once one has an update.
- A container's details on a computer said CPU and memory twice: in the
  state line and again in the last hour's lines under it. Those lines now
  show only on a phone, whose state line has no numbers; the history's
  range no longer touches the details' scrollbar (report 73982d).
- Remembered commands opened from a host's menu in the side rail showed
  nothing: the menu took the list with it as it closed (report 63e44b).
- The status bar above the app a grey strip over the white title bar on a
  phone held sideways (or a wider screen): it took the page's background;
  it now takes the title bar's colour, as it does upright (report dfc5b0).
- A program in tmux, such as Claude Code, drawn through itself after a
  switch of terminal tabs: its spinner and prompt twice, letters of two
  frames mixed (reports d1113b, 92eaa5). A tab come back replays what was
  kept into a new terminal, a busy phone fits that terminal to its size
  a moment later (which moves its lines), and tmux draws only what
  changed since, over whatever differed. The screen is now drawn again
  whole when a tab comes back and whenever the terminal is fitted to
  another size on the device: by Burrow's tmux, or, in a session without
  it (a tmux of your own attached in it, a program run straight in it),
  from the server's copy of the screen. No resize: the program notices
  nothing.
- A test of 2.23.0's keyboard fix (report b00aad) failed when the machine
  running it was busy: its steps now run on the page's own clock.
- The tour asks for a fresh confirmation after ten minutes: on a busy
  machine a pass took longer than a confirmation lasts. Two more tests
  steady on a busy machine: Firefox's report form waits for its
  screenshot, and masking a long line is bounded at 2 s, not 250 ms.
  The alerts test checks the test hosts' packages first: their security
  updates' alerts came at a moment of their own and were counted with the
  crash.
- The direct route on a phone no longer puts a "limited completion" row
  above the terminal when typing starts, as Burrow's own terminal page on a
  phone: the terminal lost a row while typing, and once was not fitted
  again (its last rows under the edge).

### Security

- The app's WireGuard built with Go 1.27.4 (was 1.27.2): GO-2026-6859 in
  net/http, which the tunnel's HTTP relay calls. shfmt in the image and
  the gate's Go checks on the same Go.

### Verified

- Each fix with a test that failed on the code before it (unit and e2e),
  the screens it changes looked at in the tour and at every size.
- Report 473350 asked how often the pages read again: answered in
  docs/USAGE.md (containers every 5 s, CPU and memory every 15 s, files
  every 10 s), with what a CPU percentage means.
- The gate, the Android test on the emulator and a fresh install on a new
  Debian VM, before the release.

## [2.23.0] - 2026-11-10

Three reports from the phone (the containers in another order, a terminal
that jumped and changed size with the keyboard), and what a full code
audit found.

### Added

- Containers in the order you choose (report d36ec8): the order icon
  beside the filter puts them by name, the busiest (CPU) or the most
  memory first, or problems first; stacks by what they use together.
  Kept on the device. The rows hold their place while the numbers move
  (sorted again when an order is chosen, a container comes or goes, and
  every 30 s): they moved under a finger with every update.

### Fixed

- The terminal's picture jumped each time the keyboard opened or closed
  on a phone (report b00aad): every step of the slide went out as fewer
  rows, and the program in the terminal redrew for each. The terminal is
  fitted once the keyboard has settled, and keeps its rows.
- The terminal's top bar changed size with the keyboard (report aa109d):
  on a phone it is now always the compact one, and the row of labels
  under it shows only for a warning (connecting, another size, more
  devices); "via Burrow", "tmux" and "lost on restart" (the session list
  says it) are left out there.
- "Host unreachable" (2.22.0) also went out for a host that answered but
  whose numbers could not be read, a slow command or full sessions: only
  a failed connect counts now.
- The container history sampler connected to a failing host every five
  minutes past the backoff of 2.22.0 (a failed login for fail2ban each
  time); it waits too now. The Containers page opened after an outage
  tries at once instead of showing the old error for up to half an hour.
- Security updates were told again after one failed package check.
- A Proxmox node's guest list cut off between its two parts read as a
  node without containers.
- Back to the session a terminal page was opened for (its tab, or closing
  the pane in front) did nothing after typing in another pane.
- Typing into all panes also typed the terminal's own answers and mouse
  reports into the other shells.
- Settings -> Android said "up to date" while Burrow's side was still
  being read or could not be read; Containers left out the stacks brought
  down, and a host's page its alert limits, without a word when their
  read failed: both are said now, with Try again.
- A dialog fading out still took taps: a quick second tap ran a menu item
  twice.
- Closing idle terminal sessions (Settings -> System, off unless set)
  tried a host that could not be reached every minute, a failed login for
  fail2ban each time: it waits now, from 5 minutes up to 6 hours.
- A recording turned off and on again at once left the first one open
  beside the new one, never ended.
- Ask AI about a file over 1 MB was refused as too large: the part a
  model can take is sent (the editor opens files up to 5 MB).

### Security

- A long log line (for example `docker login` repeated over 64 KB) could
  freeze Burrow for minutes in the masking before logs go to a model or
  an alert: the masking rules are bounded and the text is cut first.
- More secrets are masked: quoted option values, names with more after
  the secret word (`DB_PASSWORD_ROOT`), passwords in SQL statements, in
  redis, keepalived and `.netrc` files, in XML, and URL-encoded ones.
- The risk rules read more commands as high: Proxmox guests and storage
  removed, Podman pruned, a branch deleted by a push, storage rolled back
  or shrunk, a container with the host's root, SSH stopped, sysrq, rows
  deleted, and a command whose name is hidden ($'..', globs, a variable);
  anything piped into a shell at least medium.
- Sign-in and step-up attempts sent together all passed the throttle while
  the first ones waited: one attempt at a time per account, address and
  session now.
- A host deleted and a new one added got the same id, and the old one's
  scheduled commands and reports then ran on the new host: a deleted
  host is taken out of them (and of wake relays and uploads).
- A host log source that is a link to a key or one of Burrow's secrets is
  not read: a container could turn a log in its folder into one, and
  operators stream every source.
- The app's WireGuard question read Endpoint lines more strictly than the
  tunnel, so a peer behind a comment was configured but not shown.
- The app's tunnel proxy forwarded a plain-http client's next request to
  the first host it asked for.
- An empty share from the page ended the app.
- Another app on the phone could hold the tunnel proxy's places open with
  silent sockets and shut Burrow's own requests out: one more now closes
  the oldest waiting, not the new one.
- CI checks that nothing under android/ changed before the signing key is
  there; release tags are X.Y.Z only (a prerelease published images, then
  failed before the release).

### Verified

- Each fix with a test that failed on the code before it (unit, e2e, and
  JVM and Go for the app), except the tunnel proxy's plain-http fix (Go's
  own tests still pass) and the CI and release-tag checks (run by hand).
- The split terminals test types only into sessions of its own: it was
  given another spec's session beside its own (once one in tmux's copy
  mode, once one sized by another viewer, whose suggestions lay over a
  pane's head) and failed now and then on a busy gate.
- The gate, the Android test on the emulator and a fresh install on a new
  Debian VM, before the release.

## [2.22.0] - 2026-11-08

What was left open at the handover, and two reports from the phone.

### Added

- An install on the prebuilt images hears of new versions too: Settings
  -> About and the daily check read Burrow's releases on GitHub (the
  newest, its breaking changes since the running one), where only a git
  checkout was asked before. When the image's tag does not reach the new
  version (`:2.21` for 2.22.0), Settings and the notice name the tag that
  does, to set as `BURROW_IMAGE` in `.env`.
- Alerts: a built-in rule "Host unreachable", told once when two
  statistics rounds in a row (five minutes apart) cannot reach a host,
  and once when it answers again. A rule of its own: switch it off for
  hosts that are off on purpose.
- Settings -> Android says when the app this Burrow offers is older than
  Burrow itself (a self-update builds no app), with a link to the
  releases on GitHub; "no app built yet" links there too.

### Fixed

- Statistics, the container monitor, SMART and package checks connected
  to a host every round, also when it refused Burrow's login (a failed
  login for fail2ban each time) or was off: they now wait as the alert
  streams do, from ten seconds (five minutes after a refused login),
  doubled up to half an hour. What a person opens always tries at once.
- A connection that never answered a request for a channel held whoever
  asked for good: it now fails after its wait and five seconds more, and
  a channel that comes after that is closed.
- Closing a dialog showed it for a few frames in odd proportions, under
  a title cut short (report 693cf4).
- The terminal's suggestions were larger and brighter than the terminal
  and took much of its room: now in the terminal's own font size, as
  tall as the text box, and quieter (report c02b7a).

### Verified

- Each fix with a test that failed on the code before it: the image
  install's check against GitHub's releases (unit, and as it runs over
  SSH), the tag that reaches a new version (the check, the notice, the
  page), the older app said in Settings, Host unreachable (two rounds,
  once, again when back; the built-in rule as it runs; its Dutch), the
  pool's wait for background callers, the channel request that never
  answers, the dialog fading out as a column under its title, the
  suggestions' size.
- make check; the e2e specs these touch; the gate.

## [2.21.0] - 2026-11-08

### Added

- Burrow tells about itself over the notification channels: a background
  job that keeps failing for an hour, its data disk getting full (under
  1 GB or 5 % free, well before it is full), a channel that fails (told
  through the others), new errors in its own log, and a self-update that
  failed or was rolled back: each once, and once more when it is gone. A
  new Burrow version goes to the channels for image updates (checked once
  a day). Once a week every channel gets "Burrow runs": when it stops
  coming, Burrow or that channel is broken.
- A heartbeat address (Settings -> System, or `HEARTBEAT_URL`): Burrow
  calls it every five minutes while it runs well, so Healthchecks or an
  Uptime Kuma push monitor can tell you when Burrow is down, which Burrow
  cannot say itself.
- Settings -> Backups: how to put a backup back, with the command for the
  newest archive to copy.
- Locked out: `docker compose exec burrow node dist/invite-admin.js`
  prints a one-time admin invite, so the last admin who lost every way to
  sign in gets back in without wiping anything (docs/DEPLOY.md).

### Fixed

- A wrong password or key had Burrow's alert streams log in to the host
  every ten seconds, so fail2ban banned Burrow within minutes (terminals
  and files with it); a host that was off was tried as often. They now
  wait longer after each failure (ten seconds doubling up to half an hour,
  five minutes first after a refused login) and try again within seconds
  when the host's password or key is changed.
- One host that never answered (a stale NFS home folder) held every call
  for it forever, and stopped the statistics and container history of
  every other host. A connection now gets 30 seconds, and a round no
  longer waits on one host.
- A lost master key (`secret.key` gone, `BURROW_SECRET` changed) was
  replaced by a new one over the database, and every stored password and
  key failed later with a cryptic error. Burrow now refuses to start and
  says why and what to do.
- A full data disk ended the whole process at a keystroke in a terminal,
  and then again at every start. A shell printing faster than the server
  could follow (`yes`, a big `cat`) ended it too; the host is now held
  back instead.
- A terminal recording that reached its size limit stopped, but the
  session still said it recorded. Recordings and scheduled runs that were
  open when Burrow stopped are closed at the next start, instead of
  showing as running (a recording could not be removed).
- The database's write-ahead log stayed as large as its biggest prune.
- Building the image failed when GitHub's release downloads did (504s for
  hours on 2026-11-08, the first CI run with them): the editor's tools
  (hadolint, ruff, taplo, ShellCheck) are tried again, then fetched
  through GitHub's API, checked against the same SHA-256.
- The release's APK did not build on GitHub: the build ran as uid 1000,
  and the runner's checkout is another user's. It now runs as the user
  who builds.

### Verified

- Each fix with a test that failed on the code before it: the alert
  streams' wait after a refused login and its reset on a new key, a host
  that never answers (the connection's 30 seconds, a round not waiting on
  it), a lost master key refused at start, a full disk and a shell
  printing too fast in the terminal manager, a recording's size limit
  telling the session, recordings and runs left open closed at start.
- Burrow telling about itself: each kind told once and once more when
  gone, also across a restart; nothing lost when no channel took it; the
  version check once a day and again an hour after it failed; the weekly
  message on every channel. The heartbeat sent, held back while Burrow is
  unwell, a failure logged once. The console invite makes a one-time admin
  invite and an audit row.
- e2e: Settings -> Backups shows the restore steps and copies the command;
  Settings -> System saves and clears the heartbeat address; the
  screenshots on a phone in Dutch and on a computer looked at.
- Integration tests of the terminal, sharing, the shell, alerts, host
  statistics and scheduled commands on the test sshd; new ones of Burrow
  telling about itself as it runs (the version check over SSH, the
  notices through the channels, the heartbeat) and of the master key
  check against what Burrow seals; the gate; the Android test; a fresh
  install.
- The release's APK built and signed (v3) as another uid than 1000, in a
  checkout of that uid, as on GitHub's runner; it failed so before.
- Example addresses in the docs, tests and README pictures are no
  machine's real ones (10.0.0.x); the pictures made again.
- The image's tool stage built without cache while GitHub's release
  downloads answered 504: ShellCheck came through the API with its
  pinned SHA-256; CI's gate on GitHub built and tested the whole image.

## [2.20.3] - 2026-11-08

Made for GitHub (https://github.com/R31l4nd/Burrow); not tagged there,
as GitHub's release downloads failed its image build. 2.21.0 is the first
release built there.

### Breaking

- The Android app has a new id, `io.github.r31l4nd.burrow`. Android
  sees it as another app: install this one,
  pair it with Burrow again, then uninstall the old one. Passkeys inside
  the app follow the new id by themselves.

### Changed

- Releases come from the GitHub repository: a tag `vX.Y.Z` builds the
  images on `ghcr.io/r31l4nd/burrow` and the signed APK. The clone address
  in README and INSTALL is the repository's (`git clone
  https://github.com/R31l4nd/Burrow.git burrow`).
- `scripts/bump-version.sh X.Y.Z` writes a release's version everywhere it
  is (every package, the lock, the Android version code, the F-Droid
  draft) and opens its CHANGELOG section and the app's "What's new" files;
  the gate fails when a section has no Verified part written or a "What's
  new" file is missing or longer than 500 characters.
- shfmt (the editor's shell formatter) is built from its source with the
  current Go: its release binaries carried advisories in Go's network code
  that the image scan let through only until 2026-11-09.
- `deploy/local/` (an installation's own make targets and private
  patterns) is git-ignored; the gate's `public` step looks through what
  git would commit for secrets, keys and those patterns. The pre-push
  hook's backup remotes are a git setting of the clone
  (`git config burrow.backupRemotes`), not the author's names.
- Docs: docs/MAINTAINING.md (releasing, Renovate's pull requests, the
  exceptions that expire, signing the app, GitHub settings); README and
  INSTALL name git, make and openssl and the reverse proxy before the
  first start; the prebuilt image tags as `X.Y`.

### Verified

- The gate on this tree, its `public` step looking through what git would
  commit with this installation's private patterns; e2e: a problem report
  turned into a GitHub issue now that the repository is known (the link
  to `R31l4nd/Burrow/issues/new`, filled in).
- The Android test on an emulator under the new id (the update from 2.20.2
  is not tested: it is another app now, said in the test's output), and
  a fresh install on a new Debian VM following INSTALL.md.
- `scripts/bump-version.sh` from 2.20.2 wrote every version field the
  gate's versions step checks; the step fails on its unwritten Verified
  line, on missing "What's new" files, and on an F-Droid draft that does
  not name the release (the draft still named 1.1.0).
- shfmt in the image is v3.14.1 built with Go 1.27.3; the image scan
  passes with no exception left in `.trivyignore.yaml`.

## [2.20.2] - 2026-11-07

### Fixed

- The history layer shows a tmux of your own attached in a session
  without Burrow's tmux (`tmux attach` in a plain session), its mouse on
  or off. 2.20.0 found one only inside Burrow's tmux; here a finger
  scrolled tmux's copy mode, or with its mouse off sent arrow keys to the
  shell. Burrow finds that tmux by the session's own terminal. A tmux on
  a socket of its own (`tmux -L`) is not found and scrolls as before.
- A finger over a full-screen program that takes the mouse, such as Claude
  Code, scrolls it half as fast: a wheel notch for every two lines the
  finger moves (up to two a line on a quick swipe), not one a line. Since
  2.20.1 the view ran far ahead of the finger, and further in a tmux of
  your own with the mouse on, which scrolls five lines a notch.

### Verified

- e2e on a phone: a slow finger over a program with the mouse sends a
  notch for every two lines it moved (8 for 160 px on 2.20.1, where at
  most 6 pass). The tests of a finger and a flick in a tmux of your
  own (desktop, the phone matrix) still scroll its copy mode.
- Integration: in a session without Burrow's tmux, the history of a tmux
  of your own attached in it, mouse on and off; a pager in it, or a
  program with the mouse in another session, still answers "alternate
  screen" (fails on 2.20.1: the mouse on gave its wheel). e2e on a phone:
  a finger over that tmux opens the layer with its first lines, mouse off
  and on (fails on 2.20.1: no layer), and a pager without tmux still gets
  arrow keys.
- The gate, the Android device test, `make fresh-install-test`.

## [2.20.1] - 2026-11-06

### Fixed

- A finger over a full-screen program that takes the mouse, such as Claude
  Code, turns its wheel a notch for each line the finger moves. It sent
  one for every third (the browser's terminal took the small steps for a
  trackpad's), so Claude Code scrolled slowly and in jerks: about 4 frames
  a second, now one per line, at the finger's pace.
- The busy list and its pill float above a page's foot bar (the Files
  clipboard's "Paste here", the bulk actions on Containers and Apps): on a
  computer the list lay over the clipboard bar's words. A new tour check
  keeps them apart.

### Verified

- e2e on a phone: a slow finger over a program with the mouse sends a
  wheel notch per line it moved (2 of 8 on 2.20.0, all now); measured with
  a stand-in for Claude Code's full screen that redraws on each notch: 6
  notches and 4 frames a second for 22 lines of finger before, 22 and 13
  after, at four times slower CPU too. The new tour check of the busy list
  over a foot bar fails on 2.20.0 (the Files clipboard bar) and passes now.
- The gate, the Android device test, `make fresh-install-test`.

## [2.20.0] - 2026-11-06

### Added

- A paste where a name is taken asks what to do (report dfda31), as
  Material Files and Nautilus ask: keep both (the copy as "name (1).txt"),
  skip those (the busy list says how many), or replace them (with a fresh
  sign-in, like deleting). Pasted into its own folder, a copy goes beside
  it. Within a host and between hosts; between hosts still checked by
  sha256.

### Changed

- The terminal's history layer also works in a tmux of your own attached
  in Burrow's tmux, such as one running Claude Code with the mouse on: a
  finger shows that tmux's history (it was an empty layer, or the slow
  scroll through tmux's copy mode). A full-screen program in it, or a
  program that takes the mouse in Burrow's own pane, keeps its wheel.

### Fixed

- The busy list's "Clear finished" no longer stands on the line under its
  head on a phone (report dfda31).
- A terminal's last row (the prompt) no longer goes half under the text box
  at some heights, such as a foldable's inner screen with the keyboard down
  (report de3278): the fit counted the box's padding as room.
- In Burrow's tmux, a typed line is learnt for the history also when tmux,
  behind on fast output, redraws its screen instead of scrolling it, and
  after scrolling back in tmux's history (a flaky test, reproduced under
  load). A line typed at a prompt that does not echo it still is not.

### Verified

- Tests that fail on 2.19.0 and pass now: a typed line learnt after a
  redraw moved its echo up, and while tmux left its history (unit); a name
  taken at the destination kept as "name (1)", skipped or replaced, as
  asked (integration, report dfda31); the history of a tmux of your own
  attached in Burrow's tmux, with the mouse on (integration and e2e on a
  phone); the terminal's last row and column whole in sight after the
  keyboard went down, with and without tmux (e2e, report de3278).
- Two new tour checks fail on the 2.19.0 stylesheet and pass now: a
  terminal's rows inside its box, and a button clear of the line between
  rows (the busy list's head, a dialog's last item at its scroll end).
- e2e: the paste question in its three forms, its Keep both, Skip and
  Replace each with the files on the host checked. Screenshots of the
  changed screens looked at.
- Android device test, the gate, `make fresh-install-test`.

## [2.19.0] - 2026-11-05

### Added

- The phone's own files work as in Material Files (report 99d993): an APK
  goes to Android's installer; a zip, jar, apk, tar or tar.gz opens as a
  folder (read only; a file in it is shown by another app) and unpacks into
  a folder of its name beside it, with its progress. A file's menu has Open
  with (Android's list of apps), Share (one or a selection) and Properties.
  A name Burrow does not know goes to the editor only when the phone does
  not say it is something else. Needs the app 2.19.0.

### Changed

- Scrolling back in a terminal is smooth: the session's whole history comes
  at once and is shown over the terminal in a layer the phone or browser
  scrolls itself, at the screen's rate, with its own fling and text
  selection. Before, in Burrow's tmux each step was a tmux command over SSH
  and a redraw back, a few frames a second. Typing, scrolling to the bottom,
  Escape or "Back to live" closes it. A program on tmux's alternate screen
  (less, man) is scrolled as before.
- A terminal session is its opener's: another admin no longer sees it in
  their list, nor opens, types into, shares, records or closes it; they
  watch it only when it is shared with them.
- The Android app asks itself, in its own dialog, before screenshots are
  allowed, before a WireGuard configuration is used (showing where the
  tunnel goes) and before the phone's keys are forgotten (unpairing this
  phone); the page does not ask as well. Its OK takes no tap for half a
  second after it shows.
- A copy between hosts belongs to the destination's user and follows its
  umask; the source's owner and mode are no longer kept.
- Pull in a workspace no longer fetches submodules (their own config ran
  commands on the host).

### Fixed

- An image's "What is new" leaves out release candidates, betas and other
  pre-releases (report 0d33eb): GitHub's own mark or the tag (v3.4.0-rc.2)
  says one, and an image on a release tag does not move to it. Someone who
  runs a pre-release still sees the ones after it. A new major version is
  marked against the last real release, not its own release candidate.
- A problem report's picture shows text as the screen does: in Edge at
  125 % it broke words over two lines that stood on one on the screen
  ("breakin|g", a date over the line under it), so a report showed faults
  nobody saw. What stands on one line on the screen now stays on one line
  in the picture.
- Buttons line up the same way everywhere (report 71a779): on a tablet and
  a computer too, a row of actions fills its card or form with one width
  each, as on a phone (a stack's Edit and Review and deploy sat words-wide
  at the left beside a card whose row filled it). A stack's update history
  no longer puts the end of its date line over the image under it. Two new
  tour checks keep both.
- A copy's refusal in the busy list is said in the app's language (report
  71b74a).
- Robustness (audit 2026-11-05): a command that timed out kept running on
  the host and its SSH session stayed taken until a host's actions all
  failed; a lost connection while waiting for a channel, or during a file
  log's start, crashed Burrow; a failure in a background round (reports,
  scheduled commands, updates, alerts, the Docker monitor) ended that round
  for good or the process; a deploy whose stack could not be read
  afterwards counted as good; an interrupted deploy was forgotten when its
  host was down at the restart; a deleted host blocked the recovery of
  other updates; an image missing from docker's answer read as built here;
  a report's log lines past 4 MB were dropped silently or read as "no
  answer"; alerts missed lines after one failed poll; a search in a folder
  that cannot be entered read as "no matches"; a scheduled command ran
  twice the night the clock goes back; alert counts and stack update
  history grew without bound; a failed self-update check said nothing.
- Web (audit 2026-11-05): signed out with unsaved work in the editor or a
  workspace, the page stays behind the sign-in and can be saved after it;
  a container's history, kept log files and suggestions that could not be
  read say so with Try again; watching a shared session reconnects after a
  network drop; toasts no longer measure the whole page many times a
  second; host stats polls no longer pile up; a renamed file keeps its tab
  in a split editor; the picture viewer keeps its picture when the folder
  changes; a terminal or Docker socket that keeps failing checks the
  sign-in; a fix's risk shows Burrow's own reasons; Escape pressed again
  on a dialog with changes still asks; the Markdown preview no longer
  fetches its pictures again on each pause.

### Security

- A repository's own config could still make git run a command: a
  credential helper of any name (or with a newline in it), and
  gpg.ssh.defaultKeyCommand. Both are refused now; the self-update check's
  git fetch runs with the same guard.
- Saving a file Burrow later runs or sources (its shell integration, git
  config files, a repository's .git/config and hooks) needs a fresh
  step-up, as other files that grant a shell.
- A copy between hosts unpacks only the names asked for, without set-user-id
  bits.
- Sign-in challenges and pairing codes waiting in memory are capped.
- The compose check's file is written only where the person may write.
- AI masking also hides keys named *_KEY, PSK and PW values, passwords on a
  command line (curl -u, sshpass -p, docker login -p, htpasswd -b), PGP
  private keys, URL passwords with a / or @, and more AWS and Slack token
  kinds. Burrow's risk rules rate more destructive commands high (scripts
  piped into any shell or interpreter, disk tools, firewall and network
  cuts, account locks, force pushes, setuid chmod) and see through quotes,
  backslashes and $IFS.
- Android: the editor's save writes only over a text file (a page could
  write a photo empty); a delete takes exactly what the app's question
  named; the WireGuard proxy no longer lets idle local sockets shut out
  Burrow's own; a few leaks and a possible freeze on removing WireGuard are
  gone.
- The public export check fails when its private patterns are missing and
  refuses key files by name; the backup image runs as uid 1000.

### Verified

- Unit tests that fail on 2.18.0 and pass now: another admin's session
  refused (integration, terminal ownership); PhoneFoldersTest (archives as
  folders, an unpack into a folder of its name); a copy's refusal in the
  reader's language (report 71b74a); pre-releases left out of "What is new"
  (report 0d33eb). New unit tests for one-line text kept on one line in a
  report's picture, and for the audit's fixes (shared, server, web,
  Android).
- e2e: the history layer on a phone (a slow swipe opens it where the finger
  got to, a flick glides, new output marks Back to live, its bottom closes
  it) and on a computer (the wheel, typing ends it); phone files' archives,
  Open with, Share and Properties; the button-row and date-line tour checks
  fail on the 2.18.0 stylesheet (report 71a779) and pass now. Screenshots
  of the changed screens looked at.
- Android device test, after updating from 2.18.0: an archive shown as a
  folder and unpacked beside itself through Android's provider, the app's
  own question before screenshots are allowed, and a finger's scroll back
  with the keyboard up. Its screenshot showed the history layer at the top
  of the terminal's scrolled box with the live terminal under it; an e2e
  test of that failed and passes now.
- The gate, `make fresh-install-test`.

## [2.18.0] - 2026-11-04

### Added

- The phone's own files (Files -> This phone, in the Android app): delete,
  rename and a new folder, where the phone lets Burrow change the folder.
  A delete is asked by the app itself, in its own dialog, not by the page:
  nothing on the phone goes without your tap there. A folder is deleted
  with everything in it; in "All files" a link in it is removed, never what
  it leads to (report 6eaf00). Needs the app 2.18.0.

### Fixed

- A message (a toast) no longer lies over a dialog's field or the refusal
  under it on a phone: with a sheet open at the foot it goes above the
  sheet, where there is room. A new tour check keeps fields and messages
  free of toasts on every screen.

### Verified

- Unit tests: PhoneFoldersTest (delete, rename and a new folder only below a
  granted folder's top, where the provider can and write access was given;
  a name taken or unusable refused) and AllFilesTest (a folder deleted
  without following a link out of the volume). Both fail to build on 2.17.0.
- e2e: workspace-phonefiles' new test (a new folder, a rename, a No and a
  Yes in the app's question, a selection, a folder) fails on the 2.17.0 page
  and passes now; screenshots of the new dialog, menu and selection looked at.
- Android device test: PhoneFilesTest makes a folder, renames the copy from
  the host and deletes both through the app's own dialog on the emulator
  (No first: it stays).
- The toast check fails on the 2.17.0 placement (the phone's Rename with
  "Folder ... made." still showing) and passes now; the whole tour with it.
- The gate, `make fresh-install-test`.

## [2.17.0] - 2026-11-04

### Added

- An arrow of the terminal's key bar held down goes again and again, as a
  keyboard's own key does; so do Backspace, Del, PgUp and PgDn. Enter, Esc
  and Tab never repeat (report 0bc1fe).

### Fixed

- The options of a switch such as Open | Solved share its width evenly: the
  line between them was off to one side (reports 86756d, 4d0518). A new tour
  check holds every such switch to it.
- Settings -> System no longer says its settings were only in the .env file;
  it says what a value there does (report 4b06b3).

### Verified

- The gate (each of the three reports' tests red on the old code first: an
  arrow held on a phone's key bar, the Open | Solved split at 343, 698 and
  1280 px, the System note), with a new tour check that a segmented choice
  shares its line evenly; the Android app on an emulator and a fresh install.

## [2.16.0] - 2026-11-03

### Added

- An analysis's commands each have Copy and Run..., as a report's fixes:
  Run... shows the command to change, its risk, and runs nothing before its
  button (report a7532e).

### Fixed

- A host's history charts grew with the screen's width, hundreds of pixels
  each on a wide screen and already large at 1280; on a computer they are at
  most 60 px high now, on a phone as before (report dfc610).
- Logs of a container that is gone said it with docker's own text in a red
  box and a red bar across the log; now once, in words, where the lines would
  be, with Try again (report 931cd0).
- A report's switch stood at the screen's left beside the content; it is over
  it now. On a very wide screen (1700 px and more) the containers are in two
  columns (report ddc5ea).
- An analysis numbered its steps 1 again after each command.
- The analysis of a container opened Run... as a second dialog over its own;
  it opens under its command now, in the answer.

### Verified

- The gate (each of the four reports' tests red on the old code first: charts
  measured at 1280, 1920 and 3432 px, the gone container's log, the report's
  switch and columns at 1280 to 3432 px, an analysis's Copy and Run...), the
  Android app on an emulator and a fresh install on a new Debian VM.

## [2.15.0] - 2026-11-03

### Added

- Settings -> System, for admins: the terminal limits (sessions open at once,
  closing ones nobody watches), how often hosts are checked for the online
  dot, the images the update check leaves alone, registries reached at
  another address and the domain for apps found through SWAG. These were only
  in the `.env` file. They apply at once, without a restart; a field left
  empty keeps the `.env`'s value and says what it is, so an install keeps
  what it has.
- Files: a tile in the grid view has its own menu button.

### Fixed

- A container's history on a phone held sideways was narrower than the
  details around it, and a history's range (Last day) was words-wide under
  its title on a phone; both now take the line (report a6548d).
- Files on a phone: holding a file down chose it and opened its menu as well,
  and Select there took it out again. A hold now only chooses; the three dots
  open the menu, and Select in it never takes a file out (report fa1a85).
- Files: with every file chosen the All button went with nothing in its
  place; it now chooses none there (report d6a5e3).
- A workspace's search: Aa, .* and Replace are as high as the search field
  (report eb4f8a).
- A host's uptime in the same size as the other tiles' values, with since
  when under it (report 9cc851).
- System logs on a narrow phone: a service's long description ran over the
  service below it; it is shown whole in its row (report e458b7).

### Changed

- Reporting a problem (Ctrl+Shift+B, a shake of the phone, the red button):
  when the picture of the screen takes a while, as on a phone's terminal
  page, the screen now says it is being made instead of showing nothing
  for seconds. The words are not in the picture.

### Verified

- The gate (Settings -> System against a stand-in .env: nothing set is the
  .env's value, a value set applies without a restart and stays over one, a
  bad pattern or address refused, saving needs a fresh step-up; each of the
  six reports' fixes red on the old code first), the Android app on an
  emulator and a fresh install on a new Debian VM.

## [2.14.0] - 2026-11-03

### Added

- Gemini as an AI provider beside Ollama, Claude and OpenAI-compatible
  servers: an API key from Google AI Studio and a model picked from its list,
  under Settings -> AI. It is external like Claude (addresses masked), and
  the form says what Google's free tier does with what is sent.

### Fixed

- In the app with Burrow not answering, Settings -> Android app said "no
  app built" instead of showing this app, and its failure touched the card
  above. This app's part now comes from the phone whether Burrow answers or
  not, and in the app every "no connection to Burrow" (or Burrow not
  answering) offers the direct route beside Try again: until now only the
  app's own error screen had it, not a page that lost Burrow later.
- On a phone, a command longer than the terminal's width could lose its
  suggestions as they appeared: the bar coming up made the terminal a few
  rows shorter, tmux (and sometimes the shell) wrote the long line again row
  by row, and the line no longer read as one with its prompt. A row filled
  to its last column now counts as the line going on.

### Verified

- The gate (Gemini against a stand-in for Google's endpoint: the key kept
  and removed, the models listed, streamed and structured answers; the form
  in the browser; the Android settings page in the app with Burrow away),
  the Android app on an emulator and a fresh install on a new Debian VM.
  Not against Google itself: that needs a real key.

## [2.13.0] - 2026-11-02

### Added

- The Android app's home screen widget lists each host on a line: a dot for
  up, down or not known yet, the ones down first, its package updates at the
  right; a tap opens that host. As many as the widget's height holds, the
  rest counted.

### Changed

- Files chosen in a host's folder or on the phone: the title bar says how
  many and holds what to do with them (all, copy, cut, delete); the bar of
  two rows over the list at the bottom is gone.
- Channels, report schedules and scheduled commands are switched on or off
  on their row in the list only; their forms no longer have the switch, and
  scheduled commands now have it on their row.
- In the editor a line with a problem is marked on its line number, a band in
  the problem's colour across the line's side, instead of a small dot in a
  column of its own.
- On a computer the buttons and lone fields in Settings are as wide as the
  column, side by side ones sharing it, as on a phone.
- Single sign-on shows Save only once it is switched on or changed.
- The gate's look passes run on three workers again: on five each tour pass
  took about twice as long and e2e about nine minutes more.

- Package lists older than a week can be fetched again from a host's page
  (through sudo, after confirming it is you), and the page shows the command
  that has the host fetch them itself every day.

### Fixed

- A container's state with its health ("running 14 days | healthy") broke
  over two lines on a computer beside room enough: the rows of a stack now
  share one table's columns, the state as wide as its words, the update
  column only as wide as a flag in it.
- A daily schedule's time field was half as wide as the other fields.
- A chosen log line's buttons ran past the log's edge on a narrow phone with
  larger text, in Dutch: now one row of three, an icon and a short word each,
  the icons alone where the words do not fit. A row of buttons on a phone
  stays one row (the tour checks it on every screen). The chosen line's time
  and level read clearly on its tint.
- In the problem report form the screenshot, the pictures and Add a picture
  were of different sizes and not on one line.
- On a folded-open phone the terminal's "the list of sessions could not be
  read" stood one word a line while Try again took the rest of the line: the
  words now get the line, the button its own width (the tour checks words
  squeezed beside a button on every screen).
- On a computer Settings' All and None beside a search box (WireGuard's apps)
  were as wide as the line and pushed the page sideways; a maintenance window
  by cron showed its length alone on half a line; on a small phone New snippet
  and On several hosts went over two rows (now without their icons), and
  Back up now and Download now stand one under the other.

### Verified

- The gate (new tests for each report: the editor's problem marks on a
  computer and a wide and narrow phone, every part of Settings at 1912 px,
  the selection in the title bar, the switches on the rows, the refresh of
  the package lists through sudo on the test host), the Android app on an
  emulator (the widget's host lines) and a fresh install on a new Debian VM.

## [2.12.0] - 2026-11-02

### Changed

- Reports and scheduled commands set their times with the same form part:
  weekly, daily or cron, the time zone, and the same help with them.
- Status marks ("ran well", "failed", "off", update counts) look the same
  on every screen.
- When the host chosen to send a Wake-on-LAN is down, the message names it.
- For developers: `make repin` moves the pinned images that changed upstream
  to their new digest, with the F-Droid draft's Node; a test refuses a
  translation key written twice; the gate's look passes run on five workers.

### Fixed

- The Android app's home screen widget kept working only while the app's
  sign-in did: after seven days without opening the app it showed nothing
  new. It now asks Burrow with a key of its own, kept on a paired phone and
  sent to Burrow the next time the app opens, that can read the widget's
  numbers and nothing else.
- What is typed in a terminal's text box stays there while another tab is
  in front; before, it was gone on coming back.
- On a phone the editor's side with the line numbers is narrow: a log with
  four-digit line numbers gave it a fifth of the screen. The numbers are
  smaller there, each still beside its line.
- A long file in the editor can be reached and scrolled with Tab and the
  arrow keys.

### Verified

- The gate (unit tests for the schedule part, the widget's key and the
  translations; the tour and every screen size for the status marks), the
  Android app on an emulator (the widget asks with its own key) and a fresh
  install on a new Debian VM.

## [2.11.0] - 2026-11-01

### Added

- Package updates per host: what apt, dnf, apk or pacman says can be
  updated, read every six hours and with *Check now* on the host's
  statistics page, without root and without fetching the lists (their age is
  shown). Security updates come first, a restart asked for is said, the host
  list marks the host with how many wait, new security updates raise a Host
  health alert once, and each report names the hosts with updates waiting.
  Burrow never installs them: the command is there to copy.
- Scheduled commands (Settings -> Scheduled commands, admins): a command
  that runs by itself on chosen hosts, weekly, daily or by cron, as each
  host's own user, with a time limit; sudo only where it needs no password.
  Each run's output is kept 30 days; a run that fails or is stopped marks
  its row and raises a Host health alert. A run missed while Burrow was down
  or stalled runs at the next minute, up to an hour late.
- Wake-on-LAN chosen per host (its Advanced settings): from a host that is
  up (as before), always from one host, or from Burrow itself (with host
  networking or macvlan); and a MAC address of its own for a host Burrow
  never reached.
- The Android app's home screen widget: hosts up, new alerts and hosts
  with package updates, counts only. Away from home it brings the app's
  tunnel up for a moment, shows the last numbers, or gets them by push, as
  chosen in Settings -> Android app.

### Fixed

- The version of an image that has no version label (the official
  postgres, redis, nginx and valkey images), or "latest", "main" or
  "1.1.1-amd64" as one, is read from the image's own `*_VERSION` variable or
  a version tag, so its release notes start after it. The notes of
  `valkey:9` are the 9.x releases, and a maintenance release of an older line
  is no longer marked a new major version. When the version still cannot be
  matched the dialog says why (report 9190c5).
- The panel under a stack on a low phone screen: the running sessions below
  its edge scroll, and a tap on one opens it; the panel no longer jumps to
  the whole screen when a button in it is tapped (report ffef5f).
- The base images are on their newest builds.
- A followed log (a log page closed, an alert rule's stream started again
  when a container was made anew) no longer leaves its `docker logs -f` or
  `tail -F` running on the host. On the connection the alerts share, each
  one kept one of the ten sessions sshd allows, until everything Burrow
  asked of that host was refused ("Channel open failure").
- The green of "ran well" and other OK marks is a little darker in the
  light theme, readable on a row under the pointer too.

### Verified

- The gate (with new unit, integration and e2e tests for each part: package
  updates read from a local apt repository on the test host, scheduled
  commands run on it, Wake-on-LAN from Burrow itself, the widget's numbers
  and push), the Android app on an emulator (the widget asks Burrow and
  keeps its numbers) and a fresh install on a new Debian VM.

## [2.10.2] - 2026-11-01

### Fixed

- On a phone, and on a phone folded open, a button or field alone on its
  line takes the whole line: Save in Settings (AI, single sign-on, all
  hosts), Check now under a stack's image updates, how long recordings
  are kept, Add a picture in a problem report. The AI prices take two
  columns there.
- The colour choices in Settings -> Appearance sit in the middle of their
  card.
- On a small phone Reports and Analyses stand side by side again.
- The apps open as tabs take one row above the tiles, scrolling sideways
  when there are more.
- A command typed often can be changed before it is saved as a snippet:
  tapping its row opens it in the snippet form.
- A full-screen page's content (a container's logs and their search)
  starts under its top bar, not against it.

### Verified

- The gate, with new tour checks: a button or field alone on its line
  fills it on a phone, content starts below a page's top bar, and two or
  three choices of a switch stand side by side. The Android app on an
  emulator and a fresh install on a new Debian VM.

## [2.10.1] - 2026-11-01

### Changed

- The F-Droid pictures show the app as it is now, on a made-up homelab
  (hosts, containers, a terminal, the editor, a stack's logs, alerts).
- The README names the copyright holder.
- What a page sends on the containers' socket is checked against one
  schema shared by the server and the web app, as the terminal's already
  was.

### Verified

- The gate, the Android app on an emulator and a fresh install on a new
  Debian VM; the public export fills in the copyright holder
  (`scripts/test-export-public.sh`).

## [2.10.0] - 2026-10-31

### Added

- Apps -> Find in containers also reads caddy-docker-proxy's `caddy`
  labels and the proxy hosts of Nginx Proxy Manager, besides homepage,
  Traefik and SWAG. docs/INSTALL.md shows Burrow behind Traefik, plain
  nginx and Nginx Proxy Manager too, each for your LAN and VPN only.
- Reporting several problems in a row: the red report button stays after
  a report is sent, also after a reload, until you turn it off with its x
  or in Settings. In the form Ctrl+Enter sends, and a picture pasted
  (Ctrl+V, a screenshot of your own) or dropped on it is added. On a
  computer Settings -> Report a problem and the button's tooltip say that
  Ctrl+Shift+B reports the screen straight away, from any page.
- A problem report says whether its screenshot covers what files,
  terminals and logs showed, or shows it because the person ticked so.

### Changed

- A deploy is refused when Burrow cannot keep a copy of its compose files
  and `.env` to put back after a deploy that does not run well.
- `STATUS_INTERVAL_SECONDS` (how often a host's online dot is checked) can
  be set in `.env`.

### Fixed

- A path typed as `~bob/x` in Files became the home with `bob` glued on.
- Apps: a SWAG container whose confs could not be read is said, not taken
  for "nothing proxied by hand".
- The Android app's own dialogs (confirm, alert, leave) are secure before
  their first frame; its direct route logs connection errors in debug
  builds only.

### Security

- Listing the models of another address typed in Settings -> AI sent the
  stored key of the OpenAI-compatible server there; it goes only to the
  server it was saved for.
- A log file in a container's bind mount that is a link out of the mount
  was read on the host; it is read inside the container instead.
- A step-up is asked before uploading over an existing file (as copying
  over it already did), deleting a terminal recording or shortening how
  long they are kept, and saving files that run code: `~/.bash_aliases`,
  `/etc/update-motd.d`, `/etc/logrotate.d`, `/etc/apt/apt.conf.d` and the
  loader's confs.
- The terminal's completion runs only for a device that has the session
  open (and so is in its list of viewers).

### Verified

- The gate, the Android app on an emulator and a fresh install on a new
  Debian VM. A code audit before the first public release: each fix's
  test failed on the code before it. On the emulator a word held in the
  editor selects that word, on a phone, with FUTO's keyboard and at a
  foldable's size with the keyboard up.

## [2.9.2] - 2026-10-30

### Changed

- A row with more than one thing to do has one menu button (three dots) at
  its end instead of a row of buttons, the same as files and hosts already
  had: notification channels, users, snippets and commands typed often, keys,
  paired phones, alerts and alert rules, report schedules and Proxmox guests.
  On a phone those buttons took a line of their own under the row (reports
  3aa76b, edfcf1, e6fc13). A user's role is shown as text beside the name;
  it is changed in the menu.
- Settings -> About shows Burrow's five newest warnings, the rest behind
  *Show all*; a line between them, and between the background jobs (report
  5d1b13). The AI's usage figures have a line between them too (report
  7e91ba).
- Disk activity: a line between processes.
- The editor's find and replace on a phone takes two rows instead of half
  the screen: the field with the count, previous, next and close, the
  options (match case, whole words, regular expression) as toggles, and
  Replace a row of its own only when asked for (reports dccaf7, a4f865: on
  a computer it is one row). Alt+Enter
  in the field selects every match, as in VS Code.
- Reporting a problem: the screenshot is a small picture beside the ones
  added, larger on a tap; the box for what went wrong is lower, and the hint
  how to start a report goes as the report starts (report 04436d).
- Settings: All hosts and, on a computer, the keyboard shortcuts are parts
  of the list like the others, not a separate menu below it (report
  5c1209); #/groups/all leads to Settings -> All hosts. "?" still opens the
  shortcuts anywhere.
- On a computer a button alone on its line in a card or a form is as wide
  as the column, as on a phone (report d4ba33). Buttons side by side stay
  as wide as their words.
- A workspace opens a file clicked once in its tree as a preview, its name
  in italics: the next file so opened takes its place. A double click (in
  the tree or on the tab) or a change keeps it open, as in VS Code and
  code-server (report 96a655). On a phone every file keeps its tab.
- In the Android app a report's screenshot is the screen exactly as it was,
  taken by the app, instead of the page drawn again from its markup. What
  files, terminals and logs show is still covered unless you tick it. In a
  browser, and with an app before 2.9.2, the page draws its own picture as
  before.

### Fixed

- Away from home over WireGuard a terminal could take a minute to connect,
  and connected at once after switching tabs: a socket dialled before the
  tunnel was up hung while TCP waited longer and longer to try again. A
  terminal, container or log socket that has not opened after 4 seconds is
  now dialled again, and back in sight (or after a tab switch, or with the
  network back) one still dialling is replaced at once.
- Open/Solved above the problem reports no longer touches the list (report
  8a99b4).
- The logs in a workspace's or stack's bottom panel: their search and
  filters keep a margin from the panel's edge, no longer against the file
  tree's line; the filters stay on one line each (report d31c8d).
- "No way to reach ... from here" names the whole address; it was cut at
  its first dot, the rest after the sentence (report 8b783c).
- The editor's text no longer moves sideways when a problem's dot appears
  or goes: the dots have a narrow column of their own all along (report
  413d6f).
- A terminal opened in a folder (a workspace's) no longer shows
  `cd -- '/folder'` twice: in tmux the session starts in the folder, without
  tmux the line is typed once the shell is ready, not before its prompt
  (report 597e6b).
- A message such as *Copied* no longer lies over a row's menu button when
  the foot of the screen, above the buttons and under the title bar each
  cover one: it goes in a gap between two rows instead.

### Verified

- The gate, the Android app on an emulator and a fresh install on a new
  Debian VM; each fix's test failed on the code before it (REGRESSIONS.md).
  Two new checks on every screen of the tour: a row's buttons beside its
  words (`rowActionsBeside`), and a line between records of several lines
  (`recordsApart`).

## [2.9.1] - 2026-10-30

### Changed

- Apps -> Manage: *All* and *None* are one button beside the search that
  keeps its place, as on Containers; the bar at the bottom holds what to do
  with the picked ones. *All* left the bar once all were picked and the
  buttons jumped (report b2340c).
- A notification channel's *On* is the first thing in its form, above its
  name (report 622ce9).
- What is new in several images: what to read first and what is worth
  knowing grouped under each image and version, a line between them, a few
  lines each with the rest in its notes; a long address wraps inside the box
  (report 588254: it ran off the screen).
- A message for an empty list (no snippets, no alerts, ...) takes less room
  (reports 812166, 232696).
- 2.9.0 also changed: on a phone the terminal panel's other tab shows its
  icon only, so its buttons (Type saved password) stay in sight; the folder
  shown in a path reads it again when pressed.

### Fixed

- Rows of a list had no line between them: a reset of the row's own border
  took it away in every list (report 4af102). A check on every screen of the
  tour fails on a list without them, and on an empty-state message with more
  room around its words than they take.
- Settings -> Backups: an icon beside a long label shrank to a dot and both
  buttons broke over three lines on a phone (report cb6da8). They stand side
  by side only where each fits on one line; icons keep their size everywhere.
  A check on every screen of the tour fails on a squeezed icon.

### Verified

- The gate, the Android app on an emulator and a fresh install on a new
  Debian VM; each fix's test failed on the code before it (REGRESSIONS.md).

## [2.9.0] - 2026-10-29

### Added

- Several apps changed at once: in *Manage*, tick apps, then set their
  group, whether they show, open in a tab of their own or are watched, for
  all of them ("As it is" leaves each its own), or delete them together.
- *Find in containers* also reads the proxy confs of a SWAG container: apps
  proxied by a conf written by hand (`swag=disable` on their container) are
  found too (report 6d39c6).
- An admin may send 60 problem reports an hour (an operator 10): going over
  the screens one by one, ten was not enough.

### Changed

- The key vault, snippets and recordings are parts of Settings like the
  others, with the way back on a phone; their old addresses lead there
  (reports 8f4db3, e34ebd, 086418).

### Fixed

- A folder's star (on the phone's folders and a host's) sat at the end of
  its path, and a long path scrolled it out of sight on a phone (report
  b7caab): it stays beside the path, which scrolls on its own. A new check
  on every screen of the tour fails when a button sits out of sight in a
  row that scrolls sideways. A problem report's picture shows such rows
  scrolled as they are on the screen.
- Back and Forward come to where a page was scrolled: back from a part of
  the settings came to the top of the list (report 78bf46); on a computer a
  part chosen no longer scrolls the list to its top (report a55e25).
- Folding headers (a release's notes) wrap their words and keep the arrow at
  the right: it went off a phone's screen (report d0da1c). A check on every
  screen of the tour fails on a header wider than its row.
- A stack's update history: each update a block of its own, its images
  listed under it (report be5cf2).
- Users: a line between people, so the role, folders and remove under a name
  are that person's (report 976582).
- Commands typed often: the command a line of its own on a phone, not a
  word a line; no "|" when no host is known (report 4ed704). Saved snippets
  first, the buttons side by side.
- Containers -> Reports: its switch beside its heading, the two halves
  alike, the analyses read beforehand: switching no longer moves the page.
- A main area (log, editor, terminal) squeezed out of reach fails a check
  on every screen of the tour.

### Verified

- The gate, the Android app on an emulator and a fresh install on a new
  Debian VM; each fix's test failed on the code before it (REGRESSIONS.md).

## [2.8.1] - 2026-10-29

### Fixed

- A file copied or cut in a workspace's tree had nowhere to be pasted
  (report 67d3e6): *Paste into ...* is in the menu of a folder (into it) and
  of a file (into its folder), in a workspace and on Files, and the copy
  says where to paste.
- The Android device test says when the emulator itself stops, with the
  last of its log (artifacts/android-logcat.txt). "All files" read for real
  is a step of its own (ALL_FILES=1): the emulator died (exit 139) whenever
  the app read its storage that way, a phone does not; the app's side stays
  covered by its JVM tests.

### Verified

- The gate, the Android app on an emulator and a fresh install on a new
  Debian VM; the fix's test failed on the code before it (REGRESSIONS.md).

## [2.8.0] - 2026-10-29

### Added

- A folder of the phone as a favourite (report 9980fa): the star at the end
  of its path, as on a host; listed on Files and on This phone. Kept in the
  app on the phone only, never on Burrow's server.

### Fixed

- A container's details, opened on a phone held sideways, took the whole
  page and its log could not be reached (report 5d0b33). They now scroll in
  their own part, the state line above and the log below staying put. A new
  check on every screen of the tour fails when a log, editor or terminal is
  squeezed out of reach; the details' history heading is in heading order.
- A test of the direct route's looks given the time it takes beside the
  other browsers (it ran past 30 seconds twice). The Android device test
  steadier: Android's own buttons found again when redrawn, a shortcut's
  question taken as its answer, the emulator's disks on a volume of its
  own, and "All files" opened at the test's folder (the emulator died at
  the storage's top listing).

### Security

- re2js 2.8.8 (GHSA-gg6h-894w-4m9c, high: quadratic time in lookbehind
  matching), the expressions of a workspace's search and replace.

### Verified

- The gate, the Android app on an emulator and a fresh install on a new
  Debian VM; each fix's test failed on the code before it (REGRESSIONS.md).

## [2.7.0] - 2026-10-27

### Added

- *All files* for the app's Files page (report 862305): the whole phone and
  its memory card, as a file manager shows them. Off by default; switched
  on (on *This phone*, or in Settings -> Android app) only after a warning
  that the page, and whoever controls the server, could reach every file,
  and Android's own *All files access*. Off again at once, and when another
  server is chosen. Every path stays inside the phone's storage (a link out
  of it is neither listed nor opened). Android 11 and later.
- *Calculate folder size* also says how many files and folders the folder
  holds, and "Calculating..." while it runs (report 1b1aa2).

### Fixed

- A problem report from a folder of thousands of files crashed the app
  (report 8344c1): a very long page is drawn as the part around the screen,
  and the rows of a long list far from it are left out while it is taken
  (5 seconds instead of more than a minute, a picture of 8000 pixels at
  most instead of the page's full height).

### Verified

- The gate, the Android app on an emulator (All files for real, by
  Android's permission) and a fresh install on a new Debian VM; each fix's
  test failed on the code before it (REGRESSIONS.md).

## [2.6.0] - 2026-10-27

### Added

- *Ask AI about this file* in the editor's menu and the command palette
  (report 76bcda): the selected lines or the whole file as the editor shows
  it, with a question, to the model set up in Settings -> AI. Masked and
  cut to the model's window as logs are, each line with its number; the
  answer is only shown, never applied. Ask further under it; the questions
  stay with the file, for the person who asked.

### Fixed

- "Language server not connected" says what that means (no completion,
  hover or its problems; editing and saving go on) and why (too many open
  files with one, too slow, unavailable, gone); a connection that drops,
  as when Burrow restarts, comes back by itself, and *Connect again* tries
  at once (report 76bcda).
- The app's WireGuard apps counted the addresses of apps deleted since as
  chosen ("5 of 39 chosen" with none ticked); only listed apps count, and
  the deleted ones' addresses are taken out of the tunnel (report 80f9de).

### Verified

- The gate, the Android app on an emulator and a fresh install on a new
  Debian VM; each fix's test failed on the code before it (REGRESSIONS.md).

## [2.5.1] - 2026-10-25

### Fixed

The review's last points (2026-10-24):

- Without tmux, and on the app's direct route, a scroll over less, man or
  vim without the mouse moves them by arrow keys (it did nothing); the
  direct route's kept tmux scrolls through tmux's own history, as Burrow's.
- A letter typed with the key bar's Ctrl or Alt held starts the keyboard's
  word over, so a later correction of it cannot reach the shell.
- Search with a regular expression on a host without ripgrep reads it as
  Replace does (grep's Perl mode, or \d made [0-9]): `\d` and `(?:)`
  found nothing.
- A deploy that does not run well puts back its .env and its other compose
  files as they were deployed, not only the one compose file.
- The maintenance window's result names the stack's own update, never
  another stack's when one wrote none.
- An open file changed in the second it was read in is read again (times
  are whole seconds: its text is compared then); after a git action every
  open file is read again.
- The app: a single sign-on given up no longer keeps other sites in the app
  for ten minutes; on Android 10 a phone without a fingerprint can use the
  direct route with its screen lock.
- A typed line learnt for the history also when a busy host shows its echo
  late (a fourth look, at eight seconds); the WireGuard test records the
  toast it checks (two flaky tests).

### Verified

- The gate, the Android app on an emulator and a fresh install on a new
  Debian VM; each fix's test failed on the code before it (REGRESSIONS.md).

## [2.5.0] - 2026-10-24

### Added

- Workspace, closer to VS Code (asked for after the 2.4.0 review):
  - *Commands* (F1, Ctrl+Shift+P, or the keyboard button): every command
    of the workspace and of the file in front by a few letters of its
    name, with its keys; the ones used last first. Go to line, Reopen the
    closed tab and Move to the other side are among them.
  - Two files side by side on a wide screen: a tab moved to the other side
    (a command, or dragged onto the other bar) keeps its editor and its
    unsaved text; kept after a reload; one bar on a phone.
  - *Outline* beside Git: the headings, keys, sections, blocks or
    functions of the file in front (Markdown, YAML, JSON, Python, shell,
    nginx, INI, TOML, Dockerfile), read from the text; a tap goes there.
  - The problems badge counts every open file's problems; a tap lists them
    by file and goes to one.
  - Git: throw changes away, per file or all (asked first; a new file is
    deleted, so a step-up); a tap on the branch switches to another; the
    editor's change marks are against the last commit for a file in a
    repository, before anything is typed.

### Verified

- The gate, the Android app on an emulator and a fresh install on a new
  Debian VM; the new screens looked at.

## [2.4.0] - 2026-10-24

### Added

- About Burrow says what the running release brought, in a few sentences
  in the app's language (the text F-Droid shows), with a link to all
  changes once the project is published (report 4c30b4).
- A stack brought down from Burrow stays in sight: Containers lists it
  under Down, its page says since when, and Up starts it again from its
  compose files (it could only be brought up from a terminal).
- Workspace: Copy path in a file's menu; New file and New folder in a
  folder's menu; Go to file (Ctrl+P) searches every folder of the
  workspace and takes `name:12` for line 12; a picture, video or sound
  from the tree opens in the viewer instead of a tab saying "binary".

### Changed

- In Burrow's own tmux, `$TMUX` names your own tmux server: `tmux` starts
  your own, `tmux attach -t main` (typed, or as the host's start command)
  takes up a session started over plain ssh, and `tmux ls` or
  `tmux kill-server` act on yours, never on Burrow's (kill-server ended
  every Burrow session on the host). A `.bashrc` that starts tmux only
  when `$TMUX` is empty still starts none there.
- A finger's scroll over less, man or vim without the mouse in Burrow's
  tmux moves them by arrow keys (as xterm's alternate scroll); the mouse
  wheel on a computer goes back through tmux's history, as a finger does.
- All hosts and a host's form say what an empty choice means: "Default:
  automatic" with the key if one is chosen, else the password said under
  it, "Default: None", instead of a bare "Default" (report d07225).
- The app's WireGuard: a change of network decides again only while the
  app is seen (or the tunnel is up for a transfer or a kept session); at
  home it stays up while a direct session or forward runs through it;
  "home" is Burrow's own health answer, not any answer (a proxy's 403 or
  login page); a new network rebinds the tunnel's socket.

### Fixed

- Terminal: after a restart of Burrow, or a lost connection to the host,
  a tmux session connects again by itself (it said "failed"); keys typed
  while it connects are sent once it is open; a session taken up again
  starts at its own size, not 80x24; a second device's answers to a
  program's questions no longer reach the program as keys, and its focus
  no longer takes the session's size; a viewer attaching under vim or a
  tmux of one's own keeps the scroll region and the hidden cursor; keys
  starting with Esc typed while a kept tab replays are no longer dropped;
  a session detached on the host is kept, not forgotten while it runs;
  closing one split pane keeps the phone's keys and screen-on for the
  others; a key of the key bar leaves the focus in the text box.
- Workspace: a file with Windows line ends is saved with them (it was
  rewritten with Unix ones) and is no longer "unsaved" after an undo; an
  open file changed on the host is read again when nothing in it is
  unsaved; Replace All with a regular expression works line by line, as
  the search; a renamed or deleted file's tab follows or closes; one file
  no longer opens in two tabs; Ctrl+S saves with the focus on the tree
  or the tabs; Ctrl+Shift+F in the panel's terminal searches only it;
  tabs can be dragged in Firefox; language servers start for a tab once
  it is shown (twelve hidden ones filled the limit).
- Containers and logs: a container's log follows it through a restart or
  a recreate; a plain log file's lines are not added again at a
  reconnect; long lines of two sources no longer mix; a stack page whose
  operation lost its connection connects again instead of keeping its
  buttons off; one failed poll no longer empties the charts; a pull the
  registry refused for a moment no longer holds that release back from
  every later window; an update left in the middle by a restart is taken
  up as soon as its host can be read; `compose run` leftovers no longer
  make the review say "recreate"; a log rule on "error" no longer fires
  on Docker's own complaint; stack "web" no longer waits for a job of
  stack "web-"; an app's certificate that has run out is told once more.
- Android: the direct route's key is made anew when Android voided it (a
  new screen lock), instead of every host refusing it; dialogs follow the
  screenshot setting (FLAG_SECURE); a second tap on Update hands the
  checked download to the installer again instead of deleting it; the
  keep-open switch follows Stop in the notification and a reloaded page;
  download notifications hide the file's name on the lock screen.

### Removed

- `POST /api/ai/analyze` (the streaming analysis "kept for scripts"):
  nothing used it; `POST /api/ai/analyses` starts one.
- The internal review reports (`docs/AUDIT_*.md`); their findings are
  fixed. The Dutch store screenshots, which were the English ones.

### Verified

- The gate, the Android app on an emulator and a fresh install on a new
  Debian VM; the changed screens looked at, and a look-only round on a
  live Burrow at six sizes.
- Each fix's test failed on the code before it (unit, integration or
  e2e; REGRESSIONS.md names them).

## [2.3.2] - 2026-10-23

### Added

- An AI analysis can be asked further: under a finished answer, a question
  goes to the model with the logs as they were sent, the analysis and the
  questions before, masked the same way; the questions stay with the
  analysis, also on the Reports page (report 0a86b2). Analyses from before
  this release cannot be asked further.

### Fixed

- Settings on a laptop had two scroll bars: the list of parts beside the
  open one was cut at the window's height and scrolled on its own. It now
  scrolls with the page, and stays in view only where all of it fits
  (report 9abc2b). The tour checks every page for a second scroll.
- A workspace with no file open put the terminal and logs panel in the
  middle of the screen, with empty room under it; it is at the bottom now.
  The tour checks it on every screen with the panel.
- A host's statistics on a phone: the History title sat lower (its range
  as tall as a field) or, in Dutch at 343 px, higher than the other titles.
  The same on a stack's page: titles beside a button sat 6 px lower than
  the others. The tour checks that card titles on a page sit at one height.
- A page whose code did not load (the network changed while it loaded,
  Wi-Fi to mobile) stayed blank; it now says so after a few seconds, with
  a link that loads it again (found in the 2.3.1 gate).

### Security

- zod 4.6.7 (GHSA-mrhx-c7xc-m3w5: memory exhausted by an oversized
  collection under validation), also for the shell language server's own
  copy; fastify 5.12.7 (GHSA-389g-gv7q-r4x8), ip-address 10.7.4
  (GHSA-rxp7-6hxx-x8q5); vite 8.3.5 and vitest 5.0.5 for development.

### Changed

- The e2e browser runs in a network of its own (a forwarder on the test
  network) instead of this machine's: every container another project
  started made Chromium abort the page loading then, a blank page and a
  failed test (the 2.3.1 gate's flakes).

### Verified

- The gate, the Android app on an emulator and a fresh install on a new
  Debian VM; the changed screens looked at.
- Each change's test failed on the code before it: the follow-up questions
  (unit), the Settings list's own scroll, the blank page without the
  reload link, the panel in the middle, the card titles (the tour's new
  check fails on 2.3.0's Guests and found History and the stack page).

## [2.3.1] - 2026-10-23

### Added

- A workspace's open files can be put in another order: drag a tab onto
  another, or move the tab with the focus with Ctrl+Shift and an arrow;
  the terminal's tabs move by keyboard too (report 50a6f6). The shortcuts
  overview lists it, and F7 for the next difference in a comparison.

### Changed

- A problem report's picture covers what files, terminals and logs show:
  they can hold passwords and keys (report 50a6f6 showed a whole `.env`).
  Tick *Show what files, terminals and logs held* when the problem is in
  them. The tour checks that every editor, terminal and log is covered.

### Fixed

- The terminal in the panel under a workspace or a stack has the key
  button that types the host's stored password at a sudo prompt, as the
  terminal page has (report 35ba91: a browser cannot fill a terminal).
- One read of a host that failed while an update was watched rolled a
  good update back ("the stack cannot be read"); now only reads failing
  three times in a row do.

### Verified

- The gate, the Android app on an emulator and a fresh install on a new
  Debian VM; the changed screens looked at.
- Each change's test failed on the code before it: the panel's password
  button, the tabs dragged and moved by keyboard (workspace and terminal),
  the covered picture, the update watched over a failed read.

## [2.3.0] - 2026-10-23

### Added

- Comparing two files shows at once where and how much differs, as VS
  Code does: side by side where there is room (one column on a phone), a
  count of the places and the lines added and removed, Previous and Next
  difference (also F7 and Shift+F7) with the first one in view, a mark
  along the edge for each, and the unchanged stretches folded until asked
  for. The same in Compare with..., compare with saved, a save conflict and
  a stack's review.
- Files dropped from the computer on a folder of a workspace's tree, or in
  Files, are uploaded there; a name there already asks Replace or Keep
  both, as with the file picker (report 6d86aa).
- Find in a file says how often the text is there and which one is chosen
  ("3 of 12") (report dc29b4).

### Changed

- Settings on a tablet or computer: the list stays at the left and a part
  is open beside it, the first when none was chosen, instead of the list
  alone in the middle (report 774696).
- Containers: a big stack takes one of the two columns like the others
  instead of both (report 2018c4).
- A workspace's tree and the Files list are read again by themselves when
  the page is seen again and every 10 seconds while it is, so files made in
  a terminal show up without a reload; the tree has a button to read it now
  (report 905455).
- Host, container and disk charts show the time and value of the moment
  under the pointer in a tooltip beside it, chosen by time so a gap in the
  samples does not shift it (report af0eec).
- Burrow's own warnings no longer keep refused requests (a step-up asked,
  a page not found); a login at an address (`user@10.0.0.20`) is no
  longer masked as an e-mail address.

### Fixed

- Hosts on a wide screen: the second column's heading stood higher than
  the first's, against the search (report dc0352).
- A host's statistics: Disks stood 7 px above SMART beside it, and Guests
  sat 20 px lower in its card than the other titles; every card's title
  row is now one height. The tour checks that cards side by side have
  their titles level.
- Quick open in a huge folder ran into the host's time limit and said
  "internal": it now lists the files found in 20 seconds and says not all
  are there; any command on a host that does not answer in time is a 504
  saying how long Burrow waited.

### Verified

- The gate, the Android app on an emulator and a fresh install on a new
  Debian VM; the tour's passes of every changed screen looked at.
- Each change's test failed on the code before it: Settings with nothing
  chosen, the big stack's width, the headings' height, the find count, a
  drop on the tree and in Files, the tree and list following the host, the
  value under the pointer, the comparison, the listing's time limit, the
  masking of a login and the refused requests in the warnings.

## [2.2.0] - 2026-10-18

### Added

- Settings -> About lists Burrow's own warnings and errors of the last 30
  days, grouped by kind with how often and when, and the newest message.
  They are kept in the database, so a deploy no longer takes them away with
  the container's log (OPS-W-13).

### Changed

- IP addresses in what goes to an Ollama or OpenAI-compatible model are now
  masked unless the admin ticks *Runs on my own network* for that server
  (Settings -> AI). Before, a single-label name or one ending in `.lan`,
  `.local` or `.internal` counted as local by itself, and a rented machine
  reached as `gpu` over a VPN got the addresses unmasked (A3-SRV-20). An
  Ollama that did get them unmasked now gets them masked until ticked.

### Documentation

- THREAT-MODEL: app tabs on a WebView without profiles share one cookie
  store, an accepted risk with why (A3-AND-17).
- THREAT-MODEL: write access to the database is full access; sealed values
  stay bound to their column, not their row, with why (A3-SRV-18).

### Verified

- The gate and the Android app on an emulator; the tour's six passes of
  Settings -> About with the new list (a long warning and an error).
- The masking test failed on the code before it (an Ollama named `gpu` got
  the addresses unmasked); the warnings' test reads them back after a
  restart on the same database.

## [2.1.0] - 2026-10-17

### Breaking

- Backups are now capped: every backup younger than `BACKUP_RETENTION_DAYS`
  (30) stays, but at most the newest `BACKUP_RETENTION_MAX` (60, new). With
  many deploys a day, older archives than the newest 60 are removed at the
  next round; set `BACKUP_RETENTION_MAX` higher in `.env` to keep them.

### Added

- Deploys are watched like updates (decision 11): after `docker compose up` the services it recreated are watched for 60 s, and one that stops, keeps restarting or turns unhealthy puts the previous deployment back: the compose file as Burrow last deployed it, in a file of its own beside the stack's (your edited file stays as it is), each service on the image it ran before. A stack Burrow never deployed is said to run badly and left as it is, since its previous file is not known. A rollback is told on the channels (topic updates).
- Admins see at the top of Settings when requests come through a proxy TRUST_PROXY does not name, with the line to set (its Docker network), and when the data disk is full; a dot on Settings says there is something to look at (decision 12).
- How long terminal recordings are kept is a setting on Settings -> Recordings (7 days to a year, 30 by default). Made shorter, the older recordings go at once (decision 16).
- Settings -> About shows admins what Burrow does by itself: container history, host statistics, reports, clearing out old entries and the image update check, each with when it last ran, how long it took and its last failure (`GET /api/system/jobs`). A host that cannot be sampled is logged at warn once per host and message, and once when it is fine again; it went to debug, unseen (OPS-W-14).
- A disk's activity view lists each container's reads and writes on that disk over the same two seconds, from the container's cgroup v2 `io.stat` (Docker, Podman): it counts what is written back from the page cache too, which no process's own counters show (decision 6).
- Files: a root-owned file anyone may read opens read only at once, with *Edit with sudo*; a save refused for want of permission offers *Save with sudo* with the same base, so a change meanwhile is still a conflict (W-FUNC-01).
- Files: *Compare with...* says which file only root may read and reads it through sudo there, a password asked in place when sudo wants one.
- Files: an upload over a name that is there already asks *Replace* or *Keep both* (the new one as "name (1).ext") instead of being refused (decision 8).
- Files for an operator: only the hosts with folders granted to them, each opened at its first folder; a folder they may not open lists the ones they may, to tap (W-FUNC-05, decision 14).
- Hosts: a first tap on a host whose key is not trusted yet opens its menu with the fingerprint shown at once; *Trust and connect* trusts it and opens the terminal in one step (W-FUNC-02, decision 13).
- Containers: a host that has not answered yet is named ("Reading docker-real..."), and the stacks' counts say "(so far)" until it has (UIB-04).
- Audit log in words in both languages, who and from where without a stray separator, a filter, and one line per entry on a wide screen (UIA-07, UIB-11).
- Stack operations: while the new containers are watched, said so with the time it ends; a good rollback ends as "Rolled back (why): the previous images run again", not "Update failed"; the history shows the outcome without a reload; compose's temporary containers are left out of the list meanwhile (W-FUNC-10).
- Logs with nothing chosen say where to choose and lead there; a host without systemd says so plainly with a way to /var/log in Files (UIA-14, UIB-10).
- A picture in release notes or Markdown that does not load shows its words and "could not be loaded" (UIB-12).
- Language and theme changed in another tab are followed at once.
- Settings -> Android app: each paired phone says when it was paired beside when it was last used, and can be renamed (the pencil beside it; a step-up, as every change to devices); a long model name wraps instead of cutting off the "this device" mark on a phone. The direct route's list marks this device too, so two phones of one model, or one phone paired again, can be told apart (UIA-15).

### Changed

- The container overview sends a host's whole snapshot once, then every few seconds only what changed: changed and removed containers and, every third poll, the new stats sample the sparklines grow by. A 500-container host cost every open page about 500 KB every 5 s (340 MB an hour on a phone); a poll where nothing changed is now a few hundred bytes (decision 19, OPS-W-03).
- Containers Docker named itself (`docker run` without `--name`, outside compose, such as `unruffled_montalcini`) raise no alerts any more: on the live instance they were 33 of 34 alerts in two hours. Named containers and those of a compose project alert as before (decision 18).
- The request limit (3000 a minute) counts per sign-in session instead of per person: a runaway tab or script no longer locks the person's phone and other devices out with it (decision 20, OPS-W-08).
- A report's summary on its page is said in the reader's language, whatever the language of the schedule's channels; each channel already got its own (decision 22). The explanations a language model writes per container stay in the channels' language.
- Backups: a cap on how many are kept. Every backup younger than `BACKUP_RETENTION_DAYS` (30) stays, but at most the newest `BACKUP_RETENTION_MAX` (60, new); the newest `BACKUP_RETENTION_COUNT` (30) still stay whatever their age, never more than the cap. Every deploy, update and *Back up now* adds a round, so the age alone kept about 100 archives in 30 days (decision 17).
- A log view keeps at most 5000 lines of each source instead of 5000 in all: in a merged view a loud container no longer pushes the others' lines out of the time range (50,000 lines in all at most) (decision 3).
- Container samples older than two days are kept as one average an hour (still a month): at 500 containers the history held about 4.4 million rows; now about a seventh. Container history and host statistics read a few hosts at a time, so a host that hangs holds up only itself (OPS-W-06).
- The SMART check no longer wakes a sleeping disk (`smartctl -n standby`): a disk asleep at a check is skipped that time and said so; its last reading stands, with the time it was taken (decision 5).
- "Update anyway" for images whose release notes cannot be read is asked once per stack: after a yes, that stack's updates go on without the question. A breaking change in notes that can be read is always asked (decision 9).
- Dialogs scroll their body only: the title, the close button and Cancel/Save stay in sight; the problem report's Send is in the footer; form dialogs have Cancel beside Save; titles take two lines rather than being cut (UIA-01, UIB-01, UIA-02, UIA-08, UIA-20).
- Menus (a host's, a file's, a container's, updates, new session, mute) open as a popover beside their button on a computer and as a sheet on a phone, their actions in one full-width column (decision 28, UIB-08).
- Wide screens: content centred beside the rail; host statistics with the history across the top and the other cards in two balanced columns; a big stack across both columns of Containers (decision 26, UIB-06).
- 720-899 px (a tablet upright): the rail as icons, and Settings' parts in a column beside the open one; that column grows with the screen (decision 27, UIB-13).
- Hosts: the add button sits in the title bar on a phone too; the floating round button is gone (decision 25, UIA-06).
- Dutch: "Alerts" is "Meldingen"; the device's own notifications are "Pushberichten" (decision 24).
- ntfy channels have no default server: it is entered (the public ntfy.sh would carry host and container names) (decision 10).
- Ask AI: the question is shown first and sent on *Suggest a command*, as before; USAGE.md says so (decision 15). The question box stays in sight at the foot of the conversation.
- Server errors in the Dutch app are Dutch: every code the server sends has words in both languages, the parts that vary filled in; a library's or the network's own words (ECONNREFUSED, an SSH handshake timeout) are said in Burrow's (W-FUNC-06).
- AI settings: *Load available models* lists the models of the address and key typed without saving the form, and picks the first; Save refuses an empty model (W-FUNC-07).
- Texts: report counts with plurals ("2 problems", "1 needs attention"); the invite page and setup speak to the one invited ("Join Burrow"); an operator's host button says "statistics"; a host's health alerts are muted as the host's; the TOTP QR has a name; the terminal's menu is "Sessions and more"; channel topics start with a capital; shorter Dutch relative times and labels (W-FUNC-12, UIB-16, UIA-08).
- About: an older version found is not offered as an update; a result without a code says only its state (UIA-21).
- The bottom panel's log source is one button that says what is shown (an icon on a phone) (UIA-11).
- The editor's find and replace is made for a finger on a phone (UIA-18).
- The direct route's forward dialog: "Machine" and "Open" (UIA-17).
- Android app: the download question of an app tab, and an app tab's sign-in, are asked in Burrow's own dialog look (a sheet from the bottom on a phone, a box in the middle on a tablet, Cancel and the primary button side by side, light or dark as the app) instead of Android's platform dialog (decision 23).
- Android app, direct route: the forward dialog's field is "Machine" and its button "Open" (both wrapped on a phone), "Trust key" in the host-key question, and the explanation sits under the hosts instead of taking a third of a phone's screen above them (UIA-17).
- A build of the private tree has no "Report on GitHub" (it led to the OWNER placeholder): it says there is no public project to report to and offers the download instead; the public export keeps the link. README and INSTALL say in the private tree that their clone address is the placeholder; those lines are left out of the public export (W-FUNC-15).
- Tests: the e2e and integration test hosts with the real docker CLI reach this machine's Docker through a filter that shows them the tests' own containers only (named burrowtest-* or made through it), refuses prune and removes no other image; before, a test instance listed, watched and reported on the live containers and read their logs (A3-WEB-16, W-FUNC-17).
- Tests: `ONLY=<Class[#method]>[,...] bash scripts/android-test.sh` runs those Android tests alone, after setting up and pairing the app (and the WireGuard server or the direct route where they need it); a worktree without `.env` can run it (W-FUNC-16).
- Tests: the direct route's pages and its four dialogs pass the layout checks in e2e (`mobile-direct.spec.ts`, a stand-in for the app's bridge), in English, Dutch at 343 px, dark, a Dutch tablet and dark Dutch on its side (UIA-17, UIA-23).
- Tests: a new layout check, `textOnScreen`: no text cut by the screen's edge inside a box that clips it (UIA-12).

### Fixed

- The watching view of a shared terminal and the recording player kept a light terminal on a dark page (its text at 1.1:1); they follow the theme now, as the terminal does.
- A log view never said any more that a source had more lines in the range than it keeps: the server sent only what is kept. It asks one line over now and says so.
- tmux's refusal to nest was said again after the notice was closed, when tmux redrew the screen; now only as the answer to a line just run.
- A dialog's footer buttons broke their words over two lines on a small phone instead of taking a row each; an analysis' title (a list of its sources) was cut, now its first source and how many more.
- A host that stopped answering while its connection stayed up (a paused VM, an overloaded host) kept showing its last containers, CPU and memory as current. Containers and a container's page now say "<host> has not answered for N s: what is shown is how it was then" once a host has been silent for 20 s (OPS-W-04).
- A full data disk answered every save, sign-in and second-factor confirmation with a bare "something went wrong" while the health check stayed green. Now each such request says Burrow's data disk is full and what to do (`507 disk_full`, in English and Dutch), `/healthz` answers 503 with the hint `disk_full` while less than 50 MB is free, so the container turns unhealthy, and the alert channels get one message until there is room again (OPS-W-02).
- Every SSH round trip waited about 40 ms for a delayed ACK: Burrow's SSH connections now set TCP_NODELAY. Listing a folder of 5000 files takes a fraction of the 2.4 s it took, a terminal's echo about 2 ms instead of 44 ms, and saves, uploads and every docker command are faster (OPS-W-01).
- The deploy review said "No changes in the file" right before a deploy recreated a container whose compose file had been changed outside Burrow. The review now compares with what runs, by compose's own configuration hashes, and says which services a deploy recreates or starts (W-FUNC-04).
- An alert for a container that was gone by the time Burrow read its last lines (a `docker run --rm`) carried docker's "Error response from daemon: No such container" as if the container had printed it, to the channels and to Analyse. It now says Burrow could not read its last lines, and why (W-FUNC-08).
- An update that was rolled back was put on again in every maintenance window, watched for 60 s and rolled back again, night after night. Burrow now remembers the digest it rolled back: the window leaves it (a newer release in the registry is tried), the stack says "This version was rolled back here on <date>" beside it, and updating to it by hand asks first (W-FUNC-03).
- An update that did not run well and was put back ended with the headline "Update failed (exit code 1)"; it now says "Update rolled back: <why>. The previous version runs again, and runs well." (W-FUNC-10).
- A stack deploy (or any compose operation) still running on the host when Burrow restarted went on there but was forgotten: Activity was empty and a retry was refused on the host without the running one being shown. Burrow now looks for operations still running on its Docker hosts after a start (and when the host refuses a new one), follows them from their start, lists them under Activity, and finishes a deploy left in the middle: it watches it and keeps its file as deployed when it ends well (OPS-W-05).
- A host with more than about 950 containers (fewer with chatty healthchecks) showed none and "docker's answer was larger than Burrow reads (4 MB)": most of inspect's answer was the healthchecks' last five outputs, which Burrow never shows. They are now left out on the host (OPS-W-10).
- Where Burrow's own container was not found (Burrow on a host not added), each visit of Settings -> About read every Docker host one after another: 3 s with 51 hosts, plus the timeout of a hung one. The hosts are now read at once, and "not found" holds for five minutes unless the hosts change (OPS-W-11).
- A TRUST_PROXY that no longer names the proxy (the proxy container recreated with a new address) went unnoticed while the sign-in throttle and the audit log saw the proxy for everyone again. It is now said like an empty one: in the log, on `/healthz` and to admins (OPS-W-12).
- New problem reports arrived silently. Admins now see how many are open on the Settings menu item and beside *Report a problem*, and a new channel has *problem reports* ticked while no channel takes them yet (W-FUNC-11).
- A scheduled report whose minute no tick of the scheduler landed in (after a host suspend, a clock step forward or a stalled server) was skipped for good. The scheduler now looks at every minute since its last tick, up to a day back, and makes such a report once (OPS-W-07).
- A backup copy cut off by a kill during its last second left a `.partial` file in the backups folder for ever; a round now removes those older than a day (OPS-W-17).
- A log alert rule on a host with more than 60 running containers saw only 60 of them, said only in the server log, once a minute. The rule now says on the Alerts page how many of its containers it sees on that host, and the log says it once per change (OPS-W-09).
- Hosts added or changed on another device did not appear on an open Containers page (or a container's page, or the bottom panel's logs) until a reload. The server now tells every page that watches containers when hosts or groups change, and the page reads the list again (W-FUNC-09).
- A toast no longer covers a selection bar's buttons, an empty list's Add or a dialog's Send: it goes where it covers fewest buttons, above them or under the title bar (UIA-04, UIB-09).
- The busy panel opens from its pill at the foot on a phone, no longer over the title bar and its back button (UIA-06).
- The keyboard shortcuts' descriptions fit a 343 px phone (UIA-03).
- A field's help "?" no longer covers the end of its label (UIA-05).
- Unit names, disk models, recovery codes and container names are no longer broken at their hyphen (UIA-09, UIA-10, UIB-07); the Files table's Changed column keeps room for its words (UIB-15).
- A tapped help "?" no longer stays accent-green on a touch screen: hover looks only where there is a hover (UIA-13).
- The sixth accent colour no longer sits alone on a second row (UIA-19).
- The chosen tab of a scrolling tab row (terminal sessions, sections) is kept in sight when the row narrows or another is chosen (UIB-03).
- The rail's hosts are there whichever page is opened first (UIB-05).
- The ntfy topic's check works in Chrome (W-FUNC-13).
- A dialog footer's buttons keep their words on one line, each on a row of its own when they do not fit; a dialog body that scrolls can be focused to scroll it.
- The audit log's words cover every action, known hosts, alert rules and report schedules included.
- Taking a problem report's picture no longer breaks the page's base-uri rule; its fonts are embedded (W-FUNC-14).
- The recording player fits the recording's width (UIB-14); the editor's empty Problems list draws no rule (UIB-16); a log file path refused is said in words (UIB-16).
- The e2e own-tmux test on a phone is steady: a tmux socket per test, ended through the API and waited for, the session closed however the test ends.
- The terminal's Volume-up hint ran past the right edge of a phone in one line; it wraps between its parts now, "W A S D: arrows | E: Esc | ..." (UIA-12).
- The direct route's host list and terminal had no main landmark (axe), and a forwarded port's or a snippet's name was cut off by its buttons at 343 px (UIA-17).
- Android test: the screenshot after pairing (04-hosts) showed the pairing form, and the one after adding a phone folder (42-phone-folders) "No folder added yet"; both wait until the page is drawn on the screen (UIA-16). The shake report is checked to open with its Send on the screen (UIA-02, the app's side).

### Verified

- The gate, the Android app on an emulator (each test can now run alone, the
  phone's own files and pairing among them), and the screenshots of every
  changed screen in the tour's six passes, which now also show the screens
  only seen in light English before and the direct route's dialogs.
- Every fix's test failed on the code before it; each finding of the
  2026-10-16 review has its test named in docs/REGRESSIONS.md.

## [2.0.2] - 2026-10-16

### Fixed

- In the Android app the keyboard did not come up any more once the
  fingerprint lock had been on: unlocking gave the page back its focus but
  not its focus on a touch (from 2.0.0; report 5e035c).

### Verified

- The Android app on an emulator, its lock test checking the page takes the
  focus on a touch again after the unlock (red before the fix), and the gate.

## [2.0.1] - 2026-10-16

### Fixed

- Before a self-update, Burrow listed every release's breaking changes when
  the running version was not named in the new CHANGELOG (a build of one's
  own, a patch between); now only those of versions newer than the running one.
- The editor's compose check put every error of today's docker compose (Compose v5: "services.web.imagee false schema", a YAML error "at L4.C12") on line 1. Errors are now placed on the line they are about: the path in the message is followed key by key (the key of the service named, not another service's), and a YAML position gives line and column. Found by a new integration test against the test host's own docker compose.
- An operator's search in a granted folder could show results inside Burrow's own data folder (terminal recordings among them) when Burrow could not check that folder on the host (the `find` for it failed). The search is now refused with why, instead of showing the results unfiltered.
- When Burrow could not read the containers on a host (for example the Docker listing failed), it took its own compose folder (with `.env` and `secrets/`) as "not on this host" and kept that answer for five minutes. During that time, an operator granted a folder above it could open it. An operator's file access on such a host is now refused with a 503 that says why, and Burrow asks again after a few seconds. Hosts whose containers were read are not affected.
- When Burrow found more than one Burrow (for example when run outside a container, or with a second install on a host), it closed none of their compose folders (`.env`, `secrets/`) to operators, because it could not tell which one was itself. It now closes the compose folder of every Burrow it finds. The self-update still updates none when it cannot tell which one is itself.
- Terminal completion: after the values of an option that takes several (`npm install -w web`), typing a dash offers the options again instead of nothing.
- Settings -> AI: removing a stored API key no longer puts back the saved settings over a change typed and not saved yet (a model went back to the saved one).

### Changed

- Test coverage round for the server and `shared`: behavioural tests for the language server bridge (with a stand-in language server), passkeys (registration, sign-in, step-up and removal through the API with a software authenticator, every refusal included), host reachability checks, terminal recordings, the model providers' failures and Claude's streamed answers, snippets, the key vault's sealed passphrases, container history, the self-update routes (on the test sshd: the check, a detached start, one update at a time), the compose check, journal units, configuration errors, which files an operator may open as the host changes, and `shared`'s request schemas, prune input, report reasons, alert rules and titles. The gate's coverage floors go up accordingly (`COVERAGE_UNIT`, `COVERAGE_INTEGRATION`, `COVERAGE_SHARED` in `scripts/gate.sh`).
- Tests: the web app's own logic (`web/src/lib`) is measured by its unit tests and held to a floor in the gate's unit step (`COVERAGE_WEB_UNIT=82`, lines 61% -> 83%); new unit tests for the router, the api client, i18n, the Android bridge, push in the app, uploads and copy jobs, the completion engine's generators and more.
- Tests: the e2e web coverage also counts what a page ran before a reload or a new address (it was lost unless a screenshot check came in between) and is written as `lcov.info` beside `summary.json`; new e2e tests for push in the browser and in the app, the AI settings' keys and models, a disk's processes and SMART reasons, pictures in a problem report, WireGuard from a QR picture, a file or the camera, the phone's Back over dialogs, pairing the app and its own sign-in, a snippet's container variable and folding by line number. `COVERAGE_WEB` 91 -> 96 (96.76% reached, from 92.54%).
- Android: the device test (`scripts/android-test.sh`) now ends with the line coverage of the instrumented tests, alone and together with the JVM tests (JaCoCo; `deviceCoverageReport` and `combinedCoverageReport`, per file in `android/app/build/reports/coverage/combined/html/`).
- Android: the logic that decides things is apart from the Android glue and tested on the JVM: the bridge's checks on a request (`BridgeRules`), the downloads' state machine (`Downloads`, its Android side in `AndroidDownloads`), the phone's folders (`PhoneFolders`, the Storage Access Framework in `SafDocuments`), the fingerprint lock (`LockFlow`), the WireGuard's routing, proxy and configuration rules (`WireGuard` companion, `WgConf`, `TunnelSocket`), push (`Push.notice`), `DirectStore` (folder and key given) and `Http`. JVM line coverage 13.8% -> 28.5%, its floor 11% -> 28%.
- Android WireGuard (Go): names, addresses and the proxy's secret tested through two linked netstacks without a server; statement coverage 85.1% -> 95.6%, with a floor of 94% in the gate's go step.

### Verified

- The gate, with its coverage floors raised: server unit 67, integration
  81, shared 98, the web app's lines in e2e 96, and new floors for the web
  app's own logic in unit tests (82) and the Android WireGuard's Go (94).
- The Android app on an emulator, now with its line coverage measured
  (device tests 80.4%, with the JVM tests 86.0%).
- Every fix's test failed on the code before it.

## [2.0.0] - 2026-10-16

### Breaking

- Operators open no files until an admin allows folders for them: in
  Settings -> Users, the folder button on each operator's row, per host
  (A3-SRV-01).
- The Android app's own WireGuard no longer asks the phone's DNS for a
  name (A3-AND-01): if your WireGuard configuration has no `DNS =` line,
  add your home's DNS server there, or list addresses (not names) under
  Settings -> Android app -> WireGuard.
- SWAG's auto-proxy no longer picks Burrow up by itself: the `swag` label
  is `disable` unless `.env` says `SWAG_ENABLE=enable`. Using SWAG with
  swag-auto-proxy? Add `SWAG_ENABLE=enable` to `.env` (after making sure
  SWAG serves Burrow's name to your LAN or VPN only, docs/INSTALL.md).
  `SWAG_URL` now defaults to `burrow.local.*`.
- Behind a reverse proxy, set `TRUST_PROXY` to the proxy network's subnet
  (`docker network inspect proxy -f '{{(index .IPAM.Config 0).Subnet}}'`),
  if you have not: without it every device counts as the proxy, and ten
  failed sign-ins from any of them block sign-in for everyone.

### Added

- A workspace compares a file with another: "Compare with..." in a tab's tools (a right click on the tab) and in the tree's menu picks another open file or any file of the workspace's folders, shown read-only with both paths named; an open file is compared as its tab has it, and a file only root may read says how to open it through sudo (report 9d710d).
- The terminal's AI dialog is a conversation kept with the terminal session: earlier questions and suggestions stay (newest last, also after closing the dialog or on another device, at most 20, gone when the session ends), a follow-up ("make it recursive", "why?") goes with the last four turns masked, and any earlier suggestion can be put on the command line again or copied; still never run by Burrow (report 411dbe).
- Android app: the phone's own files on the Files page ("This phone", beside the hosts; not in a browser). Folders are picked in Android's own folder picker (Documents, a folder in Download, or any other) and kept with a persisted permission; the app asks for no storage permission. Files open in Burrow's own views: text in the editor (saved back to the phone, with the difference shown when another app changed it meanwhile; "Open read only" to only read), pictures in the gallery, "Open as log" in the log view; PDFs, video, music and the rest in another app of the phone. Nothing of the phone's files goes to Burrow's server unless one is copied to a host (report a9552e).
- Android app: "Copy to a host" for one or more of the phone's files (the share page's host and folder, then the normal upload), and "Copy to this phone" in a host file's menu (a folder of the phone chosen, the app downloads it there with its progress in the notification) (report a9552e).
- Disk activity on a host's statistics page (report d4a9c0). Each whole disk is listed: HDD, SSD or NVMe SSD, with its model and size, its writes and reads per second, and how busy it was (iostat's %util). The numbers cover the same second as the CPU reading. Partitions, loop devices, device mapper and RAID devices are not listed. A hard disk also shows whether it is spinning or spun down. Burrow only reads this from sources that do not wake the disk: as root it asks the drive with `hdparm -C` or `smartctl -n standby`; otherwise it uses the kernel's runtime power state, or knows the disk is active when it did I/O just now. If none of these tell, the state shows as unknown. Burrow never runs anything that would spin a disk up.
- Each five-minute sample keeps each disk's I/O counters, for a month (migration `0041_host_disk_samples`). A disk's history shows the average over each interval: write and read rates, writes and reads per second, and busy %. A reboot or a gap gives no point.
- Tapping a disk opens its activity: the numbers now, its history and, for admins, who reads and writes. That last view samples each process's `/proc/<pid>/io` twice, two seconds apart, every few seconds while the view is open, and never in the background. No agent and no iotop are needed. The busiest processes show their name, their container, their read and write rates, and the files they have open with the disk each file is on. The container's name comes from the containers Burrow already knows. Each file is matched to its disk through the process's own mounts, including a container's overlay, LVM, LUKS and RAID. The view runs as root through sudo with the host's stored password, the same way SMART does. If sudo refuses, the view shows only the SSH user's own processes, gives sudo's reason, and does not try sudo again for 15 minutes. A sample that cannot be read shows an error with Try again, never an empty "nobody writes" list. Operators see a disk's numbers and history but not the processes. The process view reads every process and its open files as root, including folders closed to operators.

### Changed

- Adding, changing or removing a notification channel asks for a fresh
  step-up (A3-SRV-07).
- Commits, pulls and pushes from Burrow no longer run the repository's hooks (A3-SRV-04).
- New migrations: 0039_alert_reads (alert read state per person) and
  0040_file_access (an operator's folders per host).
- A tablet (720 to 899 px wide, an iPad or a foldable upright) gets its
  own layout instead of the phone's stretched: hosts, containers (with
  their sparklines) and files as tables, apps in a grid, the busy list
  from its pill at the foot; the editor's wrapped lines hang under their
  indentation; Reports' view switch is as wide as its words on a computer
  (A3-WEB-15).
- The step-up the app can ask for at its start (its direct-route key is
  new) says why.
- A page's own Back arrow goes up to the page it belongs to (a container
  to Containers, a host's statistics to Hosts, a file to its folder),
  also when it was opened from a push, a link or another section; the
  phone's and the browser's Back still go back in history (report
  2026-10-11-07-29-37-87f290).
- A link into Burrow never acts by itself: `#/hosts?connect=<id>` (the
  app's home screen shortcuts too) asks "Open a terminal on <host>?"
  first, and an alert's or a push's "Analyse" opens the analysis with the
  logs and the model it would go to named, sending nothing until Analyse
  is tapped (A3-WEB-07).
- `make apk` runs Android lint (any warning fails) and a line-coverage
  floor for the app's JVM tests; the device test runs a tablet pass and a
  dark Dutch pass after the phone's, finds Burrow's buttons by their text
  in the pass's language, fails on a black screenshot, and can run beside
  another run with its own names, ports and limits (A3-AND-12, A3-AND-13).
- USAGE.md says that a direct-route port forward is reachable by every app
  on the phone while it runs; INSTALL.md that on Android 10 pairing needs a
  fingerprint (A3-AND-15, A3-AND-19).
- The Android app is signed with APK Signature Scheme v3 (the same key),
  so the key can be rotated later without a new app; `make apk` checks it
  (A3-AND-18).
- On a tablet, the Android app's lock and "cannot be reached" screens keep
  a phone-wide column instead of buttons across the whole screen; the
  app's own questions (a download, a sign-in in an app tab) follow its
  light or dark look (A3-AND-23).
- Backups are kept by age with a floor of a count: every backup of the
  last 30 days (`BACKUP_RETENTION_DAYS`) and always at least the newest
  30 (`BACKUP_RETENTION_COUNT`), for the second copy as well. A restart of
  the backup service makes no extra round when the last one is younger
  than the interval. Before, the newest 30 alone spanned only a few days.
- The self-update builds or pulls the backup service with Burrow (today's
  Alpine packages included) and starts it again once Burrow is healthy;
  `restore.sh` builds the backup image from the checkout before a restore.
- Both containers have limits: Burrow 2 GB of memory, 512 processes and a
  256 MB `/tmp`; the backup service 2 GB and 64 processes (each settable
  in `.env`).
- The image runs on Debian 13 (node:24-trixie-slim) and has no setuid or
  setgid files; the dev wrapper uses the same image.
- Public releases go on top of each other in one history
  (`make export-public DIR=<the public repository's clone>`), so `git pull`
  and the self-update keep working from the second release on; the
  internal audit reports stay out of the export.
- A release builds its images once, checks them (the arm64 start, Trivy)
  by digest, and only then tags them (`X.Y.Z`, `X.Y`, `latest`, the backup
  image too); they carry an SBOM and build provenance. The Android signing
  key exists only in the step that runs Gradle, after npm and the web
  build, and no checkout keeps the token.
- An npm package with an install script that `allowScripts` does not name
  fails the install (`.npmrc`, `strict-allow-scripts`); `cpu-features`
  (ssh2's optional helper, whose build ran on every install) is named and
  skipped. The gate audits the dev dependencies too (critical fails).
- The gate checks compose.yaml's hardening and limits as users run it, the
  public export (one history, nothing private) on every run, that Renovate
  sees every pinned version, and that the F-Droid draft uses the app's own
  toolchain (Node 24.21.0, Go 1.27.2, NDK 30); the export fills in the
  draft's version fields.
- docs/DEPLOY.md: upgrade, roll back by hand, recover on a new machine,
  the prebuilt images, the master key as a Docker secret file, a data
  folder owned by uid 1000, and copies off the machine. The README names
  the bundled editor tools and their licences.
- A data folder inside the checkout works (`BURROW_DATA=./data/live`): a host backup that copies a folder file by file failed on Burrow's live SQLite files there (report 4b9965). `docs/DEPLOY.md` says that a folder in the checkout is given as `./...`. The compose check tests that a relative `BURROW_DATA` mounts that folder for Burrow and for its backup service. ESLint skips `data/` and `backups/`.
- The tour checks two more things on every screen (report 1d821b):
  - a button narrower than its box whose label wraps onto two lines (`buttonLabelsOneLine`);
  - buttons of the same rank stretched to fill a line but with different widths (`rowButtonsSameWidth`).
- The tour now shows a stack's page with an operation running and its output open (`stack-op`), and its file-access screen picks the test host instead of whichever host comes first by name (report 1d821b).
- Typing `tmux` where tmux refuses to nest ("sessions should be nested with care") now says why: in Burrow's own tmux, that the session already runs in it, with a button that types `TMUX= tmux` to start one of your own inside it; in a session without Burrow's tmux, that the shell already runs in a tmux of your own (report 7340bb).
- The help on "lost on restart" says that a tmux you start in such a session yourself keeps running on the host (report 7340bb).
- docs/USAGE.md: Claude Code can draw the first key after a pause one column left, over the space after its prompt (anthropics/claude-code #78737); what it received is right, Ctrl+L redraws (report 117251).
- Open files of the same name in a workspace carry the part of their folder that tells them apart ("docker-compose.yml app", "docker-compose.yml backup/app"), with the full path on hover and in the window title (report 9d710d).
- A problem report marks a failed request the page answered itself (an editor offering "Open with sudo" for a file only root may read) as handled, not as a failure (report 9d710d).
- Android app: removing a phone folder from Burrow gives its permission back to Android; choosing another server removes them all (report a9552e).
- A problem report sent from the phone's files names only the page, not the phone's file (report a9552e).
- The tour's squeezed-text check (`textNotSqueezed`) now measures the text's own box instead of its element's. Text placed directly in a grid or flex container sat in a track narrow enough to show one letter per line, while its element was wide: in the disk activity dialog, "3 more files" went unnoticed this way (report d4a9c0).

### Fixed

- A picture in release notes sent in chunks was read whole into memory
  before its 5 MB limit was checked; reading now stops at the limit
  (A3-SRV-16).
- Operators watching a shared terminal were dropped as "signed out"
  within a minute; they now stay while it is shared with them
  (A3-SRV-06).
- Removing a person, or making an admin an operator, now ends their
  terminal sessions, tmux on the host too; they kept running there
  unseen (A3-SRV-09).
- An invited admin who never finished could not be made an operator or
  removed while another admin existed (A3-SRV-15).
- The key button no longer types the host's password into a session that
  is shared or recorded, where it could show on screen (A3-SRV-19).
- Turning notifications on with a push address another person already
  used moved their device over, and they silently stopped getting
  alerts; it is now refused until they turn theirs off (A3-SRV-10).
- Masking before logs go to a model missed common secrets: Redis URLs
  with an empty user, --password X and mysql -pX, Stripe, GitHub
  fine-grained, GitLab, npm, Google, Telegram and ntfy tokens, signed
  URLs, webhook addresses (Discord, Home Assistant, Slack) and the
  password after user@host:; a rule for long random-looking strings
  catches unknown shapes (A3-SRV-05).
- Burrow's risk rules now label find -delete, zfs/zpool destroy,
  crontab -r, firewall lockouts, interfaces taken down, scripts from
  curl in $( ) or <( ), rsync --delete, DROP DATABASE, kubectl delete
  and writes into /etc high, and sed -i, service stop and eval medium
  (A3-SRV-12).
- The update check fetched a registry's token address wherever it
  pointed, so an image name could make Burrow send requests into its
  own networks; tokens are now asked only over https of the registry's
  own domain or a known auth service, without redirects, and registry
  redirects go to https only (A3-SRV-14).
- A recording still running after 30 days was deleted while being
  written; it is kept until it ends (A3-SRV-21).
- Saving as root (sudo) refuses a path that goes through a symbolic link
  root does not own, so a planted link cannot redirect the write
  (A3-SRV-21).
- Hosts and groups are listed as people read names (xl-2 before xl-19,
  upper and lower case together) where no own order is set (A3-WEB-11,
  server side).
- A paired phone's session could replace its direct-route SSH key on
  every granted host without a step-up; a new key now asks for one (the
  same key reported again does not) (A3-SRV-03).
- A stored secret no longer follows a changed address: a channel's ntfy
  token or SMTP password, the OpenAI-compatible key and the single
  sign-on client secret are dropped when the server they go to changes
  and they are not entered again (A3-SRV-07, A3-SRV-17).
- Behind a reverse proxy without TRUST_PROXY, ten failed sign-ins by
  anyone blocked every sign-in (passkeys, recovery codes, pairing) for
  everyone, again and again. Attempts through a proxy Burrow was not told
  about are now counted per client the proxy names, and Burrow warns in
  its log and on /healthz (hints: trust_proxy) that TRUST_PROXY should be
  set (A3-SRV-02).
- Failed passwords for an admin's name from anywhere blocked that admin's
  step-up; a step-up is now counted per sign-in session (A3-SRV-02).
- git in a workspace ran a repository's own commands: its
  core.fsmonitor on a status (an operator's too), its filters and its
  hooks. git now runs with fsmonitor and hooks off, and a repository
  whose own settings run commands is refused with the setting named
  (A3-SRV-04).
- An operator could read every AI analysis, an admin's analysis of any
  log file included; they now see their own and those of what an
  operator may read itself (A3-SRV-11).
- Alerts are read or unread per person: an operator opening the alerts
  cleared the admins' badge (A3-SRV-11; migration 0039).
- Any output on a terminal (a file shown with cat, a log line, the motd)
  could put a command into the history and its suggestions through the
  shell integration's escape sequence; a reported command now counts only
  after an Enter someone typed (A3-SRV-13).
- Operators could read every file the host's SSH user could, on every
  host: private keys, .env files, /etc/shadow as root, and Burrow's own
  master key and database. They now open files only in the folders an
  admin allows them per host (Settings -> Users, the folder button on an
  operator's row: allowed and denied folders, the longest match decides);
  without a grant, no files on that host. Paths are judged as they really
  are (links resolved). SSH keys, /etc/shadow, /proc and Burrow's own key,
  database, data folder, backups and compose folder stay closed to
  operators whatever is allowed (A3-SRV-01; migration 0040).
- Saving a file that grants a shell (SSH keys, a shell's start-up files,
  cron, sudoers, units), unpacking an archive and copying or moving over
  existing files now ask an admin for a fresh step-up, like deleting
  (A3-SRV-08).
- A read that failed stays said on the page, with Try again: Containers,
  the audit log, Users, a log the server refuses ("You may not read these
  logs." instead of "No lines yet."), a new host's groups, import, the AI
  and automatic-update settings, phones, push devices and the server's
  version showed it only in a toast that went after six seconds and then
  looked empty. Settings that save at once are not shown over values that
  were never read (A3-WEB-01).
- nginx -t no longer says "No running containers on this host" while it
  reads them or when the read (or docker on the host) failed (A3-WEB-03).
- A reverse proxy's error page while Burrow restarts is said in words
  ("Burrow is not answering (502) ...") instead of "http 502"; Burrow's
  own error messages are in Dutch in the Dutch app where the server's
  words are known (A3-WEB-05, A3-WEB-13).
- A terminal session the server cannot open (its host away after a
  restart, SSH refused) says why with Try again, instead of
  "reconnecting" every 8 s for ever (A3-WEB-02).
- SMART that could not be read no longer says "Not checked yet"; the kept
  checks, the statistics history, earlier analyses, a report schedule's
  channels and container suggestions and WireGuard's app tabs say they
  could not be read instead of looking empty (A3-WEB-06).
- Merged logs on a phone cut a long source name with "..." and keep the
  level in sight; a JSON line's {...} button no longer breaks over two
  lines (A3-WEB-10).
- Markdown (release notes, READMEs) keeps a link or code written right
  after a bare address (A3-WEB-08).
- Durations are in Dutch in the Dutch app ("draait 3 uur", not "2h"), and
  English dates are written day first as everywhere else ("28 Sep 2026,
  16:05", not "Oct 11, 2026") (A3-WEB-13).
- An app's uptime is no longer rounded up to "100%" after a short outage;
  an exited container whose end is unknown no longer reads "exited (137)
  ago" (A3-WEB-22, A3-WEB-25).
- A stack's review no longer compares with a compose file kept from an
  earlier account on the same tab, or from before someone else changed
  the file (A3-WEB-14).
- A command typed for several hosts, and the hosts picked for a phone's
  direct route, are no longer lost by closing the dialog: it asks first;
  selecting text out of a field onto the backdrop no longer closes a
  dialog (A3-WEB-12).
- Dark mode on a computer: the rail's "Your hosts" is readable (it failed
  contrast) (A3-WEB-04).
- Proxmox guests' buttons no longer run past their card in the side
  column of a host's statistics (seen in Dutch).
- A self-update whose backup service did not come back says so in the
  app's words.
- A long snippet name no longer hides its "All hosts" pill (A3-WEB-09).
- The step-up dialog says where to get a way to confirm when this device
  has none, instead of showing only Cancel (A3-WEB-23).
- Security: the Android app's WireGuard looks a name up only through the
  tunnel's own DNS (the configuration's `DNS =` line), never through the
  network the phone is on. On an open Wi-Fi that network's DNS could send a
  plain-http app tab, with its cookies, to an address of its choosing.
  Without a `DNS =` line, names fail and say so: give addresses instead
  (A3-AND-01).
- Security: another app on the phone could send Burrow's main screen a
  host shortcut's "connect" and have it open a terminal on that host. Host
  shortcuts now go through an entry of the app's own that no other app can
  start; links and shortcuts only open a page, and Burrow asks before it
  connects, analyses or runs anything (A3-AND-05).
- Security: files shared into the Android app are read only from another
  app's provider; a `file://` path or the app's own files (its cookies and
  settings) are left out (A3-AND-07).
- When Android ended the app's web renderer (low memory, a heavy app tab
  crashing it), the whole Android app went with it, direct sessions and
  the tunnel included. App tabs now reload their page, and the direct
  route keeps its session and shows it again (A3-AND-02).
- Opening Burrow while a direct session ran (a notification tapped, a
  share into Burrow, a shortcut) ended every direct session, also one kept
  open; so did a change of the phone's font size or language. The direct
  route now has a screen of its own in the recent apps and keeps its
  sessions (A3-AND-04, A3-AND-20).
- Away from home, coming back to the Android app after a minute elsewhere
  reloaded Burrow's page (the tunnel had gone down to save the battery),
  and an unsaved edit was lost. The page now reconnects without a reload;
  a page that does ask before leaving asks in Burrow's words (A3-AND-03).
- The direct route away from home stopped at "host key changed" when the
  network the phone was on had its own machine at the host's address; it
  now tries the host through the app's WireGuard then (A3-AND-06).
- Security: while the Android app is locked, Burrow's page behind the lock
  is hidden from screen readers and accessibility services, takes no
  keyboard focus, and gets no volume keys (A3-AND-08).
- Security: choosing another server in the Android app also removes the
  direct route's SSH key and the old server's push registration; before,
  the old server's hosts kept trusting the phone's key and the old server
  could still notify it (A3-AND-09).
- Privacy: on the phone's lock screen, Burrow's alert notifications only
  say that an alert or report came; what it is about shows once the phone
  is unlocked (A3-AND-10).
- An app tab whose app cannot be reached says why (and whether it went
  through the tunnel) with *Try again*, instead of a blank grey page; video
  in an app tab plays full screen; a download that an app sends on to
  another server (a CDN) works, without the app's cookie (A3-AND-11).
- Security: app tabs and the app's own requests refuse every spelling of
  the phone itself (0.0.0.0, `[::]`, `127.1`, an IPv4-mapped 127.x), not only
  localhost, 127.x and ::1 (A3-AND-14).
- source-map-js 1.2.1 -> 1.2.2 (a dev dependency, GHSA-68fv-2mgg-jv7q).
- The fresh-install test's downloads have timeouts and retries.
- The integration tests' sshd with the Docker socket takes a password of
  the run's own, not the one in the repository.
- In the Android app, a file downloaded from the Files page is saved under its own name, not as "raw.bin". Every download Burrow sends now names the file twice: first as an ASCII `filename`, with quotes, backslashes, percent signs, control characters and non-ASCII characters replaced by `_`, then as the exact name in `filename*` (RFC 6266). The app reads `filename*` (RFC 5987) itself before falling back to Android's guess, everywhere it names a download (report 1fb877).
- A stack's Pull, Up, Restart and Down buttons all have the same width: two by two on a phone, four on one line where they fit. "Check now" beside the image updates' title and the output's "Hide the output" keep their labels on one line. On a phone and a tablet that toggle is full width, like the other actions (report 1d821b).
- Buttons side by side in a button row (`.btnrow`) share the line evenly on a phone and a tablet. Before, each was as wide as its label plus a share of the free space ("New snippet" beside "A command on several hosts", "Show all" beside "Sign out everywhere else"). A Proxmox guest's actions under the guest are two columns of one width, or one column when a label would not fit. In Dutch, the problem report's "Melding versturen" button is now "Versturen", because the longer label wrapped onto two lines in its half-width button at 343 px (report 1d821b).
- `make dev` no longer serves the checkout's `data/`, `backups/` and `secrets/` under Vite's `/@fs/` (report 4b9965).
- The terminal page keeps its bar (the way back, the session tabs, the menu) with the keyboard up on a foldable's inner screen and other low screens, compact; only a phone turned on its side with its keyboard up (below 300 px) still leaves it out (report ce0acd).
- A problem report from a terminal records what the phone's keyboard did (its 229 keys, input and composition events), not only the real keys, so `make replay` can play typing from a keyboard app again (report 117251).
- "Since start" works for a merged view of many containers: each source is read from its own last start (a container's start, a unit's last start, a host's boot) instead of the option being unavailable (report c8d284).
- An empty log view says why: every line hidden by the filters (with Show all), nothing in the time range, or every read failed; a range with more lines than the 5000 kept says how many of the oldest are left out (report c8d284).

### Verified

- The gate (with the tour's six passes, now also Dutch on an 820 px tablet
  and dark Dutch on a 1440 px computer, and its new checks for button rows,
  failed reads said on the page and the terminal's bar), the Android app on
  an emulator (phone, tablet and dark Dutch passes, the phone's own files
  through Android's folder picker, the WireGuard DNS test), the backup
  round trip on the Debian 13 image, the public export's three releases in
  one history, and a fresh install on a new Debian VM.
- Every fix's test failed on the code before it; each problem report and
  audit finding has its test named in docs/REGRESSIONS.md.

## [1.27.3] - 2026-10-11

### Changed

- The first download of the web app is smaller: the QR code writer loads
  only when an authenticator is set up (495 KB to 472 KB; the gate's
  ceiling follows, 520 KB).
- The Docker build context holds only what the images copy (a list of
  what may go in, instead of what may not): no .env file, secret, signing
  key, Android build or test output reaches the build.
- A release starts the arm64 image under qemu and waits until it is
  healthy, besides scanning it.

### Fixed

- A test worker's core dump (5 GB) had gone into the repository with
  1.27.1; it is out of the history, core dumps are ignored, and the gate's
  snapshot refuses new files over 20 MB.
- Two test fixtures held what the public export refuses: a path of the
  author's server and a private key's header written out whole.

### Verified

- The gate, the Android app on an emulator, the public export's check on
  the tree, and both images built with the new build context.

## [1.27.2] - 2026-10-11

### Changed

- The design notes, development guide and usage guide name what came
  lately (split terminals, sharing and recordings, Proxmox, the log
  filter from a question); the decision records have an index.

### Fixed

- Pages that show containers asked the server again with every update of
  them (every few seconds), and the bottom panel's log tab opened a new
  connection each time.

### Verified

- The gate and the Android app on an emulator; the e2e test of 450
  containers counts what the page asks the server (red before the fix).

## [1.27.1] - 2026-10-11

### Changed

- The README shows Burrow (a made-up homelab, made by a spec of its own
  that runs only when asked); the F-Droid listing has pictures of today's
  app and names its own WireGuard, notifications without Google services,
  split terminals and Proxmox.

### Fixed

- A disk that SMART reads but that gives no health status said only
  "unknown"; it now says why that happens (a USB enclosure or a RAID
  controller, mostly).
- An alert's last lines showed half of a fourth line under the three.

### Verified

- The gate (coverage floors raised: unit 59, shared 81, web 91; the tests
  check that every container they start carries burrow.ignore, after an
  integration stack raised live alerts) and the Android app on an
  emulator. The live Burrow looked at again as an operator: 21 pages at
  six sizes, every layout check green.

## [1.27.0] - 2026-10-10

### Changed

- A person can have at most 20 devices that get Burrow's push, and a push
  service that answers with a redirect is not followed.
- Burrow's own risk rules see `systemctl --now disable`, `docker --context
  x stop`, `apt-get -y remove` and the like through the options before the
  action (they read as low risk).

### Fixed

- The backup image's packages are fetched again each day (`PKG_DATE`): an
  old build cache kept a python3 with three fixed high-severity advisories.
  The gate scans the backup image too, and a release scans the images it
  pushes, both architectures.
- Seven entries of package-lock.json named version 1.0.0 for tarballs of
  0.x; the gate checks every entry against its tarball now.
- Progress bars (reports, transfers, the app update) say what they show
  to a screen reader.
- The Android app no longer closes when a download or upload ends right
  after it began (the transfer notification's service was stopped before
  it was in the foreground); the same for the direct route's keep-alive.
- The Proxmox guests' names and states, and the editor's "no running
  containers" for nginx -t, sat against the edge of their list.

### Verified

- The gate, with new checks: step-up asked by a list of its own (not by
  the routes' settings), rows and their values kept through every
  migration, the backup image scanned, the lock's versions against their
  tarballs, an AI command on the line seen not run on the host until
  Enter, and text kept off the border of its box on every screen of the
  tour. The Android app on an emulator.

## [1.26.0] - 2026-10-10

### Added

- The Android app: an app behind Basic or Digest sign-in asks for it in
  its tab; an exported log is saved in Downloads/Burrow.
- Tab lists and groups of choices answer the arrow keys, Home and End, and
  are one Tab stop.
- A terminal session can be shared with Burrow users to watch it,
  read-only, and recorded on request (kept 30 days, played back under
  Settings -> Recordings, downloadable as asciicast).
- Proxmox VE: a node's virtual machines and containers on its page, to
  start, shut down, stop and reboot, and to add as hosts with their address
  filled in; over SSH with qm and pct, no API token.
- Logs take a question in words when a model is set up: it becomes the
  log's own filters, set on the controls, with Undo. Only the question and
  the source names go to the model.
- The Android app reads a WireGuard QR code with the camera; a picture of
  the code can now also come from the gallery.
- Translations are flat JSON files, one per language, ready for Weblate;
  CONTRIBUTING.md says how to translate.

### Changed

- The Android app: when the proxy in front of Burrow answers but Burrow
  does not (starting, updating), the app shows Retry and the direct route
  instead of the proxy's error page; app tabs say so when the phone's
  WebView cannot keep their sign-ins apart.
- A report sent to a channel has its summary in that channel's language.
- An alert finds the one to add to by an index: a busy log no longer reads
  every stored alert for each matching line (2.8 ms to 0.006 ms at 50,000).

### Fixed

- The number of updates no longer counts an image whose container was
  removed: the check after a restart drops it, not only the full check.
- A command typed on a busy host is still learnt for completion when its
  echo comes late (looked for again within three seconds).
- The Android app: the first prompt of a direct session is no longer
  lost; a second tap on Update the app waits for the first; a file another
  app does not let Burrow read is left out and said, not a crash; the
  network is watched also when the first WireGuard configuration comes
  after the app opened; copies left from sharing are cleaned up; a
  download notification from before the app was closed no longer does
  nothing.
- The app's WireGuard tunnel bounds connections that have not signed in.
- After signing in as someone else, answers to the previous account's
  requests are dropped instead of shown; a read that gets no answer or an
  unreadable one says so instead of showing nothing; a read that hangs
  stops after two minutes.
- Uploads and downloads of a previous account stop at sign-out; a failed
  slice of an upload is reported instead of hanging.
- A bulk action reports the containers whose state could not be read
  afterwards instead of counting them as done; release notes that could not
  be read say so.
- Push on this device is checked against the server when the page opens.
- Sessions and activity show the newest answer when several overlap.
- Leaving a page through a redirect no longer leaves an extra step in
  Back; Back closes a dialog opened by a swipe as well; pull to refresh
  that fails says so.
- Alerts follow a container again after it is made anew under the same
  name.

### Verified

- The gate (unit, integration against the test sshd with stand-ins for qm
  and pct, end to end on four browsers and the tour) and the Android app on
  an emulator.

## [1.25.0] - 2026-10-10

### Added

- Settings -> Users: an account can be unlinked from the sign-in provider
  (after a change of provider); its next sign-in through the provider links
  it again by the claim Single sign-on names.
- Git in a workspace: a staged change is shown against the last commit, an
  unstaged one against what is staged, each as git will write it; a
  repository in one of the workspace's other folders commits as the
  identity set once for the workspace.
- Closing a terminal session whose host cannot be reached asks whether to
  forget it in Burrow (its tmux on the host may still run).
- A form in a window (a channel, the git identity, a file's new name or
  properties) asks before it closes with changes not saved, and a pasted
  WireGuard configuration before another page opens.
- Burrow failing to say who is signed in at the start (Burrow restarting
  behind its proxy) says so with Try again.

### Changed

- A log file's times without a zone are read in the zone of where the file
  is (the host, or inside its container), and times finer than a
  millisecond keep their order.
- A container's log file under a mount that this user cannot read on the
  host (a Docker volume) is read, and suggested, inside the container.
- The terminal keeps what it shows when the text gets larger or smaller,
  sends what was typed in order (an Enter a moment after its text never
  overtakes what came next), and a size change no longer redraws earlier
  output at the new size.
- Completion: only names that start exactly with what is typed (a file
  that differs in case is never changed into another), and a name typed in
  an open quote goes on in that quote.
- Picking a word with a finger counts wide characters (CJK, emoji) and
  accents as the terminal draws them.
- AI analysis: the text sent stays within its budget, names and times
  included, and grouping many different lines takes about a second instead
  of minutes; a stream that ends early or with an error is a failed answer,
  not a short one.
- The app's direct route: a port forward opens with the scheme chosen when
  it was started (https on 8443, http on 443).
- Touch screens: small buttons (help tips, a tab's close mark, the panel's
  tabs, the file tree's rows) are easier to hit.
- Charts say their numbers to a screen reader.

### Fixed

- Signing in with an authenticator app, turning one on and confirming
  with a code: the six-digit field refused every code (its pattern was
  read as `\d6`), so the form never went out.
- Searching and replacing in a workspace: a regular expression runs in
  linear time and a replacement that would grow too large is refused; the
  search says when it stopped at ripgrep's per-file limit.
- Text that is not UTF-8 is refused instead of saved mangled; a save or an
  upload that cannot keep a file's owner, group and mode is refused with a
  pointer to sudo; sudo saves stage privately and replace the file in one
  step.
- Copying between hosts: both ends owned together, a stall bound, an
  unknown exit refused, progress adding up over folders; a dead SFTP
  channel no longer stays in the pool.
- Logs: a source that fails or a lost connection is said, not a quiet end;
  a viewer too slow to keep up is let go and the page connects again.
- Language servers: the editor's settings cannot reach them, their
  messages are bounded, and an old one never stops its replacement.
- Alerts and reports: a log file with a long path (or many accented
  letters) can be muted, picked for a report and given a rule.
- Release notes: a sub-heading under "Breaking changes" stays breaking.
- A log line's date that does not exist (February 30, minute 60) is no
  longer read as another date.
- An app's address is checked as a browser would read it (port, IPv6,
  percent escapes).
- Retagging an image in a compose file changes only the service's own
  image line, not an environment value or a script that looks the same.
- Self-update: "started" only once the update runs on the host; a folder
  that is gone fails at once.
- Stack operations started at the same moment (two host entries for one
  machine) run one at a time.
- Host statistics: Reset clears the limits' fields.
- The app's WireGuard tunnel reaches IPv6 addresses; app tabs keep their
  own sign-in per server, so app 1 of another server opens as itself.
- The ignore label (`BURROW_IGNORE_LABEL`) reaches the container from
  `.env`.

### Security

- Docs say what the AI masking catches and what goes out, which actions
  need a fresh confirmation, what unpairing a lost phone does on hosts that
  cannot be reached, that rollbacks restore images and not migrated data,
  and that the Android app trusts only certificates Android ships.
- CI publishes only a release tag that is the version the packages and the
  changelog say; `latest` only for the newest stable release.

### Verified

- The gate and the Android app on an emulator.

## [1.24.0] - 2026-10-09

### Added

- A pane of a split terminal alone over the whole area and back: a button
  in its head, or a double click on it; the others stay connected
  (report 42f337).
- Each section's button in the rail or the bottom bar goes back to where
  you were in it (Files: that host and folder); pressed again while there,
  to its start (report d6ea6c).
- Apps: a tile says when it opens in a tab of its own, and why; a help tip
  says how to let an app be shown inside Burrow (frame-ancestors with
  Burrow's address); an app can be set to always open in a tab of its own
  (report c2fde7).

### Changed

- With a split on, the split button is the panes' layout: one to four
  panes, filled with the sessions already open; a new session only when
  asked for by name (report 1d2fd4).

### Fixed

- A help tip is drawn over everything: beside the terminal's badge it fell
  under the rail (report 6779f4).
- During an update, a container's output is on a line of its own under its
  state, as wide as the page; once done, one line with its output a tap away
  in a wide window, so the logs keep their room (report 09ddbf).
- Closing the step-up window on purpose no longer shows "step up required"
  (report 1d2fd4).

### Verified

- The gate and the Android app on an emulator. New checks on every screen:
  every help tip opened on a computer too and nothing over it, and no tall
  block beside small ones in a centred row.
- The image scan lets two new Go advisories in shfmt through until
  2026-11-09: they are in Go's network code, and shfmt, a formatter, opens
  no connection (.trivyignore.yaml says so per advisory).

## [1.23.0] - 2026-10-09

### Added

- Containers keep their CPU and memory: every five minutes, a month back,
  on every host with Docker. A container's page shows them over a day, a
  week or a month; the list has a memory line beside the CPU line, and
  both start with the last hour instead of empty at every visit (report
  428102).
- Motion: dialogs fade and rise in and out (a phone's sheet from the
  bottom), pages and toasts arrive softly, the line under the section tabs
  slides to the tab chosen, folded parts open by their height, buttons give
  a little when pressed, and a list that is on its way shows its shape
  instead of "Loading...". All of it off when the system asks for less
  motion.

### Fixed

- On a very wide screen the containers' search row is as wide as the two
  columns of stacks under it, and a search box is as tall as the filter
  beside it (report 5fee2b).
- "What is new" over several updates says of how many when some have no
  release notes ("17 of 18 updates", report 2fe705).
- The column beside an open part of the settings is a card of the same rows
  as the settings' own list: icon, name and what is in it, the open one
  marked (report ab8f2a).

### Verified

- The gate and the Android app on an emulator. New checks on every screen:
  fields side by side are one height, a page's parts are as wide as each
  other. Motion: every transition uses the motion tokens (a unit test), and
  workspace-motion.spec.ts sees a dialog animate and the tab line slide,
  and nothing move with less motion asked for.

## [1.22.0] - 2026-10-09

### Fixed

- The Android app (AUDIT2 AND-01 to AND-07): pairing again makes the new
  key beside the old one, which stays until the pairing went through (a
  wrong code no longer signs the phone out); files shared to the app are
  dropped when the server changes and read only once Burrow is unlocked;
  the app's own downloads follow a redirect only on the same server (the
  session cookie went along); an app tab does not follow a redirect to the
  phone's own loopback; a host key trusted on the phone counts only while
  Burrow knows none of that host; the lock stays on when the phone has a
  screen lock but the fingerprint check fails for another reason; a late
  sync of the direct route's cache no longer comes back after a sign-out.
- Phone keys on hosts (MON-01 to MON-05): deleting a host, or pointing it
  at another account, takes the phones' keys off the old account first
  (and puts them on the new one), and says which phones keep a key where
  that failed; changes to one account's authorized_keys go one at a time;
  a new phone key goes on only once the old line is off; a host that
  missed a new key gets it the next time the phone reports it; a vault
  key is kept for a host only once sshd accepted it.
- Monitoring (MON-06 to MON-18, MON-24, MON-27): a problem report's push
  goes to admins only; the stats page no longer hides a CPU busy for five
  minutes; missing load, memory or df figures are no reading instead of
  zeros; guest CPU time counts once; a SMART scan that failed, and disks
  smartctl could not open, are said (also beside the disks it could read);
  a failed or foreign answer no longer replaces a host's facts; alerts of
  another kind are not bundled together, and a report counts only what
  happened in its own period; an alert still happening after its mute
  ended, or whose push failed, is told; very long log lines no longer grow
  the server's memory; apps answering 500 are down (not "Burrow cannot see
  out"), and a late check of an app's old address is dropped.

- Accounts and sign-in (AUTH-04 to AUTH-09): deleting an admin can no
  longer leave no admin while its keys come off a host; the same
  single-sign-on subject at two providers is two people; single sign-on
  switched off or linked to an earlier provider no longer counts as a way
  in, and switching the provider is refused when an admin would have none
  left; a sign-in begun before single sign-on was switched off or changed
  does not finish; Burrow updating itself and the automatic updates'
  settings ask for a fresh sign-in (the file browser and the terminal
  deliberately do not; docs/DESIGN.md says why).
- Files and the workspace (FS-06, FS-07, FS-17, FS-21 to FS-24, FS-28,
  FS-29): unstaging a rename takes both names back; a file named like a
  pattern is only that file; a folder that cannot be read, or git failing,
  is said instead of an empty list or no old version; hadolint failing is
  said, not "no findings"; the shell integration keeps a PROMPT_COMMAND
  ending in ";" (or an array) working and passes a leading space through,
  so such a command stays out of the history; the home is protected
  however its path is written; a branch with a dot shows whole; importing
  a shell history twice counts once.
- Containers (DO-09 to DO-11, DO-22): an image docker could not inspect is
  unknown, not one built here; a half-printed inspect no longer counts
  containers twice; when what uses images and volumes cannot be read,
  nothing is offered for clean-up; an empty list of services is refused.
- More monitoring (MON-19 to MON-22, MON-25, MON-26): a report runs once in
  the night the clock goes back; "*/2" in a cron day field does not
  restrict the day, as in classic cron; a report switched off while it
  waited is not made; a stale-backup warning is told until a channel took
  it; removing the shell integration says removed only when it is gone;
  testing a channel that is gone is an error.
- The terminal and the editor (TERM-06 to TERM-08, TERM-11 to TERM-13,
  TERM-18 to TERM-20): the text box keeps its text when the terminal is not
  connected; emoji are never split by a correction or a completion; a
  completion spec that failed to load is tried again; diagnostics move with
  edits; the editor hears when its language server goes; a new editor
  speaks the language set now; hyperlinks and titles in log lines no longer
  show as text; snippets of the groups above a host are offered in the
  terminal too.
- What goes to a model (AI-06, AI-08, AI-14, AI-16): options before or
  between the words no longer hide a destructive command from Burrow's
  risk rules; a problem report with an emoji where it was cut makes its
  GitHub link, within the length GitHub takes; the alternate screen stays
  out of a session without tmux also in a combined mode list.
- The panel under a workspace or a stack offers the sessions already
  running on that host (on opening, and on +) before it starts a new one;
  it started one each time, and asked for a step-up to do so (report
  eca78a).
- Layout on every screen (UI round): the busy pill keeps to the narrow
  rail beside a terminal or editor (a round mark there), goes away a few
  seconds after a report is made, and leaves room at a phone page's end;
  buttons in a row under what they act on fill the line together on a
  phone (the stack's Pull, Up, Restart and Down; a problem report's
  actions; the devices list) and keep their own width on a computer; the
  title bar and tabs reach the screen's edges on a tablet; the workspace
  and editor bars are dark on a phone like the other pages; the log's
  search no longer sits on the log; the logs page has the same edges as a
  container's page; a terminal's empty suggestion row is part of the
  terminal, not a white band; alert rules are shown whole; a report's
  long command fades at the edge where it scrolls on; commands break at
  their spaces; a host's tags go under its
  address on a phone; the host statistics' cards are evenly spaced.

### Security

- An operator reads only the log files an admin set up as sources
  (AUTH-10): any file inside a container could be tailed as the
  container's user, /proc/1/environ too.
- The Android app's pairing, redirects and loopback (AND-01 to AND-03, see
  above).

### Verified

- The gate and the Android app on an emulator. Tests were made stricter
  where they could pass on the wrong thing (TEST-01, 02, 04, 05, 07, 11,
  12, 15 to 23): pages filled in by name and checked to be the page asked
  for, the phone tests on a host of their own, a push opened with the
  device's keys and its VAPID signature checked, what a model was sent
  searched for the secret, the report's picture checked by its pixels.
- Five new layout checks on every screen of the tour and every size:
  boxes that touch or overlap, blocks of one column that are not equally
  wide (and full-width buttons beside narrow ones on a phone), cards in a
  column unevenly spaced, a title bar short of the screen's edges, and a
  floating button whose words do not fit on one line.

## [1.21.0] - 2026-10-09

### Added

- Split terminals on a wide screen: up to four side by side (two on a
  medium screen, one on a phone), each its own session; the panes, the
  dividers (dragged or moved with the arrow keys) and the tabs' order
  (dragged) are kept on the device. Typing into all panes shown is a
  switch of its own, with a red bar and Stop all the time it is on.

### Fixed

- Stack updates (AUDIT2 DO-01 to DO-07, DO-12, DO-13): a rollback counts
  only when the old images run well for as long as an update is watched;
  a failed update puts back every service it took down, not only those on
  another image; chosen services are updated without recreating their
  dependencies; two services that ran different images under one tag are
  each put back on their own; an update Burrow was in the middle of when
  it restarted is watched and, when not well, rolled back afterwards; an
  error while it runs is written in the history; the version read is the
  running one; only the release that was checked is deployed (a tag moved
  since stops it); a deploy from a review stops when the compose files
  changed since; a configuration or container list cut off at the read
  limit is no review and no list.
- Burrow updating itself (DO-14 to DO-16): it compares with the image the
  compose file names now, keeps the old image under a valid name (also
  when started by digest), never pulls on the way back, and runs one
  update at a time on the host.
- Backups (OPS-07 to OPS-10, PAGE-04): a restore run again after an
  interruption keeps the files from before; a restore is called done only
  when Burrow is healthy on it; rounds at the same moment no longer share
  names or files; an archive appears under its name only when whole;
  *Back up now* no longer calls the previous round the new one.
- Sign-in (AUTH-01 to AUTH-03, WEB-01): a change is judged by the session
  as it is once its body arrived; a pairing code of a deleted account no
  longer signs in a new account with its number; a demoted user's direct
  route is revoked at once, also where its key could not come off yet
  (taken off when the host answers); another account at the same page
  sees nothing of the last one (report, copied files, transfers).
- What goes to a model (AI-01 to AI-04): whole quoted secrets, short
  ones, escaped JSON keys, a Digest header's parameters, every cookie and
  every line of a multi-line private key are masked, and so is everything
  said around the log lines (a host named by its address, a path, the
  command assistant's question); commands with a JSON password or
  `curl -uuser:pw` are not kept in the history.

### Security

- The Android app's WireGuard part is built with Go 1.27.2 and
  golang.org/x/net 0.60.0 (HTTP/2 fixes found since the last release).

### Verified

- The gate and the Android app on an emulator.
- Each fix has a test that failed on the old code first (docs/REGRESSIONS.md).

## [1.20.1] - 2026-10-09

### Fixed

- The text box's Send held with several lines no longer runs them, and a
  snippet's *Paste only* with several lines goes to the text box: inside a
  tmux the lines ran even where the terminal marked them as a paste
  (AUDIT2 TERM-02). One line pasted from a phone keyboard's clipboard with
  its line break is a paste, not a typed Enter (TERM-03).
- A problem report without typed text keeps no key codes of letters,
  digits or emoji either (TERM-01).
- Saving refuses, before anything changes, text over 5 MB in bytes or with
  a NUL in it (it was written and then no longer opened); two saves of one
  file under two spellings (a linked folder) are one at a time; a sudo read
  of a link to a large file is refused instead of opened cut off (FS-08,
  FS-02, FS-03).
- Copy, move and archive never replace something that appeared at their
  destination after the check (FS-01).
- A folder's owner for everything inside no longer gives every file the
  folder's permissions: permissions and owner each have their own "for
  everything inside" (UI-01).
- A terminal's starting folder with a control character in its name is
  refused (it was typed into the shell) (FS-04).
- A restore refuses a backup without Burrow's own database (none, empty,
  another program's, or one from a newer Burrow) before anything is
  staged; reset deletes exactly what Burrow's container has at /data and
  says which (OPS-02, OPS-03).

### Verified

- The gate and the Android app on an emulator.
- Each fix has a test that failed on the old code first (docs/REGRESSIONS.md).

## [1.20.0] - 2026-10-08

### Added

- What is new in several images at once: from the updates menu (every
  update), a stack's updates and a selection on Containers, one overview
  with what to read first and what is worth knowing over all of them, each
  under its image's name, then every image's versions folded (reports
  26c0fa, bd2d76).
- Reports and AI analyses can be deleted (an analysis not while it runs);
  a report made with AI says the tokens it used and, with prices set, about
  what that cost, as an analysis does (report aafaba, 18efc8 class).
- The Markdown preview sits beside the editor on a wide pane, with the
  file's own pictures; reading dialogs (release notes, diffs, inspect,
  analyses, problem reports) are wide on a computer (report ac7481).
- Wide screens: Hosts, Containers, Alerts and Reports use two columns from
  1700 px.
- Select mode on Containers picks one stack at a time (All/None per stack);
  all stacks fold or unfold at once (reports 335a38, 44c246).
- The panel's + held or right-clicked asks how to start the terminal: as
  set, with tmux or without (report 776450).
- A container's page says the version it runs (from the image's label)
  (report eaa986).
- Suggestions from history only after a command was used a few times
  (Settings, 2 by default); commands used once are forgotten after 30 days
  (report 94c9eb).
- Git in a workspace finds repositories below its folders, and the open
  file picks its own (report 91e73c).
- All/None beside the long lists of the panel's log choice, the system
  logs and the ssh config import.

### Fixed

- The accent colour tints the ground, borders, rail and dim text too; they
  stayed green whatever accent was chosen (report 5d820e).
- Rows that scroll sideways (log sources, tabs, key bar, crumbs) show that
  more is out of sight; more than ten log sources fold behind a button;
  *Automatic* no longer touches *Choose* in the panel (report eeff05).
- The bulk update follows each stack's update to its end with its output
  as progress, and only then says done or failed; its button waits visibly
  for the list (reports c28922, c2bff2). Its question lists each image's
  breaking notes under the image's own name (report 06354e).
- Containers no longer keep "update" after their update until checked by
  hand (report 25f8d5).
- A log file that links to the container's own output (nginx's error.log
  to /dev/stderr) is said so, not "could not be read", in reports, the log
  view and the suggestions (report 71d6c5).
- A log line's level stays at its first row when the line wraps; " | "
  separators keep their spaces (reports 97e99b, 0b970e).
- Live UI round on a real instance: long names in log lines break after
  dots and slashes, not between two letters; a journal line no longer
  repeats its unit; an app's own time and level after Burrow's is dimmed;
  a disk behind a USB bridge says why SMART cannot read it instead of 0 C;
  containers on a Raspberry Pi show "-" instead of 0 KB memory; an
  operator is no longer offered what the server refuses, sees alert limits
  as text and can read images and volumes; Hosts drops "Recent" when the
  list is short; a stack of many services shows the first few (those that
  need a look always) with a filter, and the latest three updates.
- The panel's terminal on a phone with the keyboard up takes the screen
  while typing (it kept three rows above the tab bar).
- The browser's theme colour and the app's status bar follow the accent
  again: they got a colour mix the app ignores once the greys followed
  the accent; now the colour as computed, in hex.
- A session's viewers read "Chrome on Android", apart from the " | "
  between a session's parts; on Containers the search keeps room for its
  word beside the filter in select mode on a small phone.

### Verified

- The gate and the Android app on an emulator.
- Every fix above has a test that failed on the old code first, listed in
  docs/REGRESSIONS.md; the layout checks now also look at rows that scroll
  sideways, separators, level badges, accent tints and the use of wide
  screens.
- The live-round items were found by a look-only round over the live
  instance (1.19.0) as an operator: phone, foldable, laptop, ultrawide,
  Dutch at 343 px and dark, with the tour's layout checks.

## [1.19.0] - 2026-10-08

### Added

- System logs: a host's systemd services (failed first, searchable), their
  journals read like container logs, one or several in one timeline; a
  watched service's journal goes through the alert rules and the reports. A
  user outside the journal's group, a host without systemd or an unknown
  unit is said so, never shown as an empty log.
- Copies and moves between hosts are checked afterwards: every file's
  sha256 on both hosts; the transfer says how many matched, a file that
  differs fails it and a move keeps its source. A host without a sha256 tool
  is said ("not checked").
- SMART: each disk is judged by Backblaze's five failure counts (5, 187,
  188, 197, 198) against its oldest check kept (one a day, 90 days): good,
  watch it, or failing with what it was and when; NVMe wear and critical
  warnings too. Growing uncorrectable or unreadable counts and a critical
  warning raise an alert.

### Fixed

- Pictures in an image's release notes show: fetched from GitHub's own
  hosts through Burrow (the browser never asks GitHub), raster images up to
  5 MB; a picture with GitHub's size hint no longer shows as text, and
  pictures elsewhere stay links (report 64498b).
- Apps in an own order: the groups follow it too (they stayed
  alphabetical, so dragging in Manage changed nothing on the tiles), and
  *Change the order* in the order list opens Manage.
- A journal can be analysed like other logs, and a watched journal or log
  file of a host without Docker (or with a daemon that does not answer)
  goes through the alert rules and the reports (AUDIT2 J-01, J-02).
- Journals: whether they can be read is tried for real (a narrow sudo for
  journalctl only works); a removed unit's entries are still read; units
  with systemd's escapes in their name work; a watched unit that systemd no
  longer lists stays on the page to unwatch (AUDIT2 J-03 to J-06).
- SMART: each count is compared with the oldest check that has it; a disk
  judged failing (also worn out after crossing the wear limit before)
  raises an alert, compared with the last check that read the disks; checks
  of one host run one after another; older kept reports are judged by
  today's rules; old checks go after 90 days also when SMART cannot be read;
  *Check now* updates the count of kept checks; the new alert titles are in
  Dutch too; without a stored password each smartctl runs through
  `sudo -n smartctl`, so the sudoers line in the help is enough (AUDIT2
  SMART-01 to SMART-08).
- Copies between hosts: a list of files that could not be made, cut off or
  unreadable sums fail the check instead of passing it on part of the files;
  a move keeps its source when the source changed after the check; a copy
  not checked is said on the pill too, and a mismatch in the page's language
  (AUDIT2 FS-11, FS-05, WEB-16).

### Verified

- The gate and the Android app on an emulator.
- System logs: unit tests for the journal source (names, only the host's,
  the label) and for journalctl's command run through sh with stand-ins (no
  journalctl, an unknown unit, a user outside the journal's group, and one
  inside); e2e on the test sshd's stand-in units: failed first, search, two
  journals in one timeline (the host name dropped, new lines followed, the
  error level seen), watched and unwatched (kept after a reload), a
  container's journal refused; the tour with a host without systemd.
- Copy check: unit tests for sha256sum's lines and the mismatch list; the
  integration test copies a folder and moves a file between hosts with
  every file counted as checked; e2e shows the checked count.
- SMART verdicts: unit tests for each verdict and the same disk found by
  its serial; the integration test runs a stand-in smartctl twice (8, then
  12 reallocated sectors): watch, then failing with the 8 and its time, and
  one check kept for the day; the tour shows good, watch and failing disks.
- Changelog pictures: unit tests for the allowed hosts, redirects, types,
  size and cache; the markdown tests for title, size hint and `<img>`; e2e
  shows a mocked GitHub picture in an image's notes.
- Apps own order: e2e drags in Manage and sees the groups follow on the
  tiles; the tour checks the order list on a Dutch phone.
- AUDIT2 fixes: e2e analyses a journal; the integration test raises an
  alert and writes a report from a watched journal on a host without Docker,
  and makes a disk go from watch to failing through a stand-in smartctl
  behind `sudo -n`; unit tests for the permission probe, a removed unit,
  escaped names, each count's own baseline, the failing transition, the
  Dutch titles, strict checksum lines, a cut-off list and a source changed
  before a move.

## [1.18.0] - 2026-10-07

### Added

- A panel with *Terminal and logs* under a workspace and on a stack's
  page: a shell on the host in that folder (several, kept running when you
  leave) and the logs of the containers that belong there, chosen by
  themselves or picked; resizable, and kept as left on this device. A
  terminal, the files and the logs no longer need three tabs. The
  workspace's terminal button opens it (it opened a new terminal page).

### Changed

- Volume up in the app: a line above the key bar says what the next key
  does (W A S D arrows, E Esc, T Tab, 1-9 F1-F9, P/N page); the key bar said
  only "Vol+".
- The gate goes on from where it was with `make gate RESUME=1`: steps
  whose inputs did not change are reused, and e2e runs again only the specs
  that failed or changed.

### Fixed

- The backup test built its image under the live tag `burrow-backup:local`,
  which took the tag from the running backup service's image; it builds
  `burrow-backup:e2e` now, and the gate refuses a test script that names a
  live tag.

### Verified

- The gate and the Android app on an emulator.
- The panel in e2e on a computer and a phone: a terminal starts in the
  workspace's or the stack's folder, a second one, switching and closing
  (the question asked, the session gone on the server), the logs of the
  stack picked by themselves, unticked and back to automatic, the filter in
  the choice, the height with the arrow keys, all kept after a reload, both
  on their own page, and on a stack's page above the tab bar with the key
  bar shown.
- The terminal page after moving its session into TermSession: the
  terminal and phone specs unchanged and green.
- The Vol+ line shown and gone again in the mobile spec.

## [1.17.0] - 2026-10-07

### Added

- Settings -> Backups: *Back up now* asks the backup service for a round
  (it starts within seconds; the page says when it is done, or that the
  service did not take the request), and *Download the newest* saves the
  newest encrypted archive (report 445f22). compose.yaml mounts the backups
  folder into Burrow read-only for this.
- Snippets: *Typed often* offers commands typed at least three times in the
  terminals as snippets, saved with one press or not suggested again
  (report 8f829d).
- Containers: a stack folds away by its arrow, kept on this device; folded
  it still says how many need a look, and a search opens every stack
  (report df6153).
- A container's *Update now* asks in a dialog with *What is new?* (the
  release notes in between), or says that the image does not tell where its
  notes are (report ac3a68).
- A host's charts: a finger on one (or the mouse over it) shows that moment's
  time and value, in all four charts at once (report 4af4ec).
- Files: with some chosen, *All* chooses every file shown and the X none;
  the bar has two rows, what is chosen above what to do with it (report
  fc208f).
- Cleaning up images, volumes and networks: *All* and *None* per kind
  (report 8f41d4).
- A workspace's tree: a right click (or a long press) opens the file's menu
  from Files (edit in a tab here, rename, copy, delete, ...) (report 80a8ce).

### Changed

- The theme in Settings -> Appearance is a dropdown, like the language: four
  choices side by side broke over three rows on a 343 px phone, the last one
  under the colours (report 36aa3d).
- A host's images, volumes and networks: which kind is shown is a
  dropdown (report 8f41d4).
- Settings on a wide screen: the parts in a column at the left, the open one
  beside it; Snippets, Sessions and Keys use the page's full width (report
  117b14).
- The update pill on a container's page sits beside its state, short and on
  one line: it broke over two lines under the log sources (report 335855).
- The gate stops after a cheap step fails, retries a failed e2e test once
  (a pass on the retry is a note, not a failure), shows the time of each
  step and leaves no containers, volumes or images behind (a new step,
  leftovers); e2e runs what only looks side by side, each browser with a
  passkey of its own. `make check` runs the cheap steps.
- The tests' narrowest phone is now 343 px (a OnePlus Open's outer screen),
  also for the Dutch tour, and a segmented choice that hangs below its box
  fails the layout checks.

### Fixed

- App tiles are all as high as each other: a name over two lines made its
  row taller (report 00ec50).
- App icons are fetched again once a day (and soon after a start): a tile
  kept the logo from when the app was added, Burrow's own the one before
  1.9.2 (report 5866c2).
- In the editor the fold arrow of a line that wraps sits on its first row,
  beside its number, not between its rows (report 19c129).
- On a computer the row for the terminal's suggestions stays, empty or not:
  the terminal no longer jumps up and down while typing; the labels above
  the terminal ("lost on restart") stay on one line (report 854cb3).
- The editor's line numbers take no more room than they need: the column
  for problems is there only while there are problems (report f15675).
- In a problem report's picture the rail runs down the whole page (report
  117b14).
- A problem report from a very long page was refused with its picture: the
  picture is now drawn smaller, as a JPEG when needed, to fit (report
  8f41d4).

### Verified

- The gate and the Android app on an emulator.
- Each new test failed first where the old code allowed it (the fold arrow,
  the tile heights, a report from a very long page, the terminal's height
  with suggestions coming and going) and passes now; the others test
  controls that did not exist before.
- A backup made on request by the backup service's loop, and the request
  taken away (scripts/test-backup.sh).

## [1.16.0] - 2026-10-07

### Added

- Markdown in the editor: coloured, and a preview in the editor's menu
  (headings, lists, tables, code); the text is escaped, nothing in the file
  runs and no picture is loaded (report 8fa899). Markdown shown elsewhere
  (analyses, release notes) has tables too.
- What the AI used: the tokens of each analysis as the provider counted
  them, and with prices per million tokens set in Settings -> AI an
  estimated cost beside it; Settings -> AI shows the use of this month and
  the last 30 days, per kind (report 18efc8).

### Verified

- The gate and the Android app on an emulator.
- The preview and the token count with a stand-in model in the e2e run.

## [1.15.0] - 2026-10-07

### Changed

- The terminal's text box is one line of the chosen font high (at least
  28 px), not 36 px at least: with a small font it looked empty (report
  03f3f5). The key bar below it is 28 px high too, its keys only as wide
  as their labels.
- With the keyboard up, the terminal shows its bottom: an assistant's input
  line and the box edge and status lines under it stay in sight (they fell
  off when the view followed the cursor, report c7f699). A cursor higher up
  is still followed.
- A restore decrypts and checks the backup while Burrow still runs, stops
  Burrow and the backup service only for the swap, and keeps the database
  and key it replaced in the data volume (`.before-restore/`).
- Alerts about a log file can be muted; muting a container also mutes its
  own log files.
- The install and deploy guides: the backup folder and key owned by the
  backup service's user, a first backup checked before calling it done,
  what to keep to recover (`BURROW_SECRET` above all), Caddy on a LAN with
  its own certificate authority on the LAN address only, and the trial set
  up with `COMPOSE_FILE` so later commands keep its port.

### Fixed

- A swipe in a tmux with the mouse on scrolls also when it ends over
  tmux's status line: the wheel now turns where the swipe began.
- Opening a report schedule to edit it no longer switches it on, moves it
  from UTC to the browser's zone, or widens a host's containers to every
  host; none of the channels is refused instead of meaning all of them.
- A maintenance window saved in UTC stays in UTC.
- Saving a group or All hosts keeps defaults the form does not show
  (terminal type, encoding), and the form is filled from fresh data.
- Single sign-on and AI settings changed while a save is on its way stay
  changed and unsaved.
- Two WireGuard hosts ticked quickly in the app both go through the tunnel.
- A cron day range ending on Sunday as 7 (`1-7`) and the step `*/7` work.
- A restore with a backup whose name has spaces or shell signs works and
  runs nothing.
- The Android build's Gradle wrapper has the checksum of the Gradle it
  fetches (the gate checks both agree); the signed release job installs
  the packages it needs; `scripts/node.sh` makes its npm cache its user's.

### Verified

- The gate and the Android app on an emulator.
- Each fix with a test that failed on the code before it; the restore
  round trip (staged, swapped, the files from before kept, a name with
  shell signs) in the gate's backup step.

## [1.14.0] - 2026-10-07

### Changed

- Terminal tabs stay connected: switching between them (or leaving the
  terminal for another page) no longer connects again and redraws; the
  screen, and what came while it was out of sight, shows at once. The four
  sessions seen last are kept, each for 30 minutes unseen.
- A page that cannot load says why and offers "Try again", instead of
  "Loading..." for ever or an empty list (workspaces, hosts, a host or
  group being edited, apps, app discovery, a framed app, reports, AI
  analyses, alerts, the backup status); a container that is gone says so.
- Live logs say when their connection dropped and connect again by
  themselves (at once when the page is back in sight or online), without
  showing a line twice.
- Stack operations: Burrow follows an operation's output again after a
  dropped connection, and a second operation on a stack is refused on the
  host itself while one from before (even before a restart) still runs.
- Uploads go on after Burrow restarted; a report whose time came while
  Burrow stopped is made after the restart; an AI analysis interrupted by a
  restart is marked failed with why.
- Report schedules find their next run fast, also a yearly one (it took
  over a second and gave up after five weeks).

### Fixed

- Typing right after a flick in a tmux session no longer keeps scrolling,
  and the typed text no longer lands in tmux's copy mode.
- Pooled SSH connections: a replaced connection is no longer thrown out by
  the old one's timer, and a change of user, key, password or trusted host
  key (also through a group or the defaults) makes a new connection.
- The session limit holds when several terminals are opened at once.
- Completion answers are kept per session: one host's names are never
  offered on another.
- A copy job Burrow no longer knows (after a restart) ends as failed with
  why, instead of being asked about for ever; an upload of a file that got
  shorter meanwhile fails instead of sending empty pieces for ever.
- A language server connection is closed when its editor closes while it
  connects.
- Shared files go to the folder of the host chosen last, also when the
  host before answered late.
- Remembered workspace tabs are no longer wiped while the workspace loads.
- An address with a broken escape shows "does not lead anywhere" instead of
  a blank app.
- A rule or schedule switch, a delete, or a sign-out that fails says so,
  and the switch goes back.
- A late answer no longer shows under a newer search, folder, chart range
  or command.
- The Android app closes a direct connection or forward that arrives after
  its screen was left, and a fingerprint question ends with the screen.

### Verified

- The gate and the Android app on an emulator.
- Each fix with a test that failed on the code before it (the terminal
  tabs, the flick, the pool, the session limit, the schedules, completion,
  uploads, the language server, live logs, shared files, workspace tabs,
  broken addresses, refused actions, late answers, interrupted work).

## [1.13.0] - 2026-10-07

### Added

- Images, volumes and networks per host (host menu -> Images and volumes):
  what uses each, and a clean-up that lists what nothing uses before it
  removes anything; volumes only when ticked, never Burrow's own stack.
- In the Android app, the Apps page shows which apps are open as tabs: a
  row "Open now" at the top, and an edge on their tiles (needs the app
  update).
- Automatic updates only up to a step you choose: every version, minor
  versions and fixes, or fixes only (Settings -> Container updates); a
  bigger step, or one Burrow cannot tell, waits for you and says so.
- The label `burrow.update: manual` on a service: checked and told about,
  never updated by itself.
- While Burrow works on a stack (an update, a deploy, a restart, a
  rollback) and for two minutes after, its containers raise no alerts:
  what they do then is Burrow's doing, and the update's own result says
  whether it went well.
- A busy host raises an alert (Host health): the CPU's average over the
  five minutes between samples at 90% or more, or memory at 95% in two
  samples in a row. Heat now also needs two samples in a row: a short peak
  is no alert.
- Holding + on the terminal tabs: choose the host and the way (the host's
  own, with tmux, without tmux, or a direct session from the phone).

### Changed

- Base images moved to their current upstream builds (debian:trixie-slim,
  node:24-bookworm-slim, eclipse-temurin:21-jdk-noble), still pinned by digest.
- The X that closes a terminal is part of the tab in front (Delete on that
  tab does the same); the tabs are narrower, so more fit on a phone.
- The key bar and the text box under a terminal are lower (36 px keys),
  and the text box uses the terminal's font size: more rows for the
  terminal.
- With the keyboard up, a terminal keeps its size and shows the part
  around the cursor, instead of shrinking: programs no longer redraw for
  each keyboard, and an assistant in a tmux attach keeps its input line in
  sight (it fell together with the line below it).

### Fixed

- A line typed right after a swipe through Burrow's tmux history could be
  left out of the command history: its echo was looked for before the line
  had reached the shell.
- When every app failed in the same minute (Burrow's own network, DNS or
  proxy), each was recorded down and alerted on its own, and the outage
  counted against all their uptimes for a day. Such a round now counts for
  none of them, and one message says Burrow cannot reach the apps (with
  why), and another when it can again. An app removed while it was being
  checked no longer breaks the checks.
- The picture in a problem report drew the phone's bottom bar halfway down
  a long page, over its content; bars fixed to the screen now sit at the
  top or bottom of the picture.
- App names on narrow tiles broke in the middle of a word ("Audiobookshel
  f"); all names on the page now take one size at which every word fits.
  A layout check catches a word broken between its letters on any screen.
- A program's own colours that were hard to read on Burrow's terminal
  (tmux's black on green status bar) are made readable.

### Verified

- The gate and the Android app on an emulator.

## [1.12.0] - 2026-10-06

### Added

- Terminal tabs: + opens another session on the same host, X beside the
  tabs closes the one in front (asked first); a double click or a long
  press on the tab in front renames it.
- docs/PRIOR-ART.md: how comparable projects handle each of Burrow's
  features, and what Burrow takes over from them.

### Changed

- Typing straight into a terminal with the keyboard up, the text box folds
  to a key in the key bar, so the terminal keeps its rows (on a foldable's
  inner screen an assistant's input line in a tmux attach was not drawn,
  and what was typed could not be seen). The key, or the keyboard going
  down, brings the box back.
- Deploying a stack from its review deploys exactly what was reviewed: the
  review takes a fingerprint of the whole effective compose configuration
  (every file, .env, interpolation), and if anything changed before you
  press Deploy, Burrow refuses and shows the review again. With several
  compose files the review says which one it shows.
- Unsaved work in the editor, a workspace, or a host or group form now asks
  before any other page opens: the menu, the browser's Back, another file,
  the terminal button. Before, only the page's own Back button asked.

### Fixed

- Pasting a snippet or an AI suggestion of several lines into a terminal
  could run its first lines at once; it now goes in as one paste and runs
  only when you press Enter. Control characters in an AI command are
  removed.
- Saving a file through a symbolic link replaced the link with a plain
  file; saving now writes the file the link points to and keeps its owner.
  The same for saves with sudo, which now also replace the file in one step.
- Two saves of the same file at once (two tabs, two devices) could both
  win; the second now gets the "changed since you opened it" question.
- Reading a file larger than the editor's limit read it whole first.
- Copying or moving files between hosts could overwrite files of the same
  name at the target without asking, and two files with the same name in
  one selection overwrote each other; both are refused now.
- Unstaging a file in a repository without a first commit failed.
- Bulk actions on containers could send the action chosen after the
  confirmation instead of the confirmed one.
- Replace All in a workspace used the search box as it was, not the search
  whose results it showed; changing the search now clears the results.
- A file open in the editor that was read again after a replace lost what
  you typed while it was being read.
- Reports: a container whose logs could not be read (or a log file that
  could not be read) counted as healthy with no errors, and its previous
  problems as resolved. It now needs attention, says why, and keeps its
  previous problems.
- Automatic updates: a rollback that did not bring the old images back was
  recorded and announced as "rolled back"; it is now "failed". Every replica
  of a service is checked, not only the first.
- Burrow's own update: the old version is only called running again when
  it is seen running and healthy; a failed start of the new version now
  starts the old one again. The update uses the compose project and files
  of Burrow's own container, and never another Burrow on a managed host.
- A host whose Docker could not be read showed as a host without
  containers; host statistics and SMART could show zeros or "fine" when
  their commands failed. These now show as errors.
- Typing straight after a swipe through a terminal's history (Burrow's
  tmux) could go into tmux's history mode instead of the shell: a scroll
  step still on its way took it back there. Typing now always comes after
  the last step, and the rest of the swipe is dropped.
- Log analysis and reports: JSON log lines of different levels or with
  different messages were grouped as one (an error hidden among info
  lines); ECS "log.level" fields were not read.
- On a narrow phone in Dutch the theme choice broke "Zwart (OLED)" over
  two lines past its edge; options now stay whole and wrap to a second row.
- A problem report's picture showed the first option of a list ("English")
  instead of the chosen one.
- Tests: a selector the new tab button made ambiguous, the discovery step
  assuming apps on several hosts, and a long-press test that checked too
  little (from the second audit).
- The README listed "What it does" twice.

### Verified

- The gate and the Android app on an emulator.

## [1.11.0] - 2026-10-05

### Added

- Newer versions under another tag: an image on a version tag (nginx:1.25)
  shows when the registry has a higher one of the same shape (1.27; never a
  release candidate or another suffix). *Use 1.27* on the stack changes that
  line in the compose file and opens the review before deploying; never
  taken by itself. A message tells each new one once. Labels
  burrow.tag.include and burrow.tag.exclude say which tags count.
- Apps: the certificate of an https app is read every six hours; 14 days
  and again 3 days before it runs out a message comes through the alert
  channels, and the tile says how long it has.
- Logs: a stack trace is one event; its frames fold under its first line
  (`+12 lines` opens them).

### Verified

- The gate (with a registry that has newer tags, a TLS server whose
  certificate runs out, and a container that logs a Java stack trace) and
  the Android app on an emulator.

## [1.10.1] - 2026-10-05

A security release, from an independent audit of the whole repository. Every
finding has a test that failed before the fix.

### Security

- The file search took its folder as given: "-delete" was an option to find
  on the host, and deleted files below the home folder, for an operator
  too. Paths must now be absolute everywhere.
- Auto-complete put a file's name into the command line as it was: a name
  with ";" or a newline could run a command. Names are escaped now, and one
  with control characters is never offered.
- A WebSocket message "null" ended the server process (an operator could).
- Saving a file on a server without posix-rename deleted the original first;
  a failed rename then lost it. The old file is now moved aside and put back.
- Single sign-on: an e-mail links an account only when the provider verified
  it, and only to the e-mail field; a link holds for its own provider (issuer)
  only; and a sign-in must finish in the browser that started it (login CSRF).
- One authenticator code could be used twice by two requests at once.
- Open connections (terminal, containers, editor) now end when their login
  session expires, and an editor's when its user is no longer an admin.
- Uploads: "do not overwrite" held only at the start (a second upload of the
  same name replaced the first); a replaced file now keeps its mode (a secret
  became readable as 0644, a script lost its execute bit).
- The editor's language server takes no settings from the browser.
- A problem report recorded without the text kept the key codes of letters.
- For a model outside your network: compressed IPv6 addresses are masked
  too (a time of day no longer is), and "local" is decided by parsing the
  address, not by its first characters (10.public.example was "local").
- The direct route's history on the phone skips commands with secrets, by
  the server's rules.
- Alert rule patterns run with RE2, in time with the line: "(a+)+$" against a
  long line held up the whole server. A pattern RE2 cannot run is refused.
- An app check reads its reply up to the limit, not whole first.
- The Android app's WebViews do not load anything from the phone's loopback,
  where the app's WireGuard proxy listens: a server there could ask for the
  proxy's secret in its realm.
- The Android app's SSH library brings BouncyCastle 1.85 (advisories fixed);
  the image ships without npm (advisories in it) and with Debian's latest
  security fixes.

### Fixed

- Text typed in the editor while a save was on its way was marked saved, and
  closing the tab lost it without asking.
- Files of more than 1 MB opened in the editor but could not be saved.
- A report over a host it could not read said "all fine"; the host is named
  in it now and the report is a problem.
- Self-update said "updated" when compose could not start the new version
  (the old one ran on, healthy); it checks the new image runs.
- A resumed download in the app could join two versions of a file; it now
  resumes only the same version (If-Range) and else starts over.
- The app synced its direct-route cache past its own WireGuard (it failed
  away from home).

### Changed

- The gate checks for advisories in the built image (trivy) and in the
  app's WireGuard code (govulncheck), and a failed npm audit fails it (it
  passed as "nothing found"). SECURITY.md lists the advisories judged.
- README: what makes Burrow different comes first.

### Verified

- The gate and the Android app on an emulator, updated from 1.10.0.

## [1.10.0] - 2026-10-05

### Added

- The Android app downloads files itself: how far, the size and the time
  still to go in the notification (with Stop), in Burrow's busy pill and as
  a thin bar over an app tab. A download that broke off (the phone left the
  Wi-Fi, the tunnel went) offers Retry, which asks only for the rest when
  the server allows it. Files go to Downloads/Burrow. A download an app tab
  offers is asked first (an app can offer one without you meaning it);
  Burrow's own Download buttons start right away. The app update shows its
  progress under the button and in the notification too.
- Apps: search by name or address, and sort by your own order, by name, or
  the ones that are down first (kept on this device).
- A new problem report reaches the admins through the notification
  channels that have the new topic "Problem reports" (on for the channels
  that send alerts).
- App tabs show a tunnel sign while the tab in front goes through the
  app's own WireGuard (away from home).

### Changed

- On a phone the title bar is dark, like the rail on a computer, and the
  phone's status bar above it follows (the app paints it the page's colour;
  in a browser the theme colour does).

### Fixed

- The Android app's WireGuard did not notice a change of network (home
  Wi-Fi to mobile data and back) by itself: watching it needs a permission
  the app did not ask for, and the failure was silent. It decided again only
  when the app came back to the front.
- A log file's lines showed their time twice (in the time column and at the
  start of the text).
- A report's fix command broke anywhere on a small phone ("burro / w"): it
  stays on one line and scrolls.
- Notifications without a language of their own (a schedule's report, an
  alert) were in English when no channel for that topic had a language; the
  other channels and then the push devices now decide first.

### Verified

- The gate and the Android app on an emulator (with a new download test
  against a server that breaks off halfway, and lint now part of the Android
  test), updated from 1.9.2.

## [1.9.2] - 2026-10-05

### Added

- A fourth look under Settings -> Appearance: Black (OLED), the dark theme
  with true black behind everything (cards and rows set apart by their
  borders), for OLED screens. The Android app's bars follow it.

### Changed

- A new logo: a b whose bowl is the burrow, a cursor waiting in it, on
  moss green. The app icon (with its one-colour version for themed icons),
  the browser icon, the mark in the rail and on the sign-in page, the
  shortcuts to hosts, and the status-bar icon of the app's keep-alive
  notice (it showed Android's Bluetooth sign).
- The Android app's own screens (pairing, the lock, app tabs) use the
  colours of the new look.

### Fixed

- Alert rules followed each container's log over its own SSH channel (up
  to eight) beside the events and the log files: with many containers a
  host ran out of channels (sshd allows ten per connection) and the
  container list could not be read meanwhile. All of a host's followed
  logs now go through one channel.

### Verified

- The gate (with a new check: the chosen one of a segmented choice stands
  out, which the black theme first failed) and the Android app on an
  emulator, updated from 1.9.1.

## [1.9.1] - 2026-10-04

### Added

- Problem reports have a status: open until an admin marks one solved
  (with when and by whom), and open again if need be. The list shows the
  open ones and the solved ones apart; `make bugs` says which is which.

### Changed

- The coverage floors went up with the tests: the server's integration
  tests 79% of its lines, the web app's lines run by e2e 87%.

### Verified

- The gate and the Android app on an emulator, updated from 1.9.0. The
  status with a unit test (open, solved, open again, the audit log) and in
  the browser (the two lists, the buttons).

## [1.9.0] - 2026-10-04

### Added

- Log files as a source beside a container's own output: suggested from
  its mounts and /var/log, or any path; read on the host through a mount
  (also while the container is stopped) or inside the container. Shown
  with the output or alone in one timeline, with the same filters, search,
  line links, download, AI analysis, alert rules and reports. A rule on the
  whole host also watches the host's own log files, and a report lists
  them as parts of their own. In Files, *Open as log* follows any file.

### Verified

- The gate and the Android app on an emulator, updated from 1.8.0, as a
  phone and as a tablet. Log files against real Docker on the test host:
  a file on the host, one inside a container, one through a stopped
  container's mount, a missing one; times from the lines, --since, a line
  followed live; alert rules on a container's file and on a host file
  (one channel per host); a report with both; the analysis question; the
  container page's chips and Files' Open as log in the browser.

## [1.8.0] - 2026-10-04

### Added

- Containers -> Select: the picked containers restarted, stopped, started
  or updated at once, next to their logs. One question lists what will
  happen to each and what is left alone, and why (already running, not
  running, no update, not in a stack); then each container's progress.
  One failing does not stop the rest, and each action is in the audit log
  as from the container's own page. Burrow's own container is restarted
  when asked but never stopped. Updates go per stack, each service once,
  with what to read first asked as usual. Admins only. On a phone the
  actions are in a menu of their own.

- Problem reports for the admins in Burrow itself: Settings -> Report a
  problem -> Reports received lists what people sent from this Burrow; read
  one whole with its pictures, download it, delete it, or *Report on
  GitHub*: a new issue filled in from it (without the pictures and the
  input), to read and send yourself. Burrow sends nothing anywhere.

### Changed

- A new look ("Werkbank"): IBM Plex type, calmer colours with a green
  accent, a dark rail on a computer with the hosts used last, tables with
  columns on a wide screen (containers, hosts, files), and Settings as an
  overview with a page per part. Sign-in, setup and invites beside a dark
  panel. Every function stays where it was reachable before.
- On a computer: a container's Shell, Restart, Stop or Start and Update
  beside its name (a phone keeps them in the menu); a stack's services
  beside its updates and compose file; alerts beside their rules; a host's
  settings in three blocks; app tiles with the app's first letter when it
  has no icon; and a narrow rail of icons beside a terminal, an editor or
  an app, so the other pages are one click away.
- In the Android app, a finger held on the terminal's text brings up
  Android's own menu (Copy, Paste, Select all) over the selection, as in
  any other app, in place of Burrow's bar.
- The busy pill (uploads, deploys, update checks) sits at the foot of the
  rail on a computer and above the bottom bar on a phone; it covered the
  tabs of every page.

### Fixed

- Status dots on a stack's page and on reports were drawn half
  see-through, which reads as "unknown".
- The containers list can be a snapshot behind right after an action; a
  second bulk action then skipped containers as "already running". The
  dialog reads the containers again when it opens and waits for that.
- A setting saved as it changes (the update window, a rule switched on or
  off) and changed twice quickly could end with the first change saved:
  the two saves overtook each other. Saves to one place now go one after
  the other.
- The Logs page without containers chosen had an empty heading (read out
  as nothing by a screen reader); it says Logs.
- On a small phone the key vault's two buttons took a quarter of the
  screen; they sit side by side.

### Verified

- The gate (now also every page at eleven screen sizes through the layout
  checks) and the Android app on an emulator, updated from 1.7.10, as a
  phone and as a tablet. Every control the tour sees pressed by a test;
  every function of 1.7.10 still reachable with the new look (compared
  against the controls of the 1.7.10 tour: only Settings' jump links went,
  now the overview's rows). Each fix with a test that failed before it.
- A fresh install on a new Debian 13 virtual machine, following
  docs/INSTALL.md from the public tree.

## [1.7.10] - 2026-10-03

### Fixed

- Several lines pasted into a terminal (a log, from the phone keyboard's
  clipboard or the text box) went out line by line, each with its own
  Enter: a program in a tmux attach, such as an assistant, took every line
  as a message of its own. They now go out as one paste, marked as such
  when the program asks for it (bracketed paste); in a plain shell without
  that, the lines still run one by one.
- On a foldable's inner screen with the keyboard up (some 700 x 355) the
  terminal kept only 15 rows, and an assistant's input line in a tmux
  attach fell off the top: what was typed could not be seen. With little
  height the labels make way (below 480 px) and then the tabs (below
  380 px), so the terminal keeps most of it; they come back with the
  keyboard gone.
- A scheduled report that fell due while another report was being made
  (one with explanations takes minutes, or one run by hand) was skipped
  until its next turn; it now waits and is made right after.
- Taking a phone's direct-route key off a host could, if grep failed half
  way (a full disk), leave a shortened authorized_keys behind. The file is
  now replaced only after a complete read. A symlinked authorized_keys
  (keys managed elsewhere) stays a link; the file it points to changes.

### Security

- The language servers and hadolint no longer get Burrow's environment
  (with the master key in it when given as BURROW_SECRET), only what a
  program needs to run. Container names in the commands for logs are
  quoted everywhere.

### Changed

- The update button on the Containers page opens a menu: check for image
  updates now (with when it last looked), or show only the containers
  that have an update (also a choice in the list's filter).
- The Android test first sets up and pairs the release before this one
  (built from git), installs this version over it, and signs in with the
  device key it already had: an update keeps the server, the pairing and
  the key. Debug builds now share one signing key (in the build volume),
  so one can update the other.
- Inside: the server's terminal sessions are split into the tmux scripts,
  one live terminal with its viewers, and the sessions as a whole; the
  terminal's finger selection has its own module, with unit tests.

### Verified

- The gate and the Android app on an emulator, updated from 1.7.8, as a
  phone and as a tablet. The paste, the foldable's terminal height, the
  report queue and the key removal each with a test that failed before
  the fix.

## [1.7.9] - 2026-10-03

### Fixed

- A phone turned on its side with its keyboard up showed nothing of the
  terminal: the session tabs, the labels, the key bar and the text box
  took all the height. With that little room the tabs and labels now make
  way (they come back with the keyboard gone).

### Changed

- The Android test also runs the screens that change most as a tablet
  (signing in, a terminal with the phone's keyboard and FUTO's, the text
  box in a tmux of your own), with their screenshots apart.

### Verified

- The gate and the Android app on an emulator, as a phone and as a
  tablet; the terminal turned on its side in an e2e test that failed
  before the fix.

## [1.7.8] - 2026-10-03

### Fixed

- Before log lines go to a language model, more secrets are masked: an
  Authorization header of any scheme (Token, ApiKey, ...; only Bearer and
  Basic were), `pwd=`, and a private key between its BEGIN and END lines.
- A command run on hosts (snippets, "Run on hosts") that waits for input,
  a `read` or a sudo prompt, hung for a minute before it timed out; it now
  gets an empty input and ends at once.
- A Discord message never pings anyone, whatever a log line in it says
  ("@everyone").
- Typing with a phone's keyboard app right after a key such as Ctrl+U or
  Ctrl+C (the key bar, or a keyboard): the first character could go
  missing, or text arrive twice. The keyboard now starts over with such
  a key.
- Taken out again: the app's extra notice to a keyboard chosen while a
  terminal is open (1.7.2). It did not help, and its extra restart of the
  input during the switch could leave the new keyboard bound to nothing
  for a while.

### Changed

- The gate's dependency audit can accept an advisory that cannot do harm
  here, with the reason and until a date (scripts/audit-allow.json): the
  one in braces (no fixed version yet) is only reached through the
  editor's shell support, which Burrow starts without any file globbing.

### Verified

- The gate and the Android app on an emulator; the masking and the command
  waiting for input in tests that failed before the fix.

## [1.7.7] - 2026-10-03

### Fixed

- A problem report from the app named the page's version as "App", not the
  app's own (reported as 1.7.6 while the app was 1.7.4); it now says both.
- Updating an app older than 1.7.5 through its own WireGuard fails (its
  tunnel was fixed in 1.7.5); Settings now says to update it once on the
  home network, instead of "unexpected end of stream".
- Searching the hosts with many of them listed far too many: among 600,
  "host-421" found 387. What was typed, found as written, now shows only
  those; near misses (a typo) only when nothing matches as written.

### Changed

- New tests with many of everything: 600 hosts (shown within seconds,
  search finds one) and 450 containers on three hosts.

### Verified

- The gate and the Android app on an emulator; the search among 600 hosts
  and the problem report's app version in tests that failed before.

## [1.7.6] - 2026-10-02

### Added

- A container with a newer image is updated from its own page: "Update
  available" (or "Update now" in its menu) asks once, warns when the
  release notes in between announce a breaking change, and shows the
  update's progress right there. It was only a way to the stack's page.
- On a stack's page you choose which services to update: each has a box,
  ticked at first ("Tick all" / "Untick all" with several); "Update now"
  updates the ticked ones. It was all or nothing.
- A problem report says which time zone the device shows times in.

### Fixed

- A problem report's picture of a log on a phone showed the lines without
  their messages (the part that wraps under the time was not drawn).
- When Burrow asked two things in a row (update this?, then a warning from
  the release notes), the second question could be cancelled by the first
  one closing, and nothing happened.
- Over a change of the clocks: a scheduled report at a time in the hour
  that comes twice in October ran twice, and one in the hour skipped in
  March did not run that day (an update window starting then did not open
  either). Each now runs once, right after the skipped hour.

### Changed

- What is new in an image (its release notes) is easier to read: the
  app's name as the title, how many newer versions there are, what to
  read before updating once at the top with its version (and what is
  worth knowing apart), then each version as a row that folds open (the
  newest and any with a breaking change open), its notes formatted
  (headings, lists, code, links to GitHub) instead of raw text. HTML in
  the notes still shows as text; images are only linked, never loaded.
- A test brings a database from every earlier schema (with a row in each
  table) up to date: no update may fail or lose a row.

### Verified

- The gate and the Android app on an emulator; the release notes looked at
  on a computer and a phone (layout checks); the clock changes of 29 March
  and 25 October 2026 in unit tests that failed before the fix.

## [1.7.5] - 2026-10-02

### Fixed

- Updating the app (and other downloads the app makes itself, such as a
  file to open in another app) over the app's own WireGuard failed with
  "unexpected end of stream on null" when Burrow is on https. Android's
  HTTP client asks the tunnel's proxy again on the same connection after
  being asked for the proxy's secret, and the proxy had closed it; it now
  keeps the connection open for that.
- An upload nobody finished (the tab closed for good) stayed in Burrow's
  memory and left its hidden temporary file on the host; after a day it is
  now given up and the file removed.
- When Burrow could not be reached (offline, restarting, an error), most
  pages threw an error out of sight from a load running in the background
  (the hosts, the update overview, the alert count, the sessions) and said
  nothing; they now say "No connection with Burrow" (or what went wrong)
  once, and keep working.

### Changed

- The e2e tests also run in Firefox (on a computer and as a phone) and in
  WebKit (an iPhone): the main pages, a terminal with a finger's scroll
  under a program that takes the mouse, and the editor. The rest of the
  tests run in Chromium.
- A new test opens every page with Burrow's API failing three ways (an
  error, no answer at all, a proxy's own page with status 200).

### Verified

- The gate and the Android app on an emulator. Each fix has a test that
  failed before it: the proxy's second CONNECT on the same connection (Go,
  against a real WireGuard server), every page with the API failing, an
  upload left for a day.

## [1.7.4] - 2026-10-02

### Fixed

- In the browser on a phone, scrolling with a finger in a terminal under a
  tmux of its own (`tmux attach` with the mouse on) also pulled the page
  down for the browser's reload. The terminal's touch handlers were added
  as passive listeners, so stopping the page did nothing; they no longer
  are, and the terminal does not hand its scroll on to the page. The
  selection's grips had the same problem.

### Verified

- The gate and the Android app on an emulator; an e2e test that sends a
  finger's scroll to a terminal whose program takes the mouse and checks
  the page is kept out of it (it fails before the fix).

## [1.7.3] - 2026-10-02

### Fixed

- The Terminal tab in the app stayed broken after Burrow was updated:
  while Burrow restarted, the reverse proxy answered with its own page
  (with status 200), the app's WebView kept that page in its cache for the
  list of sessions, and every later visit got it again instead of asking
  Burrow. The app now never takes an answer to Burrow's API from the cache,
  and an answer that is not Burrow's is an error ("Burrow did not answer"),
  never an empty list; the list tries again by itself. No need to clear
  the app's cache: the update itself fixes it.
- Without the shell integration, a line typed at a prompt that does not
  echo (sudo's password, `read -s`) went into the host's history when the
  same text stood on one of the two rows above it, for instance a password
  printed by pwgen and then pasted at sudo's prompt. Only the line the
  cursor was on counts now. A command that wrapped over two rows was never
  recorded; it is now.
- "Type stored password" while scrolled back in a tmux session's history
  went to tmux's copy mode instead of the prompt; it now leaves the history
  first, as typing does.
- Path completion took "~name" (another user's home) for the own home
  ("/home/testername").
- A tmux session the host refused to reattach left its SSH connection
  open.
- The server no longer logs Fastify's deprecation warning at startup.

### Verified

- The gate and the Android app on an emulator. Each fix has a test that
  failed before it: the proxy page as an answer (a unit test and an e2e
  test of the Terminal tab), the history at a silent prompt and the stored
  password in tmux's history (integration tests against a real sshd).

## [1.7.2] - 2026-10-02

### Fixed

- A terminal in the app over Burrow's WireGuard could lose its connection
  after going home and back: the page now checks a connection that still
  looks open with a ping when the app comes back, when the phone is online
  again or the tab is shown, and replaces it when no answer comes within
  2.5 seconds. The app no longer sets the tunnel's proxy again when nothing
  changed (setting it drops the WebView's open connections).
- Choosing another keyboard while a terminal has it (seen with FUTO's):
  the new keyboard sometimes treated the terminal as a text field and held
  words back until a space, so nothing arrived. The app now tells a newly
  chosen keyboard again that the terminal takes plain characters.
- The e2e tests left containers behind on this machine's Docker after a
  failed run; the next run removes them first.

### Changed

- Dependencies up to date: the Android build on AGP 9.4.1 (Kotlin built
  in), Gradle 9.8.0, JDK 21, NDK 30, Go 1.27.1, compiled against Android 37
  (it still targets 35), AndroidX core 1.19, appcompat 1.8, webkit 1.17,
  UnifiedPush 3.3.5; on the server the Anthropic SDK, nodemailer 10, ws;
  Vite 8.3 for the web app. sshj stays at 0.39: from 0.40 it does its
  curve25519/ed25519 through BouncyCastle, which Android's own provider
  gets in the way of, and the direct route stopped connecting.
- Every control on the screens the tests look at is now pressed by some
  test (the 74 still to do are done), each with what it does checked: the
  alerts' rows and mute lengths, the apps' tiles, form and order, a
  container's state line and download, the merged log's sources, the
  editor's tools and find and replace on a phone, a folder's menu, a
  workspace's tabs, the Claude and ChatGPT links of an analysis (they get
  the click and open the right address), copying the recovery codes, and
  more.
- The gate also checks that server and web ask for the same version of
  the shared package as everything else.
- `E2E_KEEP=1` leaves the e2e setup running; `E2E_REUSE=1` runs tests
  against it again. `ONLY=<Class>` runs one Android test class.

### Verified

- The gate, and the Android app on an emulator with its own keyboard and
  FUTO's (its device tests three times in a row after the keyboard fix).
- The WireGuard fix: a unit test with a connection that looks open but
  answers nothing (it fails without the fix). The exact case on a phone,
  home and back over the tunnel, could not be reproduced on the emulator.

## [1.7.1] - 2026-10-02

### Fixed

- Leaving a terminal on a phone with its keyboard up gave an error in the
  page (state_unsafe_mutation): the field's blur came while the page was
  being taken down.
- Containers on a narrow phone, picking: a container's host badge was cut
  off next to its numbers; the name wraps instead.

### Changed

- The gate holds the web app's code coverage from the e2e tests to a floor
  (85% of its lines; it runs 86%).
- The tour asks for a fresh confirmation for each of its rounds, so it
  passes however long it takes.
- The gate checks that every control on the screens the tests look at is
  pressed by some test (74 still to do, listed; the list may only shrink).
  A last test presses every control left on every page, on a computer and
  a phone, and whatever removes or ends something on things made for it.

### Verified

- The gate, with its new steps: the web app's coverage from e2e (86% of
  its lines), every control on the screens the tests look at pressed by
  some test (or listed), every API route used by some test.
- The Android app on an emulator with its own keyboard and FUTO's.

## [1.7.0] - 2026-10-01

### Added

- Report a problem without going to Settings first: shake the phone (in
  the app; Settings -> Android app turns it off) or press Ctrl+Shift+B on a
  computer, also in a terminal (it does not reach the shell as Ctrl+B).
- A report from a terminal takes the last 30 seconds of input along: keys,
  the keyboard's edits, touches and what went to the session, without what
  was typed unless "Also send what I typed" is ticked. `make replay ID=...`
  plays it again on the test setup and shows what the terminal then says.

### Changed

- The Android app's own unit tests run with the device tests (they were
  never run).

### Verified

- The gate: Ctrl+Shift+B on a terminal (the report opens, Ctrl+B does not
  reach bash, the input goes along without and with the text); a shake
  from the app opens the report, the setting turns it off; the replay plays
  a kept recording and the command runs; the report's recording is saved
  beside it, a too long one refused.
- The Android app on an emulator: a shake opens the report, the setting is
  kept on the phone; which jolts count as a shake (unit test).

## [1.6.2] - 2026-09-30

### Added

- A running upload can be stopped from the list of transfers.
- A selection in the terminal has a grip under each end: dragged, that end
  moves, so the selection grows or shrinks.

### Changed

- One finger scrolling on the host (a tmux of your own, a program that
  takes the mouse such as Claude Code, Burrow's tmux) takes more lines the
  faster the finger goes, up to four per line moved; a slow drag stays line
  for line. In Burrow's tmux one scroll command runs at a time, the rest
  gathered into the next, so a swipe no longer queues up on the host.
- The gate also fails on unused files, exports and dependencies (knip).
- A container's Stop, Start and Restart no longer wait for a full look at
  the host (with docker stats) first.
- A new image's release notes are read the same way the automatic update
  reads them.
- The gate fails when an API route is used by no test (unit, integration
  or e2e), unless `server/test/route-exceptions.json` says why. Every route
  is also tried signed out, as an operator, without a fresh confirmation,
  and with bad input (never a 500).

### Removed

- Unused code: two API routes the app never called (renaming a key,
  deleting a report; reports are pruned to the newest 100), four functions,
  three packages (pino, codemirror, @withfig/autocomplete-types) and
  thirteen texts. A test now fails on a text nothing shows.

### Fixed

- Typed straight into the terminal with the text box open, a picked
  suggestion went into the box; it goes where it was typed.
- An upload that gave up left its hidden temporary file on the host.
- Typed a key at a time right after scrolling back in Burrow's tmux, the
  keys could arrive out of order, and the history missed the first one.
- A push message with emoji or text in another script could be too big for
  the push service; it is shortened by bytes now.
- All hosts spoke of "this group" and offered to inherit from nothing; it
  says "For every host" and names Burrow's own defaults.
- "Add a folder" in a workspace ran past the edge of the side bar.
- A suggestion picked while the list was still catching up with the typing
  put in part of what was already typed; it adds only what is missing.
- Without the shell integration, a command just run was not suggested yet:
  the history is read again once the server has it.
- A command just run came to the suggestions only with the next key: they
  are worked out again when the history arrives.
- A selection's grip moved the end one line below the finger.

### Verified

- The gate: the phone matrix now has a fourth way of typing (straight
  into the terminal with the text box open) and every way picks a
  suggestion; a grip dragged to grow a selection; every API route used by
  some test; knip; a check that no button runs past the edge of its box.
- An audit of the day's changes: server, Android bridge, push, terminal,
  and the new screens looked at.
- The Android app on an emulator with its own keyboard and FUTO's.

## [1.6.1] - 2026-09-30

### Fixed

- Typed straight into the terminal with the text box open, no suggestions
  came: they looked only at the (empty) box. With the box empty they come
  from the terminal's line.
- Held on the terminal's text: the selection was hard to see (grey on
  grey), and its bar of four buttons ran off a phone's screen.
- Back in a session with a tmux of your own, one finger no longer
  scrolled: the mouse came back in the old encoding (tmux asks for SGR).
- Terminal tabs swapped places with every bit of activity; they keep the
  order they were opened in.
- In a session in Burrow's tmux a finger scrolled back only a little after
  fast output (tmux redraws it rather than scrolling): it now goes through
  tmux's own history (its copy mode, "[n/m]" in the corner), and typing
  leaves that first.
- On a phone the terminal's top bar keeps the tabs and the menu; the
  password, AI and snippets buttons are in the menu there.
- The app's own downloads (its update, "Open with", a file to Downloads)
  go through the WireGuard tunnel when it carries Burrow: away from home
  the update failed ("failed to connect ... after 15000ms"). The update
  says it is downloading.
- "Sign out everywhere else" stuck to the list above it; a card or list
  and what follows keep room between them, and a row's button stays on
  one line ("Choose hosts" wrapped). The tour checks both.

### Verified

- The gate, now with a matrix on a phone: three kinds of session (Burrow's
  tmux, plain, a tmux of your own) by three ways of typing (keys, a
  keyboard app, the text box), each typing once, a backspace, Enter and
  suggestions, plus one finger scrolling back and a held word copied; a
  fuzz test of a keyboard's edits; the list of reported problems, each with
  its test (docs/REGRESSIONS.md).
- The Android app on an emulator with its own keyboard and FUTO's.

## [1.6.0] - 2026-09-30

### Added

- All hosts (Settings -> All hosts): a user, key, tmux choice or startup
  command for every host that neither sets it itself nor gets it from a
  group, above the groups. The host's form says where an empty field's
  value comes from ("from group Home: tester", "from All hosts: ana").
- Burrow's own push notifications, without Google or a separate app's
  notifications: Settings -> Notifications on this device turns them on
  in a browser (Web Push) or in the Android app (through the phone's
  UnifiedPush app, such as ntfy, which only carries them). A new channel
  kind, "Burrow's own push", chooses what goes there. Each message is
  encrypted for the device (RFC 8291) and signed by this Burrow (VAPID); a
  tap opens the page it is about.

### Changed

- The ntfy channel kind is called "ntfy" (was "ntfy (push)").

### Fixed

- A field and the buttons beside it are one height (the WireGuard list's
  search box and All/None); the tour checks every page for it.
- Opening a second session on a host renamed the first one ("Debian 2");
  sessions are numbered by age now.
- A problem report's picture showed ticked boxes and typed fields empty.
- Settings -> Android app: the app's version and the pairing were two
  cards without room between them; one card now, and the tour checks for
  touching cards.
- Away from home, the app needed a reload by hand after the WireGuard
  tunnel had gone down in the background and come back.
- One finger did not scroll a plain shell's history on a phone (since
  1.5.1 only two fingers did); it scrolls again, and glides after a flick.
- Holding a finger on the terminal's text could select the line below.
- A problem report from a terminal page tells how typing and the
  suggestions went (screen, prompt found, suggestions counted, the
  keyboard's last events by kind), never what was typed.

### Verified

- The gate, with new tests for All hosts, push to a device (the push
  service's copy encrypted, only the device's key reads it, RFC 8291's
  example reproduced), one finger scrolling a plain shell, a held word
  copied, and a field beside its buttons of one height.
- The Android app on an emulator: typing with the keyboard's own keys,
  the emulator's keyboard and FUTO's, brings the suggestions; one finger
  scrolls back; a push message shows as Burrow's and a tap opens its page.

## [1.5.1] - 2026-09-30

### Added

- Typing straight into the terminal on a phone is sent exactly once: a
  keyboard's correction or picked suggestion becomes backspaces and the
  right text, instead of text sent twice (xterm.js guessed from its hidden
  field). The Android app asks the keyboard for plain characters while the
  terminal has it, without suggestions, as Termux and Termius type.
- The Android app updates itself: a newer app on this Burrow shows a dot on
  Settings, and Settings -> Android app -> "Update the app" downloads it,
  checks its SHA-256 and opens Android's installer.
- Two fingers side by side (on a computer Shift + the wheel) scroll
  Burrow's own history, also under a program that takes the mouse, such as
  a tmux of your own with mouse on.
- Hold a finger on the terminal's text to select a word, drag to take
  more; a bar copies it, selects everything or pastes.
- In the Android app the volume keys are keys while a terminal is open:
  volume down is Ctrl, volume up then W A S D gives the arrows, E Esc, T
  Tab, 1-9 F1-F9, P and N page up and down.
- The screen stays on while a terminal is open, and a terminal bell makes
  the phone buzz.

### Changed

- A session without tmux on the host no longer switches to the alternate
  screen (as Burrow's own tmux never did): what was on screen before a tmux
  or vim of your own stays in the scrollback. The direct route does the same.

### Fixed

- The send button beside the terminal's text box grows with the box.
- Empty rows under the terminal's content that could be scrolled into:
  the session kept running at an older size after the text box or the
  keyboard took room.
- Adding a picture to a problem report failed ("Cannot set properties of
  null").

### Verified

- The gate, with new end-to-end tests that type as Gboard does (a
  correction sent once), hold a word and copy it, scroll back past a tmux
  of your own with Shift and the wheel, and keep a grown text box and the
  terminal's rows in step with the session.
- The Android app on an emulator: the terminal asks the keyboard for plain
  characters while it has it and gives that back when left, keeps the
  screen on, and takes the volume keys (Vol+ shown, Ctrl lit).

## [1.5.0] - 2026-09-30

### Added

- A stack held for a breaking change can be released on its page after
  reading ("Read: may update automatically"): those releases then update in
  the window; a later breaking change holds it again.
- A report schedule's rule for a stack or container can name its host: the
  same name on another host is left alone (a rule on one host wins over the
  same name on any host).
- A stack's page and a folder in Files show what was seen at once when
  opened again, and the fresh answer when it is in (like a container's
  page), instead of an empty page while SSH answers.
- The Android app's direct route keeps a session: on a host with tmux it
  runs in a tmux of its own there, so leaving (back) only detaches and the
  host list marks it; opening the host again goes on where it was. "End
  session on host" in its menu stops it. A host without tmux works as
  before (the session ends when left, after a question).
- Scrolling a tmux (or another program that takes the mouse) with a finger
  moves once a frame and glides on after a flick, slowing down, as a phone
  scrolls elsewhere; the wheel's codes of one moment go out as one message
  (a flick sent dozens).
- The editor marks what changed since the save beside the line numbers
  (added, changed, deleted), and "Compare with saved" in its menu shows
  it all as a diff.
- "Compare with..." in a text file's menu: another file, on this host or
  another, as a diff.
- Workspaces with more than one folder (on the same host): "Add a folder"
  in the file tree shows it beside the first, each under its own name;
  search, git and "Go to file" work in the folder chosen at the top.
- The terminal learns which command usually follows which on a host (also
  from an imported ~/.bash_history): right after a command, with nothing
  typed yet, it offers what usually comes next. Forgetting a command takes
  it out of these too; secrets are never learnt.
- Apps in Manage are ordered by dragging their grip (finger or mouse, or
  the arrow keys on it), or all at once with "Sort A-Z". "Find in
  containers" can show one host at a time.
- Pull to refresh on a phone (hosts, containers, a stack, files, apps,
  alerts, reports): pulled down at the top and let go, the page reads again.
- Search in what the terminal shows (its scrollback): Ctrl+Shift+F on a
  computer (Ctrl+F stays the shell's), "Search in the output" in the menu
  on a phone; matches marked, with their count.
- A host's own alert limits on its statistics page: CPU temperature, disk
  temperature and how full a disk may get before "A problem with the host"
  alerts. Empty is Burrow's default (shown as the hint); the page colours
  temperatures and disks by the host's own limits too.
- Keyboard shortcuts in one overview: "?" on any page (not while typing),
  or Settings -> Keyboard shortcuts on a computer. Shift+Enter in the
  terminal's search goes to the previous match.
- Snippet variables with more to say: {{name=value}} starts with a value,
  {{name=a|b|c}} is a choice, {{name=}} may stay empty, and {{container}}
  offers the running containers of the host(s) to pick from.
- A terminal session can have a name of its own ("Name this session" in
  its menu), shown on its tab and in the session list with the host beside
  it; a container's shell is called after its container. Emptied, it is
  the host's name again.

### Fixed

- In a session in Burrow's tmux, Ctrl+B belonged to that invisible tmux:
  Ctrl+B d detached the whole session, and a tmux of your own inside never
  got its prefix. Burrow's tmux has no prefix key now.
- Turning "Update automatically" on or off for a stack was not kept in what
  the page shows at once when opened again: until the fresh answer came, it
  showed the old setting. The switch also waits for its save now.
- The "update" pill on a picked container row, and on a stack's heading,
  had too little contrast for its small text.
- A container's shell in the terminal was stored under the container's name
  but shown under the host's; it is shown by its name now.
- Keyboard hints such as "(Ctrl+Shift+F)" showed in menus on a phone.

### Verified

- The gate (unit, integration, the end-to-end tests on desktop and phone,
  and the tour of every page and dialog in English, Dutch and dark mode)
  and the Android app on an emulator, including a direct session kept in
  tmux on the host, left, and opened again with its output.

## [1.4.0] - 2026-09-29

### Added

- Breaking changes in image updates: "What is new" reads the release notes
  of every version in between and names the ones that change something
  you rely on (their own words, a "Breaking changes" heading, `feat!:`,
  or a new major version), marked at each release. Updating by hand asks
  first and names them; an automatic update does not happen then, the
  stack waits for you and your channels hear why.
- The same for Burrow itself: Settings -> About lists the CHANGELOG's
  "Breaking" items between the running version and the new one, and the
  update asks with them in red.
- The app's own "are you sure?" everywhere (36 places) instead of the
  browser's: the button says what happens ("Delete", "Close session",
  "Leave without saving"), red when it cannot be undone. The name of a
  new passkey is asked the same way.
- "Run the window now" says it runs, also after leaving and coming back
  or when its schedule started it; a second start is refused.

### Fixed

- In your own tmux (started from a Burrow terminal), a line sent from the
  text box ran nowhere: the text and its Enter arrived as one read, and a
  program that watches for pastes took the Enter as part of one. The Enter
  now goes a moment after the text.
- A problem report from a dialog: the page's button sat behind it. While
  armed, each dialog has its own button, and the report says which dialog
  was open.
- Alert rules: the host's own problems (disk full, SMART, heat) are their
  own kind, no longer under "Docker reports a problem", and can be set for
  any host, not only Docker hosts.
- Typing straight into the terminal inside your own tmux got no
  suggestions (only the text box did): tmux draws on the alternate screen,
  where no prompt was looked for. A clear shell prompt (user@host, then $
  or #) counts there now.
- Analysing the logs of more than 20 containers (the log view takes up to
  100 since 1.3.0) was refused, and the Claude, ChatGPT and Copy buttons
  stayed dead without a word. Up to 100 now, and a refusal is shown.
- The container list says "As last seen; refreshing..." until the fresh
  snapshot is in, like a container's page.

- The editor's key bar stayed on a phone after its keyboard closed (the
  focus stays in the text); it now goes with the keyboard.
- Find and replace (Ctrl+F) in the editor had CodeMirror's plain look and
  English words; it has the app's fields and buttons now, in Dutch too.

- The list of sessions said "no device connected" while the phone had the
  same session open: it was read once, when it opened. It follows who is
  connected now.
- On a laptop, a report's fix commands stood one letter a line beside a
  full-width Run button. A new check fails any text squeezed like that.
- The help for a session in Burrow's memory said the host has no tmux,
  also when the session was simply started without it.
- Help texts that had fallen behind: image checks run in the window
  (daily, weekly or by cron), alerts also cover a host's disks and heat,
  reports read the lines their schedule chooses, and the app allows
  screenshots when you turn them on.

### Changed

- No key bar in the terminal and the editor on a computer (a mouse and a
  wide screen): the keyboard has Esc, Ctrl and the arrows.
- Plain ASCII in all text, code and docs: no typographic quotes, dashes,
  arrows or dots; symbols on buttons (send, pin, stars, arrows) are icons
  now. Dutch letters stay. A test keeps it so.
- The tests build their own image (burrow:e2e) instead of the live
  instance's tag: a test build no longer counts as "already built" for a
  self-update. The gate checks it.

### Verified

- The gate and the Android app on an emulator: the back gesture closes an
  open question before it leaves the page, and the direct route asks in
  its own dialog.

## [1.3.0] - 2026-09-29

### Added

- Which log lines a report reads: one rule for every container (since the
  last report, the last lines, the last hours, or since the container
  started; which levels), and exceptions for a host, a stack or a
  container, or leave one out. What is new since the last report goes to
  the AI first.
- A report's fix can be carried out: the model gives a command per step
  where one fits; "Run..." shows it (changeable), the host, and its risk by
  Burrow's own rules (which only raise the model's label). Nothing runs
  until you press the button, a high risk needs a tick first, and it asks
  for a fresh sign-in and is audited like a snippet.
- The maintenance window for image updates opens daily, weekly or by a
  cron expression, like a report.
- Logs of up to 100 containers at once (was 30), over one connection per
  host. Containers can be filtered by state, and in select mode everything
  the filters show is chosen in one tap.
- Long lists to tick from (WireGuard, the phone's direct hosts, a command
  on several hosts) show the chosen ones first and the first few of the
  rest; a search, All and None once they are long.

- A report schedule's own choices, in sections: when (with the next
  time), which containers, sending (to chosen channels, or only when
  something needs a look), the AI's explanations on or off, and (under
  Advanced) from how many errors or warnings a container needs a look.
- Reports has the AI's analyses of containers beside the reports: read
  one, and go to its logs.
- "Make now" shows how far the report is (reading logs n of m, the AI
  explaining) and when it should be ready, on its page and in the busy
  pill, also after leaving the page.
- Remembered commands can be forgotten: hold (or right-click) a suggestion
  in the terminal, or search and remove them in the host's menu under
  Completion and history.

### Fixed

- A container's page shows what was last seen at once ("as last seen,
  refreshing...") instead of loading from scratch each time.
- The Android app's WireGuard: switching between home and away no longer
  crashes (a stopped tunnel's port was used, and two switches could run at
  once), and it notices a network that just became usable sooner.
- On a laptop the page sits in the middle of the room beside the
  navigation rail, not of the whole window.
- Editing a report schedule opened nothing (a copy of reactive state
  failed); the level chips of its rules are readable when off.
- The text box of the terminal has one send button, which sends and runs
  (hold it to put the line down without Enter); a phone keyboard's Enter
  sends too. Before, a second arrow only put the text on the line.
- In a program that takes the mouse (your own tmux with "mouse on"), a
  finger scrolls its history.
- Self-update: when the build gives the image that already runs, it says
  "nothing new" and restarts nothing (it said "Updated"). Its messages are
  in the app's language. The button says "Rebuild".
- "Inherit" says what it inherits ("Inherit: Use when available").
- "Check now" for image updates says "Checking" while a check runs on the
  server, also when the page is opened again.
- SMART on a host without smartctl: said once (it was said twice, in two
  languages), with the line that installs it and a copy button.
- Fields in use take the chosen accent colour, not the browser's blue.
- The editor gives the text the screen: one save button (top), problems as
  a badge in the top bar only when there are any, the checks, search,
  format and folding in a menu (three dots), the key bar only while typing, a narrow
  gutter whose chevrons mark foldable lines (a tap on the line number
  folds too).
- The log view: search, filters and actions on one line; on a phone the
  filters fold away behind a button that counts the ones that are on.
- Two terminal sessions on one host have tabs that tell them apart.
- An alert with a long container name: the name is cut short, its host
  and "New" pills stay whole (the pill was cut off half-way).
- Containers: the image check is an icon in the top bar (when it last ran
  in its label); a line below only when there are updates, or while
  checking (it took two lines to say all was well).
- On a laptop, a laptop's layout: the navigation is a rail on the left
  (not a phone's tab bar), Settings has its section list beside the
  sections, and a page's context (host, stack) is a quiet line under its
  title instead of a pill in the corner. The interface's rules are written
  down in docs/UI.md.
- Temperatures by part (CPU, NVMe SSD, memory, mainboard), not the
  kernel's sensor names; in alerts too.
- Two containers of one service on a stack's page have their own names.
- Channels: one "Add a channel" button, then the kind, instead of four
  buttons that wrapped on a phone; WireGuard's three ways in, one under
  the other.
- Every page and dialog is in the tour, enforced: dialogs carry a name
  and the tour fails when one was never looked at.
- Every screen's main content (editor, terminal, log) keeps most of the
  screen, checked on every screen of the tour (and the editor with the
  phone's keyboard open).
- A container with a newer image shows an "Update available" pill and an
  "Update..." action leading to the stack, instead of a long sentence.
- On a small phone in Dutch: managing apps (a row opens its settings, the
  name keeps its room), a stack's actions ("Pull"), the analysis dialog
  and the log filters (one line) no longer wrap or squeeze.

### Verified

- A self-update started from Settings on the live instance.
- The Android app on an emulator: the WireGuard test switches home and
  away forty times from four threads without a crash.
- The multi-container log script with dash and mawk, and with busybox; a
  unit test runs it with this machine's sh and awk on a burst of both
  streams.

## [1.2.0] - 2026-09-28

The audit's findings fixed, and six additions.

### Added

- **Uptime of app tabs**: every app is checked each minute (any answer
  below 500 is up); down after two misses in a row, a message on the
  channels when it goes down and when it is back, and the share of the last
  day on its tile. Checked at once when added. Can be turned off per app.
- **Burrow updates itself** (Settings -> About): Burrow finds its own
  container, tells what the folder would start, and updates it detached
  from itself: a git checkout pulls (with an upstream) and builds, an image
  is pulled. A backup first when the backup service runs. When the new
  container is not healthy within two minutes, the old commit and image
  come back.
- **Port forwarding in the app**: a port of a direct-route host on the
  phone's 127.0.0.1, opened in the phone's browser.
- **Wake-on-LAN**: a sleeping host is woken from its menu; another host that
  is up (on the same network if there is one) sends the packet. Burrow
  learns the MAC address while the host is up.
- **Backups in Burrow**: the backup service writes its state; Settings shows
  the last backup, and a message goes out when one failed or the last good
  one is more than two days old.
- **A command on several hosts** without a snippet, from the hosts page.
- A session unlike the host's tmux setting, this once, and the phone's own
  direct session, from a small menu by "New session".

### Fixed

- An AI analysis no longer ends in "Failed to fetch" when the app was away
  for a moment: it goes on following the analysis once back.
- An analysis is kept from the start: one that fails or takes too long is
  among the container's earlier analyses too, with why. A local model's time
  limit is set in Settings -> AI (10 minutes by default, was a fixed 5).
- A host's connection is shared by everything Burrow asks it; when sshd has
  no channel free (MaxSessions), a command now waits for one instead of
  failing ("Channel open failure").
- The stack page keeps itself current (containers started outside Burrow).
- Host alerts (temperature, disk, SMART) have readable names, open the
  host's statistics and have no "Analyse" (there are no logs to analyse).
- Over a lost connection, "No connection with Burrow" instead of "Failed to
  fetch"; the app's error screen says why in words, its code below.
- The "New" pill of an alert no longer touches the host pill.
- The Android app's version was shown twice in Settings.
- "1 hosts", "1 commits" and the like: the singular for one, everywhere.

### Changed

- A consistent interface: dates one way everywhere (the month in words, 24
  hours); actions are buttons and links only go somewhere; help tips beside
  their title; green only for confirming; Settings saves single choices at
  once and warns about unsaved AI or sign-on settings; AI and single sign-on
  show their fields only when switched on; the section buttons in one row;
  the newest five signed-in browsers, the rest on request.
- Limits: ten problem reports an hour per person, and the newest 200 kept
  within 500 MB; thirty AI analyses an hour per person.
- `docker stats` runs every third poll (15 s) instead of every one.
- Retention: the audit log a year, alerts 90 days, the newest 100 reports.
- Rolling back keeps the running image by its id, not by its name.

### Verified

- Every control with a test id is pressed or filled by some test
  (`web/src/testids.test.ts`); new end-to-end tests for every edit and
  delete, the account settings, containers and stacks, and git.
- The server's tests keep a coverage floor in the gate (unit 48%,
  integration 72% of lines).

## [1.1.0] - 2026-09-28

The audit after the first release, and phase 13.

### Security

- API access is checked by the route a request matched, not its raw URL:
  a percent-encoded path (`/%61pi/...`) skipped the session check.
- An admin who is demoted or removed loses the direct route: the phones'
  SSH keys come off every host, and open terminals close.
- The rate limit counts per signed-in person (and per address otherwise).

### Added

- **WireGuard in the Android app** (phase 13): wireguard-go in the app's
  process, without Android's VPN service. Away from home (Burrow not
  reachable directly) it comes up by itself; Burrow, chosen app tabs and
  direct-route hosts go through it, each set on or off. The configuration
  comes from a QR code, a .conf file or pasted text, is sealed with a key in
  the Android Keystore and never goes to Burrow. The tunnel is reached
  through a proxy in the app that only the app can answer. For the battery
  it goes down after a minute out of sight (not during a transfer), and it
  sends no keepalives.
- **Analyse with your own Claude or ChatGPT**: the analysis dialog makes the
  question here (grouped, secrets and IP addresses masked) and opens
  claude.ai or chatgpt.com with it filled in, or copies it; you send it from
  your own account. Also when no language model is set up.
- **Progress**: stack operations show images and containers done, read from
  compose's own output; an update check counts the images; one busy pill
  for uploads, stack operations and checks.
- **Problem reports** for the developer, with a screenshot and context,
  saved in the data directory (`make bugs`).
- Settings: jump buttons to each section; sign out every other browser.

- **AI analyses run on the server**: a reload or a dropped connection
  loses nothing, and each container keeps its earlier analyses (in the
  analysis dialog).
- **Update check without updating, and a message for new updates**: the
  daily check and the automatic updates are two settings now; new updates
  are told once each on the channels for "updates".
- **About Burrow** in Settings: the versions of the page, the server and the
  Android app, and a hint to reload when the page is older than the server.
- **`burrow.ignore=true`**: a container label (the name set with
  `BURROW_IGNORE_LABEL`) for containers Burrow should leave alone: no
  alerts, update checks or reports. Burrow's own tests use it for their
  throwaway containers, which had raised alerts in a Burrow watching the
  same Docker.

### Fixed

- An image was reported as having an update right after it was updated,
  when its pull added a second digest; images still marked so are checked
  again a minute after Burrow starts.
- New alerts are marked "new", not red (red is for errors); radio buttons
  had a text field's size; the line choice in the analysis dialog only when
  there is one.
- "Report a problem" can be switched off again (x beside its button).
- Search fields cut their hint early (room kept for a hidden clear button).
- Dates follow the app's language; plurals ("1 problem"); built-in names
  translated; the editor's and terminal's colours on both themes; the
  statistics' period dropdown on a small phone; contrast and labels found by
  axe-core.

### Verified

- Gate: lint, typecheck, unit, integration, e2e (a tour of every page and
  dialog on phone, desktop, Dutch and dark, with axe-core), the WireGuard
  library against a real WireGuard server.
- Android emulator (API 35): 14 instrumented tests, among them a WebView and
  a direct-route socket through the app's tunnel to a page that exists only
  behind it, and the proxy refusing another app.

## [1.0.0] - 2026-09-27

Phase 12: the first public release.

### Added

- **License**: GNU Affero General Public License v3.0 (AGPL-3.0-only).
- **README** for everyone, and **docs/INSTALL.md**: from a fresh Linux
  machine to a signed-in Burrow with its first host - behind your own
  reverse proxy, with Caddy, or to try it through an SSH tunnel
  (`compose.try.yaml`).
- **Releases**: the CI workflow builds the image on ghcr.io and attaches the
  signed APK to the GitHub release (with the signing key in the repository
  secrets). `make export-public` makes the public repository as one commit
  and checks it for anything private first (`scripts/check-public.sh`).
- **F-Droid**: store texts and screenshots (English and Dutch) in
  `android/fastlane`, the Gradle wrapper, a build from source without
  Docker, and a draft recipe for fdroiddata (docs/fdroid).

### Changed

- The app's version comes from `package.json` when the build is not given
  one, and a release build without the signing key's password is left
  unsigned instead of failing (F-Droid signs its own).
- Example names and addresses in tests and hints are generic.

### Verified

- **A fresh install on a clean virtual machine** (`make fresh-install-test`):
  a new Debian 13 VM (QEMU with KVM), Docker from get.docker.com, the public
  tree, docs/INSTALL.md followed step by step; Burrow healthy, the setup
  token in its log, the setup wizard (password and authenticator app, ten
  recovery codes), the machine itself as the first host with its key
  confirmed, its containers and its statistics read over SSH.
- The public tree carries nothing private (domain, addresses, paths, e-mail,
  keys, local settings).
- The app built from source with the Gradle wrapper, unsigned, with its
  version from package.json.
- The gate, the Android emulator test.

## [0.12.1] - 2026-09-27

### Added

- Help tips on the statistics page: what SMART needs on a host
  (smartmontools, and sudo with the stored password or a sudoers line for
  smartctl), and how the history is sampled.

### Verified

- The page tour taps every help tip on every page on a phone and checks
  that it opens and closes.

## [0.12.0] - 2026-09-27

Phase 11: users and roles, single sign-on, host statistics.

### Added

- **Users**: invite people by a one-time link as admin or **operator**
  (hosts, containers, logs, alerts, reports, files and statistics to look
  at; no shell, no changes). Change roles, remove accounts; one admin
  always stays.
- **Single sign-on** (OpenID Connect: Authelia, Authentik, Pocket ID,
  Keycloak): a sign-in button, invites accepted through the provider, and
  step-up through the provider. Only linked accounts get in; the first time
  an account is linked by its name or e-mail. In the Android app the
  sign-in stays in the app.
- **Host statistics**: CPU, memory, load, uptime, disks, temperatures,
  a history of a day to a month, and SMART of the disks through sudo; host
  alerts for a full disk, SMART trouble and heat.

### Changed

- The Containers tab: a red count only for new alerts, and a separate dot
  for image updates (they used to take turns in one count).

### Verified

- Unit: /proc and df output (also busybox, bind mounts, container roots),
  temperatures, SMART JSON of SATA and NVMe disks and what counts as
  trouble, user names from a provider's claim; Android: the sign-in stays
  in the app only while it lasts.
- Integration: invites and roles (an operator may read, and is refused
  shells, saves, commands, users, settings), the last admin; single sign-on
  against a test provider - unknown people refused, an invite accepted
  through it, linking by name, step-up (and not by someone else), back to
  the page it started on and never to another site; host statistics of
  the test host, history, a host alert, SMART without smartctl.
- End to end: single sign-on set up in Settings, an operator invited and
  joining through the provider, what the operator sees (no terminal, files
  read-only, a host's statistics), every page an operator opens loads
  without a refused request (this check found two), and signing in and
  being refused through the provider.

## [0.11.1] - 2026-09-27

### Added

- Alerts can be deleted: one with its bin, or all at once (*Delete all*).
  Rules and mutes stay.

### Changed

- On a phone an alert's buttons sit under its text, so the container name
  stays readable.

### Verified

- Integration: deleting one alert and all alerts. End to end: both from the
  Alerts tab, and an alert row checked for a readable title on a phone (it
  failed before the layout change).

## [0.11.0] - 2026-09-27

Phase 10: scheduled reports and all notification channels.

### Added

- **Notification channels**: ntfy (push), e-mail (SMTP), Discord and a
  signed webhook, each with what it gets (alerts, reports, image updates),
  its language and a test button. Passwords, tokens and webhook addresses
  are stored encrypted and never shown again. The push setting of 0.10
  became an ntfy channel for alerts.
- **Reports** (Containers -> Reports): per container over the period a
  status (problem, attention, ok) and why, the kinds of error marked new or
  again, what got resolved, a trend over earlier reports, and - for the
  containers that need a look - the language model's explanation and fixes.
  Sent to the channels for reports with a link to the report.
- **Schedules**: weekly, daily or a cron expression, in a time zone. A
  weekly report for everything is there from the start, off until switched
  on. *Make now* makes one at once.
- Image updates and rollbacks are sent to the channels for updates.

### Changed

- Rows with several buttons (schedules, channels) put the buttons under
  the name on a narrow screen instead of squeezing it.

### Verified

- Unit: cron and weekly/daily schedules in time zones, the status rules,
  new/recurring/resolved, the report summary in both languages, reading a
  period's logs, the e-mail (escaped).
- Integration with real services: ntfy, e-mail through Mailpit, Discord
  and a webhook (signature checked) each take a test message; a failing one
  says why; a report on the test stack (a crashed container is a problem,
  one full of errors needs attention, explanations only for those two) sent
  to every channel; the next report finds the errors recurring; a schedule
  runs once in its due minute; the old push setting moves to a channel.
- End to end: the phase criterion - channels set up in Settings, the weekly
  report switched on and made, and it arrives by push, e-mail and Discord
  and is in the app. The page tour checks that no row's title is cut off by
  its buttons (it failed on the first layout).

## [0.10.0] - 2026-09-27

Phase 9: AI log analysis, masking, log alerts.

### Added

- **Alerts**: a container that exits with an error, is killed for memory,
  turns unhealthy or keeps restarting raises an alert, on every Docker host,
  without setting anything up. Stopping a container yourself does not.
  Rules of your own: a pattern in the logs, or too many errors in a short
  time, per host, stack or container. Repeats within ten minutes are
  counted, not pushed again; containers can be muted. An *Alerts* tab next
  to Containers and Apps, and a red count on the Containers tab.
- **Push through ntfy**: to ntfy.sh or your own server, with a test button.
  The notification carries the container's last lines (masked); a tap opens
  the logs of that moment in the Android app (`burrow://` link) or the
  browser, and *Analyse* opens them with the analysis running.
- **AI log analysis** of the lines shown or the pinned ones, streamed in
  four parts (what is happening, problems, likely cause, fixes), through
  the provider in Settings, or Claude as a deeper analysis. Lines are
  grouped, errors first, and passwords, tokens, keys and e-mail addresses
  masked before they leave; IP addresses too for a model outside your
  network. Similar lines are sent once with a count: also lines that
  differ in a few words (a user name, a path), merged into one pattern the
  way Drain does, to save tokens. The container's state goes along.

### Changed

- The log page of one container is titled with its name.
- Burrow's own log is saved with the end-to-end test results.

### Fixed

- *Find in containers* (Apps) stayed on "Looking..." when two containers had
  the same address.

### Verified

- Unit: masking, templates and grouping, Docker events (a stop is no crash,
  restart loops), rule scope, the ntfy request, local vs external models,
  streamed bodies, the Markdown renderer (no HTML gets through), the
  Android `burrow://` links.
- Integration against real Docker and a real ntfy server: a crash pushed
  with its last lines and links, an unhealthy container, a stop that is no
  crash, a pattern rule with bundling and muting, the analysis (secrets
  masked, repeats grouped, errors first, the answer streamed).
- End to end: the phase criterion - a crash arrives through push, and the
  push's *Analyse* opens the analysis with a cause; push settings and the
  test message. Android: a notification link opens the page in the app; a
  link elsewhere does not.

## [0.9.3] - 2026-09-27

### Changed

- Text you can tap (*Check now*, *What is new?*, *Stage all*, *Manage on ...*)
  is underlined, so it reads as something to tap.

### Fixed

- Two fields side by side (the update window's start and length) did not
  line up when one label wrapped on a narrow screen.

### Verified

- The page tour checks that fields side by side line up and that tappable
  text is underlined; both checks failed on the old layout.

## [0.9.2] - 2026-09-27

### Added

- The daily update check and automatic updates can be turned off (Settings ->
  Container updates). *Check now* and *Update now* keep working.

### Changed

- A container's CPU and memory graphs are under its details (tap the status
  line), with the image; the logs get the room.
- Burrow's own stack shows no automatic-update option at all.

### Fixed

- The update count on the Containers tab was cut off.

### Verified

- End to end: the count on the tab is checked to be fully visible at
  desktop and phone width (this check failed before the fix); the setting
  turned off and on. Integration: a window that is off does nothing.

## [0.9.1] - 2026-09-27

### Changed

- A container's page is its logs: its actions (shell, restart, stop or
  start, inspect, stack, delete) and the log download are in one *Options*
  menu in the log bar, instead of rows of buttons above the logs.

### Fixed

- The help tip at *Image updates* on a stack's page sat below the title on a
  phone in Dutch.

### Verified

- The page tour also runs in Dutch on a 360 px phone, checks that help tips
  in headings sit beside their text, and that a container's logs start in
  the top part of the screen.

## [0.9.0] - 2026-09-27

Phase 8: managing containers and stacks, image updates.

### Added

- **Container actions**: a shell inside a container (as a terminal
  session), restart, stop, start, inspect and delete. Each asks for a fresh
  confirmation and is audited.
- **Stack page**: its services, pull, up, restart and down with live output;
  the compose file edited in the editor, then *Review and deploy*: the diff
  since Burrow last deployed it (or since you started editing), a check
  with `docker compose config`, and `docker compose up -d`. Operations run
  on the host apart from Burrow, so a lost connection does not break them
  off.
- **Image updates**: Burrow asks the registries (HEAD, no pull, not counted
  by Docker Hub) whether a tag points to a newer image; daily and with
  *Check now*. A count on the Containers tab, marks on rows and stacks, old
  and new digest per image, and *What is new?* with the image's GitHub
  release notes.
- **Automatic updates** per stack in a daily maintenance window (Settings ->
  Container updates): pull, recreate, watch for a minute, and put the
  previous image back when a container stops, keeps restarting or turns
  unhealthy. A history per stack. Not for Burrow's own stack.
- `UPDATE_CHECK_EXCLUDE` and `REGISTRY_ENDPOINTS` settings.

### Changed

- A checkbox's help tip stays beside it on a narrow screen (a long label
  wraps instead of pushing the tip down).

### Verified

- Unit: image references (Docker's rules), registry tokens and digests,
  rate limits, update decisions (current, update, pinned, local, pulled but
  not recreated), the window across midnight and in a time zone, judging a
  stack after an update, the compose and rollback scripts, release notes.
- Integration against real Docker and a test registry: stack info from the
  labels, compose check, deploy with output, one operation at a time,
  stop/start/inspect, a shell in a container, step-up; a newer image
  noticed and updated automatically, a broken one rolled back, the window
  once a day.
- End to end: the phase criterion (compose edited, diff, deployed with live
  output; an outdated image reported and updated automatically), release
  notes as text, a container shell; every page looked at at phone and
  desktop size, with a check for help tips below their checkbox.

## [0.8.0] - 2026-09-27

Phase 7: the workspace editor.

### Added

- **Workspaces**: a folder on a host as a project (Files -> folder menu ->
  *Open as workspace*; listed with the hosts and on the Files start page),
  with a file tree that shows git's status, files in tabs (remembered per
  device), and *Go to file* (Ctrl+P).
- **Search and replace across all files**, on the host with ripgrep (grep
  when there is none): case, regular expressions, results by file that open
  at the line; replace in all files found, each saved safely.
- **git**: changes, a diff per file, stage and unstage, commit, pull and
  push, on the host with its own git; asks once who commits when git on the
  host does not know.
- **Root's files with sudo**, after a step-up: open, edit and save (owner and
  permissions kept); asks for the sudo password when the host needs one.
- **nginx -t** for nginx configuration, inside a container you pick.
- **Favourite folders of all hosts** on the Files start page.

### Changed

- **Server logs say what happens**: one line per API call with route, status
  and the error's reason, sign-ins, changes and failures as lines of their
  own, SSH connections that fail, container monitoring and log streams.
  Health checks and page loads are left out.
- A clearer key icon for typing the stored password.
- Dropdowns have their own arrow, away from the edge.
- The editor's problem counts are compact (they wrapped on a phone), and the
  key bar's search button says it searches this file.

### Fixed

- A link to a log line marked every line with the same timestamp; it now
  marks exactly the linked line.
- *Go to file*: Enter typed before the list arrived did nothing.
- In the Android app, the help tip of *Allow screenshots* sat below the
  checkbox instead of beside it.
- Toggle buttons with only a symbol (Aa, .*, the replace arrows) had no name for screen
  readers.

### Verified

- Unit: search output (rg JSON, grep), replace with groups, paths kept
  inside the workspace, git status (branch, upstream, renames, sub-folder),
  quoting.
- Integration (test sshd with git, ripgrep and sudo): workspaces, the file
  list without node_modules, search (text, case, regex, bad regex), replace,
  git from "not a repository" to a commit with an identity, a push without
  a remote, sudo read and save (owner and mode kept) and a wrong password.
- End to end: the phase criterion (a folder as workspace, search across all
  files, a commit), quick open, replace, the diff, a root file through sudo,
  favourite folders; every page looked at at phone and desktop size.

## [0.7.0] - 2026-09-27

Phase 6: containers and logs, like Dozzle.

### Added

- **Containers** (bottom bar, with Apps as a second tab): every container of
  every Docker host, grouped by compose stack across hosts, with state,
  health, restarts, uptime or exit code, and live CPU and memory sparklines
  (sampled every 5 s while the page is open).
- **Logs**: one container, a whole stack, or any selection across hosts in
  one timeline ordered by Docker's timestamps, each source in its own colour.
  Live following that pauses when you scroll up; filters for level, stdout
  or stderr, source, text or regular-expression search and time range (live,
  since the last start, 15 minutes, 1 hour, 24 hours); JSON lines folded to
  their message; ANSI colours; pin lines, copy a link to a line (opens the
  logs around that moment), download; side by side on a wide screen.
- **Container details**: image, stack and compose file, created and started,
  exit code and OOM, CPU and memory.
- **Android app: allow screenshots** (Settings -> Android app): off by
  default, as before.

### Verified

- Unit: the inspect/stats parsers on real Docker 29 output (also a
  container without a healthcheck), sizes, the log command and targets,
  line splitting across chunks, level detection (JSON, pino, key=value,
  tags), timestamp ordering, ANSI to HTML (escaped).
- Integration against the real docker CLI and a throwaway stack: state,
  compose labels, stats, a growing history over the socket, following two
  containers (stdout and stderr), a missing container, bad names refused.
- End to end: one stack over two hosts, sparklines that move, the merged
  timeline in order and growing, level/stream/regex filters, a permalink
  that opens with the line marked, container details with "since start".
- Emulator: containers and merged logs in the app, the screenshot setting.
- All screens looked at at phone and desktop size and in the app.

## [0.6.1] - 2026-09-27

### Fixed

- **"Transfers done" no longer stays on screen.** When all transfers finish
  without errors the list closes by itself after a few seconds; a failed one
  stays until it is seen.
- **Files shared into Burrow show up at once.** After *Share -> Burrow* the
  folder on screen said "This folder is empty" until it was refreshed.
- **The direct terminal can be left again**, with the back button and with
  *Close this session*: its page had no dialog handler, so the "close?"
  question was answered "no" without being asked.
- **App tabs can be closed**: each tab has a close button; closing the last one returns
  to Burrow.
- **The app's own screens look like Burrow**: the server-address screen, the
  lock and "cannot be reached" screens and the app-tab bar use Burrow's
  colours (light/dark and the accent chosen in Burrow), and questions from
  Burrow's pages appear as plain dialogs without "The page at ... says:".
- **One place for the direct route** in *Settings -> Android app*: which hosts
  each phone may reach ("Choose hosts"), and in the app the way in.
- **Long-press on the app icon** offers the direct route (and favourite
  hosts); checked on the emulator.
- The share page had no space between the file and the host field.

All reported on the phone, or found in a walk through every screen.

### Verified

- A walk through every screen, looked at: Playwright screenshots of all
  pages at phone and desktop size, and emulator screenshots of every app
  screen (setup, sign-in, share, file menu, app tab, settings, "cannot be
  reached", direct route list, terminal and leave dialog).
- New automatic checks from those findings: list titles and subtitles never
  on one line; the transfers list goes away; the shared file appears in the
  folder; the setup screen refuses http:// with a message; an app tab closes
  with its close button; the direct terminal is left with back and with the menu, and
  its dialog has no technical header; the direct-route shortcut is published;
  the direct route is opened from the "cannot be reached" screen.

## [0.6.0] - 2026-09-27

Phase 5: the direct SSH route in the Android app.

### Added

- **Direct route.** When Burrow cannot be reached (WireGuard off, server
  down), the app connects to your hosts by itself: *Direct route* on the
  app's error screen or on its icon (long-press). Same terminal as in Burrow
  - key bar, compose box, completion from your history and snippets and for
  about fifty common commands - but not persistent and without the AI. A
  badge says which route a terminal takes ("via Burrow" or "Direct").
- **The phone's own SSH key**: ECDSA P-256 in the Android Keystore, never
  leaves the phone, and needs a fingerprint (or the screen lock) right
  before each login. See ADR 8 for why not ed25519.
- **Choose the hosts per phone** under *Settings -> Android app -> Direct
  route* (admins, with step-up): Burrow adds the phone's key to
  `authorized_keys` on the ticked hosts and removes it from unticked ones,
  and from all of them when the phone is unpaired (hosts it cannot reach are
  reported).
- **Offline cache** for the app: the direct hosts with the host keys Burrow
  trusts (the app applies the same rule: a changed key is a hard stop),
  snippets and history, encrypted on the phone.

### Changed

- The terminal (xterm, suggestions, compose box, key bar) is its own
  component, shared by Burrow's sessions and the direct route; the shell
  integration's marks are read by shared code on the server and the phone.
- The test sshd has OpenSSH's per-source penalties off: the readiness probes
  and the deliberately failed logins made later tests flaky.

### Verified

- Unit: the phone key's format check, the `authorized_keys` marker, the
  cache (only the direct hosts, no credentials, only for the paired app),
  the shell-integration parser.
- Integration (test sshd): the phone key is refused, installed on a host
  that had no `authorized_keys` yet, logs in on its own, and is gone again
  after unpairing.
- Android JVM tests: the OpenSSH key encoding, fingerprints, the host-key
  rule, the encrypted cache (fresh nonce, tampering detected).
- Android device test (API 35 emulator): after the phase-4 steps, the app
  reports its key, Burrow installs it on the host, the app fetches its
  cache; then **Burrow and its proxy are stopped** and the app opens a
  terminal on the host over the direct route and runs a command there. This
  test caught keystrokes overtaking each other on the way to the host
  (fixed before release: they now go out strictly in order).
- End to end (Playwright) still passes after the terminal was split up.

## [0.5.0] - 2026-09-26

Phase 4: the Android app, and app tabs.

### Added

- **Android app** (`android/`, Kotlin): Burrow in a WebView, locked behind
  the fingerprint (or screen lock) at start and after five minutes away,
  with screenshots blocked. Edge to edge, the keyboard pushes the page up;
  hardware keyboards type into the terminal.
- **Sign in with your fingerprint.** Pair the app once with a one-time code
  from Settings on a signed-in device (or, signed in with your password in
  the app, with one tap). The app keeps a key in the Android Keystore that
  only works after your fingerprint; it signs you in and confirms sensitive
  changes. Passkeys cannot work in the app on a LAN-only address; see ADR 7.
  Paired phones are listed under Settings and can be unpaired.
- **Files to and from other apps:** share any file to Burrow and pick the
  host and folder; *Open with...* on a file, and when it was edited there,
  Burrow offers to upload it back; *Share...*; downloads go to Downloads.
  Transfers keep running with the screen off (a notification shows them).
- **Host shortcuts** on the app icon: favourite and recent hosts.
- **Apps** (new tab in the bottom bar; *Snippets* moved to Settings and the
  terminal's snippet button): web apps next to the shell. Add them by hand or find them in
  the `swag_url`, Traefik `Host()` and `homepage.*` labels of running
  containers. In a browser an app opens inside Burrow when it allows being
  framed (checked by the server; only those origins are allowed in
  `frame-src`), otherwise in a new tab. In the app every app opens in its
  own tab with its own cookie jar, so it stays signed in.
- **APK download** under Settings for signed-in users; `make apk` builds,
  signs and publishes it, `make apk-keystore` makes the signing key once.
- `assetlinks.json` when `BURROW_ANDROID_CERT_SHA256` is set (for later).

### Fixed

- **Files: host name and address ran together** ("Debian10.0.0.20") in
  the host picker; they are on two lines again, as in every other list.
- **"step up required" after confirming with a passkey.** Two requests that
  needed a confirmation at once (a double tap on a host, for one) each
  opened the dialog; the second cancelled the first, which then failed even
  though the passkey was accepted. They now share one confirmation.
- **The bottom bar is centred.** A long label ("Instellingen") took more
  than its fifth and pushed the tabs to the right; all five are now equally
  wide.

All three reported on the phone.

### Verified

- Unit: pairing codes (single use, expiry, step-up), device-key sign-in and
  step-up (replay, wrong key, wrong device), unpairing revokes sessions;
  label discovery, the frame check, icon fetching, the dynamic CSP and the
  inert icon response; APK download only for signed-in users.
- Integration: discovery against the test sshd's (fake) Docker containers.
- End to end (Playwright): an app that allows framing opens inside Burrow
  (also when added a moment ago: the page reloads once for the new
  `frame-src`), one that does not opens a new tab; discovery lists the
  containers' apps; a pairing code is shown; on the phone viewport the five
  tabs are equally wide in English and Dutch.
- Android JVM tests: origins, what the key may sign, file names, the bridge
  protocol, reading held files in pieces.
- Android device test (API 35 emulator, the production image behind a TLS
  proxy): the lock, pairing with a code, signing in with the device key,
  a shared file uploaded to a host, *Open with* bringing an edit back, and
  an app tab with its own cookies that stays signed in.

## [0.4.2] - 2026-09-26

### Fixed

- **Error messages show above an open menu.** A connection error opens the
  host menu, a modal dialog, and a modal dialog covers everything regardless
  of z-index; the message ended up behind it. Toasts are now a popover in the
  browser's top layer and are raised again whenever a dialog opens.
- **The compose box stays one line high when empty.** The placeholder wrapped
  onto two lines on a narrow phone and the box grew to fit it. An empty box
  is now always one line, the placeholder is cut off with an ellipsis, and it
  is shorter ("Command...").

Both reported on the phone.

### Verified

- Playwright on the phone viewport: a host without a key, tapped, opens its
  menu and the error toast is open in the top layer above it; the empty
  compose box with an over-long placeholder is as tall as its send button.

## [0.4.1] - 2026-09-26

### Fixed

- **The compose box is as tall as the buttons beside it.** It sized itself
  with CSS `field-sizing`, which Firefox on Android does not support, so a
  single line came out taller than the send buttons. One line is now exactly
  40 px; more lines grow the box up to a third of the screen. Reported on the
  phone.

### Verified

- Playwright on the phone viewport (Chromium) checks that the empty box and
  the send button have the same height. Firefox itself cannot run the test
  suite (the virtual passkey needs Chromium); the fixed height no longer
  depends on the browser.

## [0.4.0] - 2026-09-26

Phase 3: file management over SFTP and the editor with language servers.

### Added

- **Files** (new tab): browse any host, breadcrumbs, list or grid (with image
  thumbnails), hidden files, sorting, bookmarks per host and recent folders
  per device, search by name, folder size (`du`). Symlinks show their target.
- **Everything a file manager does on a server:** new file or folder, rename,
  copy/cut/paste - also **between hosts**, streamed host to host with tar
  through Burrow - delete (confirmation and step-up), properties with a
  permission grid, chown, recursive changes, zip/tar.gz archives and
  extracting them.
- **Transfers**: chunked uploads that resume after a dropped connection, and
  a drawer with progress for uploads and background copy jobs. Downloads, and
  images, video, audio and PDF opened in the browser, streamed with HTTP
  ranges.
- **Editor** (CodeMirror 6): syntax for YAML, JSON, Shell, Dockerfile, TOML,
  Python, nginx, INI and .env; **language servers** in the container for YAML
  (with the Compose schema, offline), Bash (with ShellCheck and shfmt),
  Dockerfile, JSON, TOML (taplo) and Python (ruff); **hadolint** for
  Dockerfiles; *Check with docker compose* runs `docker compose config` on the
  host with the unsaved text. Problems inline and in a list, formatting,
  completion, hover, a key row for phones.
- **Safe saving**: a temporary file renamed over the original in one step,
  permissions kept; if the file changed on the host since it was opened,
  Burrow shows the difference and asks.
- **Terminal here** from a folder and **Files in this directory** from a
  terminal.
- **Compose box** in the terminal (optional, per device): type a command in a
  normal text box - with the keyboard's autocorrect, suggestions and voice
  input - and send it whole with the send button. Suggested by the user.

### Changed

- The bottom bar is Hosts, Terminal, Files, Snippets, Settings; the key vault
  moved into Settings.
- The Ollama timeout is 200 s (was 120 s) for slow first answers.
- The container image grew to about 630 MB with the language servers,
  linters and completion specs.

### Security

- A file from a host is never shown as a page in Burrow's origin: only
  images, audio, video, PDF and plain text open inline, with `nosniff` and a
  sandboxing Content-Security-Policy; everything else downloads.
- Recursive delete, chown and similar refuse `/` and the home directory.
- Language servers and linters run on the text the editor sends; host files
  are not copied into the container.

### Verified

- Integration against two OpenSSH hosts: listings with owners and links,
  create/rename with clash detection, atomic save keeping the mode and
  detecting a conflict, ranged downloads and the inline/download split,
  resumable chunked upload, copy within a host and **a folder from host A to
  host B** (permissions kept, clash reported), move between hosts, zip and
  tar.gz round trips, du, search, delete guards and step-up, bookmarks.
- In the built image: all six language servers start and report - a Compose
  schema error, ShellCheck SC2086, JSON, Dockerfile, TOML and Python errors.
- Playwright: a Compose error and a ShellCheck finding inline in the editor,
  hadolint DL3008, an upload, a save conflict resolved from the diff, a folder
  copied from host A to host B through the UI, the compose box on a phone.

## [0.3.2] - 2026-09-26

### Fixed

- **Scrolling the key bar no longer presses a key.** Keys acted as soon as a
  finger touched them, so the key where a swipe started was typed. They now
  act on a tap; a swipe to scroll is not one. Reported on the phone.

### Verified

- Playwright on the phone viewport: a touch that the browser cancels (as it
  does when a swipe starts scrolling) leaves Ctrl untouched; a tap toggles it.

## [0.3.1] - 2026-09-26

### Fixed

- **Sections that open and close look like buttons.** *Completion and
  history* in the host menu and *Advanced* in the host form were plain text;
  they now have a button's border and a chevron that turns when open.
- **Space between the suggestions and the key bar.** The chips touched the
  keys below them.

Both reported on the phone.

### Verified

- Playwright checks the border of the section opener and at least 8 px
  between the suggestion chips and the key bar.

## [0.3.0] - 2026-09-26

Phase 2: auto-complete and AI text-to-command.

### Added

- **Suggestions above the keyboard** while you type at a prompt: whole
  lines from the host's history, subcommands, options and arguments from the
  open-source Fig completion specs (hundreds of CLIs: docker, git, systemctl,
  apt ...), values the host itself provides (container names via `docker ps`,
  git branches ...), paths and snippets. A tap types the rest; Tab still goes to
  the shell.
- **Shell integration** (host menu -> *Completion and history*): a small script
  in `~/.burrow`, sourced from `~/.bashrc`/`~/.zshrc`, reports the prompt, the
  current directory and each command (OSC 133 / OSC 7 plus Burrow's own
  sequence), also through tmux. Without it completion still works from the
  prompt shape and is marked *limited*.
- **History per host**, encrypted, counted by frequency and recency. Commands
  starting with a space are never stored, nor anything that looks like a
  secret (passwords, tokens, keys; see the fixture in the tests). Without the
  integration only lines the terminal echoed are stored, so a password typed
  at a sudo prompt never is. Import `~/.bash_history` / `~/.zsh_history`,
  forget one command or clear a host's history.
- **AI: text to command.** Type `# largest folders in /data` or tap the sparkle button: the
  suggested command is put on the input line with an explanation and a risk
  label - never run. Burrow's own rules (rm -rf, dd, mkfs, chmod -R, ...) can
  raise the model's label but never lower it.
- **AI providers** (Settings -> AI): Ollama (local, the default choice), Claude
  via the Anthropic API (`claude-sonnet-5` by default), or any
  OpenAI-compatible server. Only the question and host context (OS, shell,
  Docker yes/no, directory) are sent - never host names, addresses or
  terminal content. API keys are stored encrypted and never shown again.

### Fixed

- Inside tmux, the shell integration's prompt marker printed a stray `]`
  (PS1 treated the backslash of the escape sequence as an escape). Found by
  the end-to-end test before release.

### Verified

- Unit: completion engine against the real Fig specs (`docker lo` -> `logs`,
  then container names from the generator; options, paths, sudo, ranking by
  history), prompt/input detection, secret filter, frecency, history file
  parsing, risk rules, and the three AI providers against stand-in servers
  (Claude through the official SDK with structured output).
- Integration against OpenSSH + tmux: installing and removing the
  integration, prompt/directory/command reporting in plain and tmux sessions,
  space-prefixed commands not stored, generators and SFTP listings on the
  session's connection, typed-line fallback that never stores an unechoed
  password.
- Playwright: install the integration from the UI, `docker lo` -> logs ->
  radarr -> run; the command comes back as a history suggestion; `# question`
  -> AI -> command on the line, not run; a destructive answer labelled high.

## [0.2.2] - 2026-09-26

### Fixed

- **Help tips stay on screen on a phone.** A tip was centred on its `?`
  button, and next to a field that button sits at the right edge, so the text
  ran off the screen. Tips are now placed within the screen, and above the
  button when there is no room below. Reported on the phone.

### Verified

- Playwright on the Pixel 7 viewport opens every help tip on the Settings
  page and checks that it lies within the screen.

## [0.2.1] - 2026-09-26

### Fixed

- **Backspace from an Android soft keyboard.** GBoard and similar keyboards
  send Backspace (and sometimes Enter) as an input event instead of a key
  press; xterm.js ignored it when there was nothing in its hidden text field,
  so Backspace often did nothing. Burrow now turns those events into the
  right keys. Autocorrect, capitals and suggestions are also switched off on
  the terminal's input. Reported on the phone.

### Added

- **Key combinations in the key bar**: `shift+tab`, `ctrl+c`, `alt+bs`,
  `ctrl+left` and so on, plus `bs`, `del`, `ins`, `space` and `f1`-`f12`.

### Verified

- Unit tests for every combination type (back-tab, control characters, Alt
  prefix, xterm modifier parameters for cursor and edit keys, literals).
- Playwright on the phone viewport: a soft-keyboard Backspace (a
  `beforeinput` event, as GBoard sends it) deletes the last character.
- Not verified on a real phone keyboard yet.

## [0.2.0] - 2026-09-26

Phase 1: the persistent terminal.

### Added

- **Persistent terminal sessions.** The server owns the SSH connection, the
  PTY and a headless xterm that mirrors the screen. Closing the tab or
  locking the phone leaves the session running; opening it again, from any
  device, shows the exact current screen. Only *Close session* or `exit`
  ends it.
- **tmux mode** (default when the host has tmux): the shell runs in tmux on
  Burrow's own tmux server (`tmux -L burrow`), so it also survives a restart
  or update of Burrow, and your own tmux sessions and `~/.tmux.conf` are not
  touched. Without tmux the session lives in Burrow's memory and is marked
  "lost on restart".
- **Several devices at once.** The device that last typed or focused the
  terminal sets the size (tmux's `window-size latest`); the others follow and
  are told so. The session list shows every session with host, start time,
  last activity and the connected devices.
- **One tap connects.** Tapping a host opens a terminal or returns to its open
  session; long press, right click or the three dots open the host menu. Enter in the
  search connects to the best match.
- **Tabs** for open sessions, a horizontal swipe to switch, and a full-screen
  terminal on phones.
- **Mobile key bar** (Esc, Tab, sticky Ctrl/Alt, arrows, `| ~ / -`), set per
  device in Settings; pinch to zoom, text size in Settings.
- **Type stored password**: the key button in the terminal types the host's
  stored password (for sudo prompts) without Enter. The server types it; the
  password never reaches the browser. Audited, without the password.
- **Snippets**: saved commands, global or per host or group, with
  `{{variables}}` filled in before use. Run or paste in the terminal, or run
  on several hosts at once with the output per host.
- **Help tips**: a tappable `?` next to settings explains them briefly.
- Limits: at most `TERMINAL_MAX_SESSIONS` sessions (default 20), and
  optionally `TERMINAL_IDLE_MINUTES` to close unwatched idle sessions. Opening
  and closing sessions are audited; their content never is.

### Fixed

- Generating an ed25519 key failed about once in 200 attempts: ssh2 sometimes
  produces a key with a truncated public half. Keys are now checked (parse,
  length, sign/verify) and regenerated. No broken key was ever stored.

### Changed

- Opening a new terminal session needs a fresh step-up; returning to an open
  one does not.
- Signing out or revoking a device now also closes its terminal connections
  at once; the sessions keep running.

### Verified

- Unit tests for the tmux scripts (own tmux server, quoting of the startup
  command), the key bar and sticky modifiers, snippet variables and the
  WebSocket message schema.
- Integration tests against OpenSSH + tmux: two viewers share a shell and a
  late viewer gets the current screen; ownership of the size moves to the
  device that typed; `exit` ends a session; signing out closes the sockets
  but not the shell; a tmux session survives a restart of Burrow and is
  re-attached with its old output, and an explicit close removes it from the
  host; the stored password is typed without Enter and not logged; commands
  run on several hosts with exit codes; WebSockets from another origin or
  without a session are refused; a new session needs step-up.
- Playwright: a laptop and a phone (Pixel 7) in the same session, each seeing
  what the other types; closing the laptop tab and opening it again shows the
  same screen; Ctrl from the key bar interrupts a command; a snippet with a
  variable runs on a host and in the terminal.

## [0.1.1] - 2026-09-26

### Fixed

- **Installing a key now confirms that it worked.** The install already
  proved the key by signing in with it, but the sheet showed the same
  "Connected" line as an earlier connection test, so nothing visibly changed.
  It now says which key was installed and that Burrow signed in with it.
  Reported on the first real deployment.
- **Sheets and dialogs can be closed on a phone.** They only closed with Esc,
  which a phone does not have. There is now a close button in the header, and
  a tap on the backdrop closes them too.

### Changed

- **Buttons follow one width rule.** Every action button in a page or dialog
  spans its column; only trailing actions in a list row are compact and the
  buttons in a dialog footer share the row. Before, full-width and inline
  buttons were mixed from page to page.

### Added

- **Appearance settings:** theme Auto (follows the system) / Light / Dark and
  six accent colour presets. Stored per device.
- After a key install, the sheet offers to remove the stored password that
  is no longer needed (`DELETE /api/hosts/:id/password`, step-up, audited).

### Verified

- Unit test for the new endpoint; the e2e flow now checks the install
  confirmation, removes the password and connects with the key alone. The
  phone e2e test closes the host sheet with the close button and with a tap
  on the backdrop, and checks on the Keys and Settings pages that every
  content button fills its column. The desktop test switches theme and
  accent and checks both survive a reload.
- The original report checked against the audit log of the live instance:
  both installs had succeeded (`host.install_key`, followed by a key login
  that refreshed the host facts).

## [0.1.0] - 2026-09-26

Phase 0: the foundation. Nothing connects to a terminal yet; everything a
terminal will need is in place.

### Added

- **Setup wizard.** A one-time token printed in the container log claims the
  instance; the admin registers a passkey or a password + authenticator app
  and receives ten recovery codes. An abandoned setup is discarded on the
  next attempt.
- **Sign-in.** Passkeys (discoverable, user verification required), password
  + TOTP (TOTP is mandatory once a password is used; codes are never accepted
  twice), recovery codes (single use). Server-side sessions in a `__Host-`
  cookie, 7 days idle / 30 days absolute, revocable per device.
- **Step-up.** Changing hosts, keys, trust or login methods needs a passkey or
  TOTP confirmation within the last 15 minutes.
- **Brute-force protection** per IP and per account: growing delay, a
  15-minute block after 10 failures, recorded in the audit log.
- **Audit log** of sign-ins, failures, step-ups and every configuration
  change (no secrets, no terminal content).
- **Hosts** with nested groups that pass down defaults (user, port, key,
  startup command, tmux, TERM, encoding), tags, colours, favourites, fuzzy
  search, copy, and a green/red reachability dot (TCP check every 60 s).
- **Key vault.** Generate ed25519 keys or import existing ones (with
  passphrase); private halves are encrypted with AES-256-GCM and never leave
  the server. *Install key on host* does what `ssh-copy-id` does.
- **Trust on first use.** The first connection shows the host-key
  fingerprint; trusting re-fetches the key and stores it only if it matches
  what you saw. A changed key is a hard block.
- **Connection test** that detects OS, shell, tmux and Docker access.
- **Import from `~/.ssh/config`** with wildcard defaults, key matching by
  IdentityFile name and duplicate detection. `Match exec` is never executed.
- English and Dutch UI.
- Encrypted backups (optional `backup` profile) with an off-device second
  copy, a verify script and a restore script.
- The gate (`make gate`), pre-push hook and CI workflow.

### Verified

- Unit tests (auth flows, step-up, throttling, sessions, crypto, groups,
  vault, importer): `make test`.
- Integration tests against a real OpenSSH server in a container: TOFU,
  mismatch block, password and key login, key installation (idempotent,
  correct permissions), unreachable host: `make test-int`.
- Playwright end to end on desktop Chrome and a Pixel 7 viewport against the
  hardened production image: setup with a (virtual) passkey, sign-in, groups,
  hosts, search, trusting a host, installing a key, import, language switch,
  sign-out: `make e2e`.
- Backup round trip on a live instance, wrong key refused:
  `scripts/test-backup.sh`.
- Not yet verified on the author's deployment with a real phone passkey or
  against a second host.
