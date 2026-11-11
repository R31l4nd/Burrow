# Using Burrow

## Hosts

The start page is the host list: favourites and recently used hosts first,
then your groups. Search matches name, address, tags and group, forgiving
typos; <kbd>Enter</kbd> opens the best match.

A **group** hands its settings down: set the user, port, key or tmux
preference once on the group (*New group* on Hosts, or the group's menu
there) and every host inside inherits them. A
host can override any field; the form shows what it would inherit and
from where. Above every group is *All hosts* (Settings -> All hosts): what
every host gets when neither it nor one of its groups sets a field, such as
your usual user and key.

Tap a host to open a terminal (see below); long-press or the three dots for the menu.

**Wake-on-LAN**: a host that is down and whose MAC address Burrow knows
(learned while it was up, or set in the host's *Advanced* settings) has
*Wake up* in its menu. Who sends the packet is chosen there too (*Wake-on-LAN
from*): a host that is up (one on the same network first, the default), one
host always, or Burrow itself. Burrow itself reaches your LAN only when its
container runs with `network_mode: host` or on a macvlan network; in
Docker's usual bridge network the packet never arrives.

A number with an arrows icon beside a host: package updates waiting (red
with security updates among them); its statistics page says which.

## Terminal

Tap a host to open a terminal, or to return to the session that is already
open for it. The first time, Burrow shows the host's key fingerprint at once:
check it, then *Trust and connect* opens the terminal. Long press (or the three
dots) opens the host menu: new session, test the connection, install a key, edit.

- Sessions keep running when you close the tab or lock the phone. Open them
  again from any device - laptop and phone can use the same session at once.
  The device that typed last sets the terminal size.
- With tmux on the host, sessions also survive a restart of Burrow. Without
  it the session shows *lost on restart*; `sudo apt install tmux` fixes that.
  Burrow uses its own tmux server; join a session from a normal SSH login with
  `tmux -L burrow ls` and `tmux -L burrow attach -t <name>`.
- On a phone the bar above the terminal is the compact one, with or without
  the keyboard, so nothing changes size when it comes or goes; the row of
  labels under it shows only for a warning (connecting, another device's
  size, more devices); whether a session is lost on restart the session list
  says. The terminal keeps its rows while the
  keyboard is up and shows the part with the cursor.
- Swipe left or right on the terminal to switch sessions; pinch to zoom.
- On a wide screen *Panes* (the split button) shows up to four open
  sessions side by side (two on a medium screen); the layout is kept on
  each device. A pane can take the whole terminal and go back. Drag a tab
  to change the order. *Type in all terminals shown* sends every key to
  each pane at once, for the same command on several hosts; a red bar says
  so until you stop it.
- One finger down the terminal opens the history layer: the session's
  history at once, scrolled by the phone itself; typing or *Back to live*
  closes it. In a tmux of your own (`tmux attach`, in Burrow's tmux or in
  a session without it, its mouse on or off) it is that tmux's history.
  A program on a full screen of its own (vim, less, Claude Code) gets the
  finger instead: as its wheel when it takes the mouse, else as arrow
  keys. Claude Code's full screen keeps no history in tmux, so the finger
  scrolls Claude Code's own view. Two fingers side by side (on a
  computer: Shift + the wheel) scroll Burrow's own, including what was on
  screen before the program started.
- Hold a finger on a word to select it, drag to take more; the bar that
  appears copies it, selects everything or pastes.
- The screen stays on while a terminal is open, and a terminal bell makes
  the phone buzz.
- The key bar above the keyboard has Esc, Tab, Ctrl, Alt and arrows. Ctrl and
  Alt stick until the next key. Change the keys under *Settings -> Terminal*:
  names such as `esc`, `bs`, `del`, `pgup`, `f5`, or combinations such as
  `shift+tab`, `ctrl+c`, `alt+bs`, `ctrl+left`.
- The key button types the host's stored password at a sudo prompt; press
  Enter yourself. Not while the session is shared or recorded: away from a
  prompt that hides it, the password would show on the screen.
- *Close session* in the session menu (three dots, *Sessions and more*) ends the shell for everyone.
  Removing a person (or making an admin an operator) ends their sessions
  too, tmux on the host included.
- *Name this session* in the same menu gives it a name of its own, shown on
  its tab and in the session list; empty, it is the host's name again.
- *Share to watch* in the same menu picks Burrow users (an operator too)
  who may watch the session as it happens, read-only: it is on their
  *Hosts* page under *Shared with you*, and nothing they type goes to it.
  Taking someone off the list stops their view at once. There are no links:
  only people who sign in to this Burrow.
- *Record this session* records what the screen shows from then on (not
  the keys typed), until you turn it off or the session ends; everyone
  watching sees a red *Recording*. *Settings -> Recordings* plays them back
  (faster if you like), downloads them as asciicast (`asciinema play` plays
  them too) and removes them; they are kept 30 days unless an admin sets
another time there (*Keep recordings for*). A recording holds what
  was on the screen, a secret printed there included.
- *Search in the output* (Ctrl+Shift+F on a computer) searches what the
  terminal shows, its scrollback included. Enter and Shift+Enter go to the
  next and previous match, Esc closes the search.
- Burrow's own tmux has no prefix key and no status bar, so a tmux of your
  own works inside it: `tmux` starts one, `tmux attach -t main` (typed, or
  as the host's start command) takes up a session you started over plain
  ssh, and `tmux ls` or `tmux kill-server` act on your tmux, never on
  Burrow's (in Burrow's tmux, `$TMUX` names your own default server). A
  `.bashrc` that starts tmux only when `$TMUX` is empty starts none there.
  When tmux refuses ("sessions should be nested with care"), the shell
  already runs in a tmux of your own (started earlier there, or by the
  host's `.bashrc`); Burrow says so.
- Claude Code can draw the first key typed after a pause one column to the
  left, over the space after its prompt, where backspace does not reach it
  (anthropics/claude-code #78737). What it received is right; the stray
  character is only on the screen, and goes when Claude Code draws its
  screen again (Ctrl+L).
- On a computer, `?` (outside a text field) shows every keyboard shortcut;
  so does *Settings -> Keyboard shortcuts*.

## Snippets

Saved commands under Settings -> *Snippets* (admins), available on all hosts, one group or one
host. Write `{{name}}` for a value you fill in each time, `{{name=value}}`
for one that starts with a value, `{{name=a|b|c}}` for a choice and
`{{name=}}` for one that may stay empty. `{{container}}` offers the running
containers of the host(s) to pick from. In the terminal the
snippet button runs or pastes one; in Settings -> Snippets *Run on...* runs it on
several hosts at once and shows each host's output.

*Typed often* above them lists commands typed at least three times in
Burrow's terminals (all hosts together), leaving out what is quicker to type
than to pick (one word, `cd`, `ls`). *Save as snippet* opens the form filled
in (for the one host it was typed on, or all hosts); the X stops suggesting
it, and completion keeps offering it.

## Scheduled commands

Settings -> *Scheduled commands* (admins): a command that runs by itself on
chosen hosts, weekly, daily or by a cron expression in a time zone you pick
- a backup, a clean-up, a check. It runs as each host's own user, in bash
(else sh), also when nobody is signed in. `sudo` works only where it needs
no password (`sudo -n`; a sudoers line with `NOPASSWD` for that command):
nobody is there to type one. A time limit (10 minutes unless you set
another) stops it. Each run per host is kept 30 days with its output (the
last 64 KB): the row's menu has *Run now* and *Runs and output*. A run that
fails or is stopped marks the row and raises a *Host health* alert, with the
command's name. Making, changing, running now or deleting one asks you to
confirm it is you, as other actions on a host do.
## Auto-complete and history

At a prompt, suggestions appear above the keyboard: earlier commands on this
host, subcommands and options, values from the host (container names, git
branches ...), paths and snippets. Tap one to type the rest.

For exact results install the **shell integration**: host menu -> *Completion
and history* -> *Install shell integration*. It takes effect in new sessions
(or run `. ~/.burrow/shell-integration.sh`). Without it the terminal shows
*limited completion*.

Burrow keeps a history per host. Commands that start with a space are never
stored, nor lines that look like they contain a password or token. The same
menu imports `~/.bash_history` and clears the history.

## AI: from question to command

Type `#` and a question at the prompt (`# largest folders in /data`) and tap
*Ask AI*, or use the sparkle button. Your question is shown first, to change
or send (*Suggest a command*): nothing leaves Burrow before that. Burrow then
shows a command, what it does and a risk label, and puts it on the input line
when you choose - it never runs it. The dialog is a conversation kept with
the terminal session (also after closing it, or on another device; at most
20 turns, gone when the session ends): a follow-up such as "make it
recursive" or "why?" goes with the last four turns, masked, and any earlier
suggestion can be put on the line again or copied.

Set up a provider under *Settings -> AI*:

- **Ollama** (local): the URL of your Ollama server, e.g.
  `http://ollama:11434` when it runs as a container on the same Docker
  network, then *Load available models*.
- **Claude**: an API key from console.anthropic.com. The API is paid per use
  and separate from a Claude Pro or Max subscription.
- **Gemini**: an API key from Google AI Studio (aistudio.google.com/apikey),
  then *Load available models*. Burrow talks to Google's OpenAI-compatible
  endpoint of the Gemini API. On the free tier Google may use what is sent
  to improve its products and people may read it; with billing on for the
  key's project it does not. What leaves is masked as for Claude.
- **OpenAI-compatible**: any server with `/v1/chat/completions`.

## Files

*Files* shows any host's file system. Tap a folder to open it, a file to open
it (text in the editor, images in a gallery, video and audio streamed, PDF in
the browser). Long press selects; the three dots open the menu for one item; the three dots at the
top is the folder menu (new, upload, hidden files, sort, grid, folder size with how many files and folders it holds,
terminal here). Files dragged from the computer onto the list go into the
folder shown, onto a folder's row into that folder (admins). The list is
read again by itself when you come back to the page and every 10 seconds
while it is in view, so a file made in a terminal shows up without a
reload.

Copy or cut, go to another folder - on the same host or another - and tap
*Paste here*. Copies between hosts go straight from host to host through
Burrow; big ones run in the background (see the transfers pill at the top).
Afterwards every file's sha256 is compared on both hosts: the transfer says
how many files matched, and a file that differs fails it (a move then keeps
its source). A host without `sha256sum` or `shasum` is said too ("not
checked"). Uploads resume by themselves after a dropped connection. An
upload over a name that is there already asks *Replace* or *Keep both*
(the new one as "name (1).ext").

A file only root may change but anyone may read opens read only, with
*Edit with sudo*; a save refused for want of permission offers *Save with
sudo* (the host's stored password is used, or asked in place). A change
made meanwhile is still a conflict either way.

### The phone's own files (Android app)

In the Android app *Files* also shows *This phone* above the hosts (a
browser does not). Burrow sees only the phone's folders you add there, each
picked in Android's own folder picker, unless you switch on *All files*
(below):

- *Documents* (the phone's Documents folder, or a folder in it),
  *Downloads* (a folder in Download: Android does not hand out the whole
  Download folder, nor the top of the phone's storage) or *Another folder*
  (anywhere on the phone or its memory card). Android asks you to allow
  access; the app needs no storage permission of its own.
- Tap a folder to open it, a file to open it with Burrow's own views: text
  in the editor (saved back to the phone; changed meanwhile by another app,
  you see the difference first), pictures in the gallery, a file's menu
  *Open as log* in the log view (filters and search; nothing of it goes to a
  model). PDFs, videos, music and archives open in the phone's own app;
  *Open in another app* in the menu does that for any file. *Open read
  only* opens a text file without saving. Text files open up to 5 MB,
  pictures up to 30 MB.
- *Copy to a host* (a file's menu, or long press to select several): pick
  the host and folder, and they upload like files shared from another app.
  In a host's folder, a file's menu has *Copy to this phone*: pick one of
  the phone's folders and the app downloads it there (its progress in the
  notification); a file of the same name stays, the copy gets a new name.
- The trash icon beside a folder, or *Remove from Burrow* in its menu,
  takes it off the list and gives its permission back to Android; the files
  stay on the phone. Choosing another server removes them all.
- The star at the end of a folder's path makes it a favourite, as on a
  host: listed on *Files* and on *This phone*, one tap back into it. Kept
  in the app on this phone only, never on Burrow's server.
- *All files* (Android 11 and later, off by default): the whole phone and
  its memory card, as a file manager shows them. Burrow says first what it
  gives the page (every file, reachable by whoever controls your Burrow
  server), then Android asks you to allow *All files access*. The phone's
  storage is then in the list beside your folders, with the same views,
  copies and limits. The cross beside it, or *All files on the Files page*
  in Settings -> Android app, switches it off at once; Android's own
  permission is taken back there too (*Take back Android's "All files
  access"*). Choosing another server switches it off.

Nothing of the phone's files goes to Burrow's server, unless you copy one to
a host: the page gets them from the app and keeps them on the phone (a
problem report says only that you were on this page, not which file).

### Editor

Opens configuration files with highlighting and checks while you type:
Compose files against the Compose schema, shell scripts with ShellCheck,
Dockerfiles with hadolint, and JSON, TOML and Python. The status line counts
problems; tap it for the list. For compose files, *Check with docker compose*
also validates variables and paths on the host. Saving never leaves half a
file, and if someone changed the file meanwhile you see the difference first.
Find (Ctrl+F, or the magnifier) says how often the text is in the file and
which one is chosen ("3 of 12").

### Compose box

Terminal menu -> *Type in a text box*: a normal text field below the terminal
where autocorrect and voice input work; the send button or Enter sends the line. Handy on
phone keyboards that fight with terminals. Don't type passwords there.

## First connection to a host

Burrow shows the host's key fingerprint before it trusts it. Compare it with
the host:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

If the key later changes, Burrow refuses to connect and shows both
fingerprints. If you know the host was reinstalled, remove the old entry
under *Settings -> Security -> Known hosts* (admins) and connect again.

## Keys

The *Key vault* (Settings -> Key vault, admins) generates ed25519 keys or imports existing private keys (OpenSSH or
PEM, with passphrase). They are encrypted on the server and never sent to
the browser. To start using a key on a host that only has a password: open
the host, *Install key on host*, enter the password once.

## Import from ~/.ssh/config

*Hosts -> Import*: paste your config. Concrete `Host` entries become hosts;
`Host *` sections provide defaults. Import your private keys into the vault
first - a key whose name matches the `IdentityFile` file name is selected
automatically.

## Workspaces (editor)

Open a folder as a project: in Files, a folder's menu -> *Open as
workspace*. Workspaces are listed on the Hosts page and on the Files start
page.

- A right click (or a long press) on a file or folder in the tree opens its
  menu, as in Files: edit (in a tab here), rename, copy or cut, properties,
  delete, ... After a copy or cut, *Paste into ...* in a folder's menu puts
  it there, in a file's menu into that file's folder (on another host too);
  the Files page has the same in its bar.
- The tree (a drawer on a phone) shows git's status: M modified, A added,
  U new, D deleted.
- Files open in tabs; drag a tab onto another to put it there, or move the
  tab with the focus with Ctrl+Shift+Left or Right (the terminal's tabs
  too); the order is kept on this device. *Go to file* (Ctrl+P) finds one by name in every
  folder of the workspace (`compose.yaml:12` goes to line 12). In a very
  large folder it lists the files found in 20 seconds and says not all are
  there; open a smaller folder as a workspace to find them all.
- *Commands* (F1, Ctrl+Shift+P, or the keyboard button on a computer)
  finds every command of the workspace and of the file in front by a few
  letters of its name, with its keys; the ones used last come first.
- On a wide screen two files can be side by side: *Move to the other side*
  (a command) or drag a tab onto the other side's bar. Each side shows one
  of its tabs; a click in an editor puts it in front. On a phone all tabs
  are in one bar again.
- *Outline* (beside Git) lists the headings, keys, sections, blocks or
  functions of the file in front; a tap goes there. The badge at the top
  counts the problems of every open file; a tap lists them by file.
- A file in a git repository shows its changed lines against the last
  commit (as VS Code), also before you type; elsewhere against the saved
  text.
- Files dragged from the computer onto a folder of the tree are uploaded
  there (onto a file: into its folder). The tree follows what changes on
  the host by itself, every 10 seconds while in view; the arrows beside
  *Add a folder* read it again at once.
- *Compare with...* (a right click on a tab, or the tree's menu) shows a
  file beside another open file or any file of the workspace's folders,
  read only, both paths named. Every comparison in Burrow (also compare
  with saved, a save conflict and a stack's review) shows side by side
  where there is room, one column on a phone; above it how many places
  differ and the lines added and removed, *Previous* and *Next difference*
  (F7, Shift+F7) with the first one in view, a mark along the edge for each
  (a tap goes there), and the unchanged stretches folded until *Show
  unchanged lines*.
- *Search* looks in every file on the host (ripgrep, or grep), skipping
  `.git` and `node_modules`; `Aa` matches case, `.*` is a regular
  expression, the replace button replaces in all files found (saved at once, a file that
  changed meanwhile is skipped).
- *Git*: the changes, a diff per file, stage and unstage, throw changes away
  (a changed file back as staged or committed, a new one deleted; asked
  first), commit, pull and push; a tap on the branch switches to another.
  If git on the host does not know who you are, Burrow asks once and
  remembers it for the workspace. Burrow never runs what a repository
  brings itself: its hooks do not run on a commit or push from Burrow, and
  a repository whose own settings run commands (filters, `diff.*.textconv`,
  a credential helper that is a command, `core.sshCommand`, ...) is refused
  with the setting named; remove the setting, or use a terminal there.
- A file only root may read: *Open with sudo* (after confirming it is you).
  Saving keeps its owner and permissions.
- nginx configuration: *nginx -t* checks it inside a container you pick
  (for SWAG, the swag container).
- Markdown (`.md`): coloured, and the menu's *Preview* shows it as it reads,
  tables included. Burrow makes the preview itself from the text; nothing
  in the file runs and no picture is loaded.
- *Terminal and logs* (the terminal button at the top) opens a panel under
  the editor, as in VS Code. *Terminal*: a shell on the host in the
  workspace's folder (when sessions already run on the host, the panel
  lists them to open first, also on +; otherwise one starts when the panel
  opens and + adds another;
  the numbers switch between them, the bin closes the one in front, and the
  key types the host's stored password at a sudo prompt, as on the
  terminal page).
  *Logs*: the containers whose compose folder lies in the workspace,
  merged; *Choose* picks others from the host (*Automatic* goes back).
  Drag the edge (or use the arrow keys on it) to make the panel higher or
  lower. Whether it is open, its height, its tab and the choice are kept on
  this device; the terminals keep running when you leave, and the button
  with the arrow opens the terminal or the logs on their own page.

## Favourite folders

Star a folder (the star at its path) on any host; the Files start page lists them
all, for one tap there.

## Containers and logs

Bottom bar -> *Containers* (with *Apps* as the second tab). Every container of
every host with Docker, grouped by compose stack - also a stack that runs on
several hosts - with state, health, restarts and live CPU and memory. A
host still being read is named, and the counts say "(so far)" until it
answers; a host silent for 20 s says so, and what is shown is how it was
then. The page is live, no reload needed: while someone looks, Burrow reads
each host's containers every 5 seconds and their CPU and memory every 15
seconds, and stops 30 seconds after the last viewer leaves. CPU is as
`docker stats` says it: 100% is one full core, so 30% is a third of a core
and a busy container on several cores goes over 100%.

- The arrow before a stack folds it away (kept on this device); folded, it
  still says how many of its containers need a look. A search or a state
  filter shows every stack open.
- The order icon beside the filter: by name, the busiest (CPU) or the most
  memory first, or problems first; stacks by what they use together. The
  rows hold their place while the numbers move, sorted again when you
  choose, when a container comes or goes, and every 30 s. Kept
  on this device. On a wider screen (from 720 px) the column names
  (Name, Status, CPU, Memory) in a stack's table set the same order for
  every stack; pressed again, the other way round, an arrow at the one in
  use.
- Tap a container for its details and logs; *Logs* at a stack, or *Select*
  and pick any containers (also from different hosts), for one merged
  timeline in time order, each source in its own colour.
- Filters like Dozzle: levels (fatal ... trace, and lines without a level),
  stdout/stderr, a source on or off, search as text or as a regular
  expression (`.*`), and a time range (live, since the last start, 15
  minutes, an hour, a day). JSON lines show their message; `{...}` unfolds
  them. ANSI colours are shown. A stack trace is one event: its frames
  (indented lines, `Caused by:`) fold under its first line, `+12 lines`
  opens them.
- Scrolling up pauses following; the button at the bottom jumps back.
- Tap a line to pin it, copy it or copy a link to it; the link opens the logs
  around that moment with the line marked. *Download* saves what the filters
  show. On a wide screen *Side by side* puts each source in its own column.

Docker on the server Burrow runs on is reached like any other host: add it
under Hosts (SSH to itself) and test the connection.

## Log files

Some apps write their logs to a file instead of (or besides) their output.
On a container's page, *Log file* lists the `*.log` files Burrow finds in
its mounts and its `/var/log`; pick one, or give a path as the container
sees it. A file under a mount is read on the host (so also while the
container is stopped); otherwise inside the container. The chips above the
log choose what is shown: the output, a file, or several at once in one
timeline.

A log file is read like the output: filters, search, links to a line,
download, *Analyse*, alert rules (a pattern, or errors per minute; a rule
on the whole host also watches the host's own log files) and reports
(a container's files count with it; a host's files are parts of their
own). In *Files*, *Open as log* follows any file on a host the same way.
The time of a line comes from the line itself (ISO 8601, syslog, the
common log format); a line without one (the next line of a stack trace)
takes the time of the line before.

## System logs (journal)

A host's menu -> *System logs* lists its systemd services, failed ones
first, with a search. Tick one or more and *Show* opens their journals
(`journalctl -u`) on the logs page, in one timeline: the same filters,
search, analysis, pins and links as container logs. An admin can *Watch* a
service: its journal is then also read by the alert rules and for the
reports, like a log file.

Burrow reads the journal as the host's SSH user. That user must be in the
`systemd-journal` group (`sudo usermod -aG systemd-journal <user>`), or may
use sudo without a password; otherwise the page says so instead of showing
an empty log. A host without systemd says that too.

## Managing containers and stacks

Every change asks you to confirm it is you (step-up) and lands in the audit
log.

- A container: *Shell* opens a shell inside it as a terminal session (bash
  when it has one); *Restart*, *Stop*/*Start*, *Inspect* (`docker inspect`,
  which shows environment variables) and *Delete*.
- A stack (its name on Containers, or *Stack* at a container): pull, up,
  restart and down, with the output live as it runs on the host. Operations
  run on the host apart from Burrow: a dropped connection, or Burrow
  restarting itself, does not break them off.
- Several at once: *Select* on Containers, pick them, then *Restart*,
  *Stop*, *Start* or *Update* (a menu on a phone). One question lists what
  happens to each and what is left alone, and why; then each one's
  progress. One failing does not stop the rest. Burrow's own container is
  restarted when asked, never stopped. Admins only.
- The compose file: *Edit* opens it in the editor with its checks; *Deploy*
  (in the editor) or *Review and deploy* shows what changed since Burrow
  last deployed the stack (or since you started editing), checks the file
  with `docker compose config`, says which services a deploy recreates or
  starts because what runs differs from the files (also when the file did
  not change here), and runs `docker compose up -d`. The services it
  recreated are then watched for 60 s, as after an update: one that stops,
  restarts or turns unhealthy puts the previous deployment back (the
  compose file as Burrow last deployed it, each service on its previous
  image; your file stays as it is). When Burrow never deployed the stack
  before it cannot know the previous file: it says the deploy does not run
  well and leaves it.
- An operation that is still running on the host when Burrow restarts goes
  on there; Burrow follows it again once it is back, shows it under
  Activity, and finishes a deploy or an update left in the middle.
- *Terminal and logs* (the terminal button at a stack's top) docks the same
  panel at the bottom of the stack's page: a shell in the stack's folder,
  and the stack's containers' logs (or the ones you choose). On a phone it
  sits above the tab bar.

## Image updates

Burrow asks each image's registry whether its tag now points to a newer
image - a HEAD request, which Docker Hub does not count as a pull; nothing is
downloaded. Daily in the maintenance window (Settings -> Container updates)
and with *Check now*. The Containers tab shows how many images have an
update; rows and stacks are marked.

- On the stack: the old and new digest per image, *What is new?* (the
  image's GitHub releases after the version you have, when the image says
  where its source is), and *Update now*. The version you have is the
  image's `org.opencontainers.image.version` label when that is a version,
  else its own `<name>_VERSION` variable (the official postgres, redis,
  nginx and valkey images say it there), else a tag that is a whole version
  (`nginx:1.27.3`). When none says, or the version is not among the last
  100 releases, the newest releases of the line the tag follows are shown
  (`valkey:9`: the 9.x ones), and the dialog says why.
- *Update automatically* per stack: in the window Burrow pulls the newer
  images, recreates those services and watches them for a minute. A
  container that stops, keeps restarting or turns unhealthy gets its
  previous image back. The stack's history lists each update and rollback.
  A version rolled back is remembered: the stack says "This version was
  rolled back here on" its date, the window leaves it (a newer release is
  tried), and updating to it by hand asks first.
- *Automatically up to* (Settings -> Container updates): every new version (the default),
  minor versions and fixes, or fixes only. A bigger step, or one Burrow
  cannot tell from the release notes, waits for you and a message says so.
  With *Every new version* there is no step to tell: an image whose release
  notes cannot be read (not on GitHub, rate limited) is updated without the
  check for a breaking change. By hand, *Update anyway* for such images is
  asked once per stack.
- A rollback puts the previous *image* back, not the data: a new version
  that changed its database or files on its first start (a migration) may
  leave data the old version cannot read. For such images, back the data up
  before updating, or leave them on *fixes only* or `burrow.update: manual`.
- A service with the label `burrow.update: manual` is checked and told
  about, never updated by itself.
- Images fixed to a digest (`image@sha256:...`) are never outdated. Images
  that need a login show as unknown; leave them out in Settings -> System
  (or with `UPDATE_CHECK_EXCLUDE` in the `.env` file).
- Burrow does not update its own stack automatically (it would stop
  watching halfway); update it by hand from its stack page.
- A newer version under another tag: an image on a version tag
  (`nginx:1.25`, `postgres:16.2-alpine`) shows when the registry has a
  higher one of the same shape (`1.27`, `16.4-alpine`; never a release
  candidate or another suffix). It is never taken by itself: *Use 1.27* on
  the stack changes that `image:` line in the compose file and opens the
  review before deploying. A message says each new one once. Labels on the
  service choose which tags count, as patterns:
  `burrow.tag.include: '^16\.'` (stay on 16.x) or
  `burrow.tag.exclude: '-rc'`.

### Images, volumes and networks

A host's menu -> *Images and volumes* (admins): the host's Docker images
(with size), volumes and networks, and which containers use each. *Clean up*
lists what nothing uses - unused images and networks ticked, volumes not
(their data goes with them) - and removes only what you leave ticked, if it
is still unused then. Never Burrow's own stack, never Docker's own networks.

## Alerts

Bottom bar -> *Containers* -> *Alerts*. Burrow watches Docker on every host:
a container that exits with an error, is killed for memory, turns
unhealthy or keeps restarting raises an alert. Stopping a container
yourself does not, and neither does a throwaway: a container Docker named
itself (`docker run` without `--name`, outside compose, such as
`unruffled_montalcini`). Give it a name, or run it from a compose project,
and its alerts come.

- Tap an alert for the logs of that moment; *Analyse* opens them with the
  AI analysis running; the bell mutes the container (an hour, 8 hours, a
  day, or until unmuted).
- *Rules*: the built-in one (crashes and the like, all hosts) and your own:
  a pattern in the log lines, or more than N errors within M minutes, for a
  host, a stack or one container. A pattern is a regular expression without
  look-around or back-references (it runs in time with the line, whatever
  the pattern).
- Repeats within ten minutes are counted on the alert, not pushed again.
- The count of new alerts shows (red) on the Containers tab.

## Notification channels

Settings -> *Notifications on this device* turns on Burrow's own
notifications in this browser or in the Android app (the app needs a
UnifiedPush app on the phone, such as ntfy, to carry them; each message is
encrypted for the device). The channel *Burrow's own push* chooses what goes
to those devices.

Settings -> *Notification channels*: add Burrow's own push, ntfy, e-mail, Discord or a
webhook, choose per channel what it gets (alerts, reports, image updates, problem
reports)
and its language, and *Test* it. Adding, changing or removing a channel
asks you to confirm it is you (step-up). A stored token or password stays
with its server: when you change an ntfy server, the mail server (or turn
TLS off) or, under Settings, an AI provider's or single sign-on's address,
enter the secret again, or it is dropped.

- **ntfy**: enter your own ntfy server, or https://ntfy.sh (a public one,
  which then carries the names of your hosts and containers), and keep the
  proposed topic (a long random name: on ntfy.sh anyone who knows it can
  read it). On the phone: install
  the ntfy app and subscribe to the same server and topic. A tap opens
  Burrow at that page, in the Android app or in the browser (your choice).
- **E-mail**: your SMTP server (port 465 with TLS from the start, or 587
  with STARTTLS), a sender and one or more addresses.
- **Discord**: a channel's webhook (channel settings -> Integrations ->
  Webhooks).
- **Webhook**: Burrow POSTs JSON (`topic`, `title`, `body`, `url`,
  `priority`, `data`); with a secret, `X-Burrow-Signature: sha256=<HMAC of
  the body>`.

Burrow also tells about itself, on the channels that get alerts: a
background job that keeps failing for an hour, its data disk getting full
(under 1 GB or 5 % free), a channel that fails (told through the others),
new errors in its own log, and a self-update that failed or was rolled
back; each once, and once more when it is gone. A new Burrow version goes
to the channels that get image updates (checked once a day). Once a week
every channel gets "Burrow runs": when it stops coming, Burrow or that
channel is broken.

Burrow cannot tell you that it is down itself. For that, give it a
heartbeat address (Settings -> System, or `HEARTBEAT_URL`): it calls it
every five minutes while it runs well, and Healthchecks or an Uptime Kuma
push monitor there tells you when the calls stop.

## Reports

Bottom bar -> *Containers* -> *Reports*. A *Weekly report* is there, off:
edit it to choose the day, time, hosts and containers (or stacks), and
switch it on; add daily ones or a cron expression. *Make now* makes one at
once.

A report covers the time since the previous one. Per container: a status
(problem: crashes, out of memory, unhealthy, stopped with an error;
attention: many errors, restarts, unhealthy spells; ok), why, the kinds of
error marked *new* or *again*, what got resolved, and a row of dots with the
status in earlier reports. Containers that need a look are explained by the
language model, with fixes. The report goes to every channel that gets
reports, with a link to it.

## AI log analysis

*Analyse* in the log bar (in *Options* on a container's page) sends the
lines shown - or only the pinned ones - to the model chosen under Settings ->
AI. Burrow first groups repeated lines, puts errors first and masks
passwords, tokens, keys and e-mail addresses, and IP addresses too unless
you ticked *Runs on my own network* for the Ollama or OpenAI-compatible
server (Burrow does not judge that by its name: `gpu` or `llm.lan` may be
a rented machine over a VPN). What goes out: the grouped lines, the names
of the containers, files and hosts, and what Docker says about those
containers (image, state, health), all masked the same way. The masking
goes by patterns (`key=value` and `Authorization:` style settings, known
token shapes, private key blocks, e-mail and IP addresses): a secret in a
shape it does not know goes out as it is. Use your own model (Ollama) for
logs where that matters, or *Copy* beside the hand-off to Claude or ChatGPT to read the masked text first. The answer streams in four parts: what is
happening, problems, the likely cause and fixes. With a Claude key set and
another provider chosen, *Deeper analysis with Claude* is offered.

Under a finished answer you can ask further ("which line in the file?"):
the question goes to the model with the logs as they were sent, the
analysis and your earlier questions, masked the same way, and the answer
comes under it. The questions stay with the analysis (also on the Reports
page); ten at most on one, then analyse again. Analyses made before 2.3.2
cannot be asked further: analyse again.

With a model set up, the filters of a log also take a question in words
("errors from the database in the last hour"): the model turns it into the
log's own filters (search text, levels, stream, time, sources), which are
set on the controls, said in a line under them, and can be changed there;
*Undo* puts back the filters from before. Only the question and the names
of the sources go to the model, masked; no log line.

Under each answer: the provider and the tokens it read and wrote, as the
provider counted them. Set what your provider charges per million tokens
under Settings -> AI (*Prices*) and Burrow adds an estimated cost; the same
page shows what was used this month and in the last 30 days, per kind
(analyses, reports, commands, log filters). A local model costs nothing here: leave the
prices empty.

## AI about a file

In the editor's menu (and the command palette), *Ask AI about this file*
sends the lines you selected (whole lines), or the whole file as the
editor shows it (unsaved changes too), with your question to the model set
up under Settings -> AI. The dialog names the lines and the model before
anything goes. The text is masked as logs are (passwords, tokens, keys,
e-mail addresses, and IP addresses unless the model runs on your own
network) and cut to what the model takes; each line goes with its number,
so the answer can name it. The answer is only shown: nothing in the file
changes. Ask further under it, as under a log analysis; the questions stay
with the file (*Earlier questions about this file*) and are yours alone, an
admin's included. A phone's file (the app's Files page) never goes.

## Users and roles

Settings -> *Users* (admins): *Make an invite link* as operator or admin and
send it; it works once, for a week. The invited person picks a user name
and sets up a passkey or a password with an authenticator app - or
continues through single sign-on. An **operator** sees hosts, containers,
logs, alerts, reports and host statistics, and files in the folders you
allow, but opens no shell and changes nothing. Change a role or remove an
account there; there is always at least one admin.

**Which files an operator may open.** None at first. On an operator's row
in *Settings -> Users*, the folder button: per host, *Allowed folders* and
*Denied folders*, one folder a line. The longest folder that holds a file
decides, so `/srv` allowed with `/srv/secrets` denied opens everything in
`/srv` except that folder; a folder in both lists is denied. A path is
judged as it really is on the host: a link into another folder counts as
that folder. This holds in Files, the editor, downloads, searches,
workspaces (quick open, search, git) and a stack's compose file as last
deployed; bookmarks and workspaces outside the allowed folders are not
listed for them. Whatever is allowed, an operator never opens SSH keys
(any `.ssh` folder, host keys), `/etc/shadow`, `/proc` (every process's
environment) or Burrow's own data: its master key, database and data
folder, its backups and their key, and Burrow's own compose folder (its
`.env`) on the host that runs it. Admins open everything; saving a file
that grants a shell (SSH keys, a shell's start-up files, cron, sudoers,
units), unpacking an archive and copying or moving over existing files
ask an admin to confirm it is them (step-up).

## Single sign-on

Settings -> *Single sign-on*: the provider's address (Authelia, Authentik,
Pocket ID, Keycloak), a client ID and secret, and the button's text; at the
provider, allow the redirect address shown. Sign-in through the provider
works for accounts linked to it; the first time Burrow links the account
whose user name equals the provider's, or, if you chose e-mail, whose
e-mail equals one the provider says it verified. A link holds for that
provider only: after a change of provider, unlink each account under
*Settings -> Users* (the link button on its row), and its next sign-in
through the new provider links it again the same way. New people
still need an invite. Confirming it is you (step-up) works through the
provider too.

## Host statistics

A host's menu -> *Statistics* (for operators a tap on a host): CPU, memory,
load and uptime now, the history of a day, week or month (point at a chart,
or touch it, for that moment's time and value in every chart), disks with how
full they are, temperatures, and SMART of the disks (every six hours, or
*Check now*; needs `smartmontools` on the host and sudo with the stored
password). A disk 90% full, a disk SMART calls failing or with new bad
sectors, heat, and a busy host raise alerts (the *Host health* rule). A
short peak does not: the CPU counts when its average over the five minutes
between samples is 90% or more, memory (95%) and heat when two samples in a
row are over. A host that two samples in a row cannot reach raises a *Host
unreachable* alert, and another when it answers again: a rule of its own,
to switch off when hosts are off on purpose (woken with Wake-on-LAN). Each
disk gets a verdict from the five counts Backblaze found to go with failing
disks (SMART 5 reallocated, 187 uncorrectable, 188 command timeouts, 197
pending, 198 unreadable): all zero is *good*, any above zero *watch it*
(188 alone is often a cable), growing since the oldest check kept is
*failing*, with what it was and when. One check a day is kept for 90 days.
NVMe disks: worn past the limit is *watch it*, worn out or a critical warning
*failing*. A disk that sleeps is not woken for it: the check skips it and
says so.

*Package updates*: what the host's package manager (apt, dnf, apk or
pacman) says can be updated, read every six hours and with *Check now*,
without root and without fetching the lists - Debian and Ubuntu fetch them
every day by themselves (apt-daily), so their age is shown, and called old
after a week. Security updates come first (a `-security` suite, dnf's
security advisories), and whether the host asks for a restart. New security
updates raise a *Host health* alert once, and each report names the hosts
with updates waiting. Burrow never installs them: the command to update is
there to copy into a terminal.

*Disk activity* shows per disk how much is read and written, how busy it is
and whether it spins or is spun down, now and over the chosen period; for
admins *Who reads and writes* lists the processes doing it. A container's
page shows its own reads and writes too.

## Proxmox VE

A host that is a Proxmox VE node (`qm` or `pct` there) shows its *Guests*
on its statistics page: the virtual machines and containers with their
state. An admin starts, shuts down (two minutes to stop by itself), stops
and reboots them; each asks first and is in the audit log. *Add as host*
opens a new host with the guest's name and the address the node knows for
it: a container's fixed address, else what the container or the VM's
guest agent reports. Burrow reads and runs `qm` and `pct` over SSH, so the
host's user needs to be root or allowed those two through sudo without a
password, for example
`burrow ALL=(root) NOPASSWD: /usr/sbin/qm, /usr/sbin/pct`. No API token is
stored.

## Apps

Web apps next to the shell (Containers -> *Apps*). Admins add them by hand or
with *Manage -> Find in containers*, which reads the `swag_url`, Traefik and
`homepage.*` labels of running containers on your Docker hosts, and the
proxy confs of a SWAG container (`server_name` and `$upstream_app` of each
`*.subdomain.conf`), for apps proxied by a conf written by hand. In
*Manage*, tick several apps to change their group, whether they show on the
page, open in a tab of their own or are watched, all at once, or to delete
them together. In a browser
an app opens inside Burrow when it allows being framed, otherwise in a new
tab; in the Android app every app opens in its own tab with its own cookies,
so it stays signed in (on a phone whose WebView is too old for that, the
tabs share one cookie store, and the app says so). Each tab there has its own close button; a tunnel
sign in the bar says the tab in front goes through the app's own WireGuard
(away from home). Search the apps by name or address, and sort them by your
own order, by name, or the ones that are down first (kept on this device;
dragging works in your own order without a search). Watched apps (the
default) are asked every minute whether they are up; for an https app
Burrow also reads its certificate every six hours and warns 14 days and
again 3 days before it runs out, on the tile and through the alert channels.
Each tile shows the app's own icon (its touch icon or favicon), fetched when
it is added and again once a day.

## Android app

Install it from *Settings -> Android app*. The app:

- asks for your fingerprint (or screen lock) when it opens and after five
  minutes in the background, and blocks screenshots;
- signs you in with your fingerprint once paired: a code from *Settings ->
  Android app -> Show a pairing code* on a signed-in device, or *Use
  fingerprint on this phone* after signing in with your password. Confirming
  a sensitive change also takes the fingerprint. The same heading lists
  each paired phone with when it was paired and last used; rename one with
  the pencil, or unpair a lost one;
- shares files: *Share* in another app -> Burrow -> pick host and folder; in
  Files a file's menu has *Open with...* (edit it in another app; when you
  come back, Burrow offers to upload the changed file), *Share...* and
  *Copy to this phone*; downloads land in the phone's Downloads/Burrow
  folder;
- shows the phone's own files in *Files -> This phone*, in the folders you
  allow (see Files above);
- has a home screen widget (hold an empty spot on the home screen ->
  *Widgets* -> Burrow): how many hosts are up, new alerts and hosts with
  package updates, counts only. At home it asks every half hour and when
  you leave the app. Away from home it does what *Settings -> Android app ->
  Home screen widget, away from home* says: bring the app's own WireGuard
  tunnel up for a few seconds to ask, show the last numbers with their time,
  or get new numbers by push when they change (notifications on, through
  the ntfy app or another UnifiedPush app);
- downloads files itself, with how far it is and how long it still takes in
  the notification, in Burrow's busy pill and as a thin bar over an app
  tab. *Stop* ends one; one that broke off (the phone left the Wi-Fi) offers
  *Retry*, which goes on where it stopped when the server allows it. A
  download an app tab offers is asked first; Burrow's own *Download* buttons
  start right away;
- keeps running while uploads and downloads run (a notification shows them);
- has its own WireGuard for away from home (*Settings -> Android app ->
  WireGuard*): *Scan with the camera* reads the QR code a server such as
  wg-easy shows (Android asks for the camera the first time), or take it
  from a picture of the code, a `.conf` file, or paste it. The
  configuration stays on the phone, sealed; Burrow never sees it. A name
  (`nas.lan`, Burrow's own) is looked up only through the tunnel's DNS (the
  configuration's `DNS =` line, your home's DNS server), never through the
  network the phone is on, which could send the request elsewhere: without
  that line, give addresses (`10.0.0.20`) instead of names;
- puts your favourite hosts on the icon: long-press it;
- types into the terminal character by character, without suggestions or
  corrections (as Termux does); the text box keeps them;
- takes the volume keys while a terminal is open: volume down is Ctrl for
  the next key; volume up and then W A S D give the arrows, E Esc, T Tab,
  1-9 F1-F9, P and N page up and down (a line above the key bar says so
  while volume up is on);
- updates itself: when this Burrow has a newer app, a dot on *Settings* and
  *Settings -> Android app -> Update the app* download it (its progress
  under the button and in the notification) and open Android's installer
  (the first time Android asks whether Burrow may install apps).

## Direct route (Android)

For when Burrow cannot be reached: WireGuard off, the server down.

1. In Burrow: *Settings -> Android app*, at your phone: *Direct route*. Tick
   the hosts the phone may reach by itself. Burrow puts the phone's key on
   them (and removes it when you untick a host or unpair the phone).
2. The app keeps a copy of those hosts, their keys, your snippets and history
   (encrypted on the phone), refreshed whenever it reaches Burrow.
3. Without Burrow: in the app tap *Direct route* on the error screen, beside
   *Try again* where a page says there is no connection to Burrow, or
   long-press the app icon -> *Direct route*. Pick a host, confirm with your
   fingerprint, and you have a terminal.

**A lost phone.** Unpair it under *Settings -> Android app* (or remove
its user). What that does, and what it cannot:

- Burrow at once: the phone's sign-in and its device key go, and its open
  connections to Burrow (terminals, logs) end.
- On each host of its direct route: the phone's key is taken out of
  `authorized_keys`. A host that cannot be reached is named in a message;
  Burrow tries it again now and then and when it starts. If that host
  stays away, take the line with `burrow-direct` out of
  `~/.ssh/authorized_keys` there yourself.
- An SSH session the phone already has open on a host directly is not
  Burrow's to end: on that host, end its kept tmux
  (`tmux -L burrow-direct kill-session -t phone`) and its SSH login.
- Its WireGuard peer (when you gave the phone one): remove it on your
  WireGuard server; Burrow does not manage that server.

On a host with tmux a direct session runs in a tmux of its own there:
leaving it (back) only detaches, the host list marks it, and opening the
host again goes on where it was; *End session on host* in its menu stops
it. On a host without tmux the session ends when you leave it (after a
question). There is no AI; completion, history, snippets, the key bar and
the compose box work as usual. The host must be reachable from where the
phone is (its LAN address on the LAN). The direct route is a screen of its
own in the phone's recent apps: going to Burrow, tapping a notification or
sharing a file into Burrow leaves its sessions running; *Back* on its host
list (back to Burrow) ends them.

*Forward a port* puts a port of a host (a web page on it) on the phone's
own address (127.0.0.1) and opens it in the phone's browser. While it runs,
any app on this phone can reach that port, not only the browser: stop it
when you are done. A session kept open in the background holds through
SSH keepalives and the app's WireGuard; with the screen off a phone may
still sleep long enough for a router on the way to drop it.

## Security settings

- Add passkeys for each device; remove lost ones.
- A password is optional and only works together with an authenticator app.
- Recovery codes: each works once. Create new ones when you run low.
- *Signed-in devices* lists every session; sign out any of them.
- Changing hosts, keys or login methods asks you to confirm with a passkey or
  code if your last confirmation is older than 15 minutes.
- Admins see the audit log under *Settings -> Security*, in words and with
  a filter.
- Admins also see hints at the top of Settings when something about how
  Burrow runs needs them (a dot on Settings says so): a proxy that
  `TRUST_PROXY` does not name, with what to set, or a full data disk.

## About and updating Burrow

*Settings -> About* says which Burrow runs and, for admins, where (the host
and folder of its compose project). *Check for a new version* looks for
one; *Update to* (the version) shows what is new, the breaking changes first, then
updates over SSH on that host: a backup first when the backup service
runs, the old image kept, and the old version back by itself when the new
one does not become healthy (docs/INSTALL.md).

Admins also see what Burrow does by itself (container history, host
statistics, reports, clearing out old entries, the update check: when each
last ran, how long it took, its last failure), and Burrow's own warnings
and errors of the last 30 days, grouped, with how often and when. These
are kept in Burrow's database, so an update does not take them away.

## Backups

*Settings -> Backups* (admins) shows the backup service's last round
(docs/INSTALL.md sets it up). *Back up now* asks the service for one: it
starts within seconds and the page says when it is done, or that the
service did not take the request (not running, or an older version).
*Download the newest* saves the newest archive, encrypted with the backup
key, which Burrow does not hold: keep that key elsewhere, a restore needs
it (`bash scripts/restore.sh`). The download needs the backups folder
mounted into Burrow, as compose.yaml does (read-only).

## System settings

*Settings -> System* (admins) holds what was only in the `.env` file: the
terminal sessions open at once and when a session nobody watches closes,
how often each host is checked for its online dot, the images the update
check leaves alone, registries Burrow reaches at another address, and the
domain for apps found through SWAG. A field left empty keeps the `.env`'s
value, shown under it; a value set here goes before it and applies at once.
Saving needs a fresh sign-in check (step-up).

The rest of the `.env` stays there: the address Burrow is opened on
(passkeys are bound to it), the master key and data folder, the proxy's
address (it counts before anyone signs in) and what Docker itself sets up.

## Problem reports

*Settings -> Report a problem*, or a shake in the Android app, or
Ctrl+Shift+B on a computer: the report form with a picture of the screen,
what you write, and the page, versions and recent errors. In the picture
what files, terminals and logs show is covered (they can hold passwords
and keys); tick *Show what files, terminals and logs held* when the
problem is in what they show. Within a
terminal you may add what you typed in the last 30 seconds. The report is
saved on your Burrow server and nowhere else.

Admins see how many are open on the Settings menu item, and a channel
with *problem reports* ticked tells them when one comes in. They find them
under *Reports received* on the same page, the open ones
apart from the solved ones (*Mark as solved*, *Open again*): read one whole
with its pictures, download it (a `.tar.gz` of its folder), delete it, or
*Report on GitHub*: a new issue on Burrow's GitHub, filled in from the
report but without the pictures and the input. It opens in your browser
for you to read and send; check it for host names, addresses or anything
else private first, since an issue is public.
