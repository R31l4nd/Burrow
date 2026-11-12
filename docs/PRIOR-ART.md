# Prior art

How comparable open-source projects handle what Burrow does, per area:
what Burrow already has, what it takes over, and what it leaves out on
purpose. Look here (and add to it) before building or changing a feature.
Checked 2026-10-06.

## Terminals

- **Termix** ([github](https://github.com/termix-ssh/termix)): tabs and split
  screen up to 6 panels, saved as a workspace and restored; sessions survive
  refreshes and device switches; inline autosuggestions from history;
  snippets with variables, and one command sent to every open terminal; a
  bar above each session with the host's live CPU, memory and disk;
  recording and playback, plain-text session logs; live sharing through
  time-limited or revocable links, read-only or read-write.
  - Burrow has: server-owned sessions, autosuggestions (history, Fig specs,
    paths, containers), snippets with `{{variables}}`, a configurable key bar.
  - Taken over: tabs that stay connected out of sight (Termix keeps every
    tab mounted); Burrow keeps the last four connections and replays what
    they received, so switching neither connects again nor redraws.
  - Taken over (F4, N9): split panes, up to four (2 x 2) on a wide screen,
    two on a medium one, one on a phone; the layout, the dividers and the
    tabs' order kept per device; typing into all panes shown only through
    its own switch, with a red bar and Stop all the time it is on (Termix
    sends one command to every terminal; Burrow keeps it to the panes in
    sight, so nothing goes where it cannot be seen).
  - Burrow's own (2.19.0), after iTerm2's tmux integration (`tmux -CC`,
    [docs](https://iterm2.com/documentation-tmux-integration.html)), which
    keeps a tmux pane's scrollback in the app so scrolling never asks tmux:
    scrolled back, the session's whole history (tmux's `capture-pane` with
    its colours) comes once and is scrolled in the browser itself, at the
    screen's rate; scrolling step by step through tmux's copy mode over SSH
    was a few frames a second on a phone.
  - Taken over (F3, differently): no links; a session is shared with
    Burrow users picked by its owner, watching only (the server ignores what
    they send), ended at once when they are taken off the list. Recording on
    request as asciicast v2, what the screen showed and never the keys, kept
    30 days unless an admin sets another time (7 days to a year), played back in Burrow at 1x to 8x and downloadable.
- **Nexterm** ([github](https://github.com/gnmyt/Nexterm)): session recording
  for audit, live sharing, Proxmox LXC/QEMU management, scripts.
  - Take over: Proxmox guests as hosts, start/stop (F5).
  - Taken over (F5, differently): Nexterm talks to the Proxmox API with a
    token; Burrow uses the node's own `qm` and `pct` over the SSH it already
    has (root, or sudo without a password for those two), so no token is
    stored. Start, shut down, stop, reboot, and add a guest as a host with
    the address the node knows (a container's static `ip=`, else what it or
    a VM's guest agent says). Left out: creating guests, consoles, backups.
- **termhub** ([PR 239](https://github.com/engenhariainversa/termhub/pull/239)):
  scrolls tmux through its copy mode from the server; the first key after a
  scroll waits until tmux has left copy mode.
  - Burrow does the same; taken over: one ordered queue of tmux commands per
    session, so leaving copy mode always comes after the last scroll step,
    and leaving only when the pane is in a mode (`#{pane_in_mode}`).
- **agent-box** ([issue 757](https://github.com/defangdevs/agent-box/issues/757)):
  with tmux mouse mode a touch swipe does nothing in xterm.js (open
  upstream limitation). Burrow turns the swipe into tmux scrolling itself.
- **Termux** extra-keys, **Termius** snippets/keyboard row: Burrow's key bar
  is configurable (Settings). Termux's extra keys repeat the arrow keys while
  held down; taken over (report 0bc1fe): the arrows, Backspace, Del, PgUp and
  PgDn repeat when held, Enter, Esc and Tab never do.
- **tmux** itself refuses to start inside another tmux while `$TMUX` is set
  ("sessions should be nested with care, unset $TMUX to force"); `TMUX= tmux`
  nests on purpose. **iTerm2**'s tmux integration (`tmux -CC`) keeps tmux
  out of sight: no status bar, no prefix, its windows as the terminal's own
  tabs. Burrow's tmux is invisible the same way (no status bar, no prefix
  key, ADR 4) and keeps `$TMUX` set, so a `.bashrc` that starts tmux when it
  is empty does not start a second one inside it. tmux's own nesting check
  looks at the terminal (is it a pane of the server `$TMUX` names?), not at
  the variable alone; so Burrow's `$TMUX` names the person's default
  server: `tmux`, `tmux ls` and `tmux attach -t main` reach their own tmux
  (review 2026-10-24; before, they reached Burrow's and `tmux kill-server`
  ended every Burrow session). Taken over (report 7340bb): when tmux
  refuses anyway, the shell runs in a tmux of the person's own, and the
  terminal says so.

- **Atuin** ([docs](https://docs.atuin.sh/reference/stats/)): `atuin stats`
  lists the commands typed most; **Warp** offers workflows (saved commands
  with arguments). Burrow takes the first as suggested snippets: commands
  typed at least three times on all hosts together, without what is quicker
  to type than to pick (one word, `cd`, `ls`), saved with one press or
  hidden (report 8f829d). No AI naming them: the first words are the name.

- **tmux** zooms a pane (prefix z), **VS Code** maximises an editor group,
  **Windows Terminal** toggles pane zoom; VS Code's layout menu picks how
  many groups. Taken over (reports 42f337, 1d2fd4): a pane alone and back
  from its head (button or double click), and the split button as a layout
  of one to four panes from the open sessions.
- **Windows Terminal**, **VS Code** (terminal tabs) and the browsers open a
  tab's menu on a right click: rename, close, split or duplicate; VS Code
  also renames on a double click. Taken over (report 076380): a right click
  brings the tab in front with Burrow's menu for it (rename, share, close);
  the double click and a phone's long press still rename. Not taken over: a
  menu of its own at the pointer, a second list of the same actions.
- A browser's password manager fills form fields, never a terminal (xterm
  draws its own text). **iTerm2**'s Password Manager types a saved password
  into the session ("Enter Password", and a trigger on a sudo prompt can
  open it). Burrow already typed the host's stored password from the terminal
  page's key button, without Enter; taken over (report 35ba91):
  the same button in the panel under a workspace and a stack.
- **iOS/Android tab bars** keep each tab's place and go to its start on a
  second tap. Taken over (report d6ea6c) for the rail and the bottom bar.

- **xterm** (`alternateScroll`, mode 1007), **GNOME Terminal** and
  **Windows Terminal** turn the wheel into arrow keys on the alternate
  screen when the program takes no mouse (less, man). Taken over (review
  2026-10-24): a finger's scroll over such a program in Burrow's tmux sends
  arrow keys; the wheel on a computer goes to tmux's history as a finger.

- **Slack, Discord** and other chat apps: a message typed and not sent stays
  with its channel when another one is opened, and is there on coming back.
  - Taken over (report e55d04): the terminal's text box keeps what is typed
    per session while another tab is in front; sent, it is gone.

## Files and editor

- **Termix** file manager: SFTP with sudo, viewers for code, images, audio and
  video; transfers between servers with integrity checks.
  - Burrow has: sudo saves, resumable uploads, copy between hosts, LSP.
  - Taken over (report 4d30e6): a folder only root may read, opened with
    sudo from its "No permission" message, to look and to edit its files;
    unlike Termix, nothing is moved, added or deleted in it as root.
  - Taken over: a Markdown preview in the editor (report 8fa899), made by
    Burrow's own escaping converter, never the file served as a page.
  - Taken over: a checksum after a copy between hosts (N8): sha256 of every
    file on both sides, a mismatch fails the copy and a move keeps its
    source.
- **VS Code** panel: the terminal (several, by number), output and problems
  in a panel under the editor, resized by its edge, kept open across
  restarts.
  - Taken over: the panel under a workspace with a terminal in its folder
    and the logs of the stacks in it, its height and choice kept; the same
    panel docked on a stack's page.
  - VS Code names editor tabs of the same file name with the shortest part
    of their folder that tells them apart ("docker-compose.yml data" and
    "docker-compose.yml hdd/AppData"), the whole path on hover and in the
    window title; it compares files with "Compare Active File With..." (a
    quick pick of open and workspace files) or "Select for Compare" in the
    explorer, in a read-only diff naming both. Taken over (report 9d710d):
    the labels in a workspace's tabs, close buttons and window title, and
    one "Compare with..." from a tab's menu (a right click) and the tree's,
    picking an open file or any file of the workspace's folders; an open
    file compared as its tab has it, a file only root may read said, with
    the way to open it through sudo.
  - VS Code moves an editor tab by dragging it, or with "Move Editor
    Left/Right" (Ctrl+Shift+PageUp/PageDown, which a browser keeps for its
    own tabs). Taken over (report 50a6f6): a workspace's tabs dragged like
    the terminal's, and the tab with the focus moved with Ctrl+Shift and an
    arrow in both; the order kept with the open tabs.
  - VS Code's diff editor: side by side (inline when narrow), changes
    marked in the overview ruler along the scrollbar, "Next/Previous
    Change" (F7 / Shift+F7) with the first change in view, and "hide
    unchanged regions". Taken over (user, 2026-10-23): all of it in every
    comparison (Compare with..., compare with saved, a save conflict, a
    stack's review), with a count of the places and the lines added and
    removed above it; side by side from 760 px of room.
  - VS Code's explorer and Filebrowser take files dropped from the
    computer on a folder, and VS Code follows the disk with a file
    watcher. Taken over (reports 6d86aa, 905455): a drop on a folder of a
    workspace's tree or of Files uploads there (a name there already
    asked, as with the file picker); without a watcher on the host, the
    tree and the list are read again when the page is seen again and
    every 10 s while it is, quietly, plus a button to read them now.
  - VS Code's terminal "+" has a dropdown beside it, and tmux users
    reattach rather than start again (`tmux attach`). Taken over (report eca78a): with
    sessions already running on the host, the panel offers them (on opening
    and on +) before starting a new one.

- **Settings as one place, a scroll position kept** (reports 8f4db3, e34ebd,
  78bf46, a55e25): **Android's Settings** and **iOS's** (every part a page
  under one list, the list kept where it was on the way back), **GitHub's**
  and **Portainer's** settings (a list at the left, the part beside it, the
  list staying put).
  - Taken over: the key vault, snippets and recordings parts of Settings
    like the others (their old addresses lead there); Back and Forward come
    to where a page was scrolled; on a computer the list stays where it is
    when a part is chosen.

- **Several apps changed at once** (an addition in the same round):
  **Homarr**'s and **Dashy**'s edit modes (pick items, then group or
  remove them), **Gmail**'s bulk actions (a bar with the count).
  - Taken over: tick apps in Manage; a bar with the count, All and None, and
    Change (group, shown, own tab, watched; "As it is" leaves each its own)
    or Delete for all of them.
  - Later (report b2340c): **Gmail**'s and **Files (Android)**' select-all
    is one control at the head of the list that turns into "none", never a
    button that comes and goes; Burrow's own Containers does the same. Taken
    over: All / None one button beside the search, the bar only the count
    and what to do.
  - Row actions (reports 3aa76b, edfcf1, e6fc13): **Material 3** lists put
    one trailing control on a row (a switch, an icon) and the rest in an
    overflow menu; **Gmail**, **Files (Android)**, **Termius** (hosts,
    snippets, keys) and **Portainer**'s mobile view do the same with three
    dots. Taken over: at most one thing beside a row's words, the rest behind
    its three dots, a popover on a computer and a sheet on a phone (Burrow's
    menu dialog, as for files and hosts).

- **Apps found behind a reverse proxy** (report 6d39c6): **Homepage**'s
  docker labels and **Dashy**'s; **SWAG**'s own dashboard lists its proxy
  confs; **Nginx Proxy Manager** lists its hosts.
  - Taken over: besides the labels, the proxy confs of a SWAG container
    (read with grep inside it, nothing changed): each `*.subdomain.conf`'s
    first real `server_name` and its `$upstream_app`, the app only when that
    container runs on the host.
  - Later (audit 2026-10-30, not SWAG-first): **caddy-docker-proxy**'s
    `caddy` / `caddy_N` labels (its first site address; https unless it says
    http), and **Nginx Proxy Manager**'s proxy hosts read the same way as
    SWAG's confs (`/data/nginx/proxy_host/*.conf`: `server_name`,
    `set $server`, `listen 443 ssl`), the app only when it forwards to a
    container that runs on the host. **Homarr** and **Dashy** read Traefik
    and their own labels only.

- **Copy and paste in a file tree** (report 67d3e6): **VS Code**'s explorer
  (Copy, Cut, Paste in a file's or folder's context menu; pasted on a file,
  into its folder), **code-server** the same.
  - Taken over: *Paste into ...* in the menu of a folder and of a file (into
    its folder), in a workspace's tree and on Files, beside the Files page's
    bar; any host to any host, followed as a transfer.

- **A paste where the name is taken** (report dfda31): **Material Files**
  asks per item (replace, skip, rename; "apply to all"), **Nautilus** the
  same (replace, skip, keep both as "name (copy)"), **Windows Explorer**
  replace, skip, or compare; pasted into its own folder all three make a
  numbered copy.
  - Taken over: one question for the whole paste with its names: keep both
    ("name (1).txt", the next free number; .tar.gz kept together, a folder
    numbered whole), skip, or replace (a fresh sign-in, as deleting). Into
    its own folder only keep both. Not taken over: per-item answers and
    compare (one paste is mostly one choice; the editor compares files).

- **Favourite folders of the phone** (report 9980fa): **Material Files**
  (bookmarks in its drawer) and **Amaze** (bookmarks beside the storage).
  - Taken over: the star at the end of a phone folder's path, as on a
    host's; the favourites listed on Files and on This phone. Kept in the
    app's own storage on the phone, not as a host's bookmarks on the server:
    the phone's folder names stay on the phone.

- **A container's details beside its log** (report 5d0b33): **Portainer**
  and **Dockge** show a container's details on a page of their own or a tab,
  the log in another; **Dozzle** keeps the log the whole screen and the
  stats in a bar above it.
  - Taken over: Dozzle's way, the log always in reach. Opened, the details
    (meters, history, properties) scroll in their own part of at most a
    third of the screen, the state line above them and the log below
    staying put; a check on every screen of the tour now fails when a log,
    editor or terminal is squeezed under 140 px (or 30% of a low screen).

- **A folder's size** (report 1b1aa2): **Material Files** and **Amaze**
  (Properties of a folder: its size with how many files and folders it
  holds), **Nautilus** ("Contents: 4,213 items, totalling 12.3 GB"), **WinSCP**
  (Calculate: size, files and folders).
  - Taken over: *Calculate folder size* says the size and how many files and
    folders are below it (du, and find for the two counts, in one command);
    "Calculating..." while it runs.

- **A picture of a very long page** (report 8344c1): **Sentry**'s user
  feedback and **Jam** take the screen as seen, not the whole page;
  **html2canvas** and **modern-screenshot** copy every element with its
  styles, which on a list of thousands of rows takes the memory of a phone's
  WebView.
  - Taken over: the whole page while it is not too long (8000 CSS pixels),
    else the part around the screen; the rows of a long list outside the
    part drawn are left out (a spacer in their place) while it is taken.

- **The phone's own files beside a server's** (report a9552e): file
  managers that show both, how they reach the phone's files.
  - **Material Files** and **Amaze** (SFTP and SMB beside the phone's
    storage): full file managers; they ask for "All files access"
    (`MANAGE_EXTERNAL_STORAGE`), which Google Play grants only to file
    managers and the like (Nextcloud's was refused in 2024), and which
    would let a page read every file of the phone.
  - **Termux** (`termux-setup-storage`: the storage permission, the whole
    shared storage).
  - **Signal** and **Aegis** (where backups go): a folder picked in
    Android's own folder picker (the Storage Access Framework), kept with a
    persisted permission; no storage permission.
  - Taken over: Signal's and Aegis' way. Folders the person
    picks in Android's folder picker (`ACTION_OPEN_DOCUMENT_TREE`), each
    kept with a persisted permission until it is removed here (then given
    back to Android), no storage permission at all. The page names a file
    by a folder id and names only, looked up child by child inside the
    granted tree, never by a path or a document id the page could make up.
    Copying uses what Burrow already had: to a host as the share target's
    upload, from a host as the app's own download (into the picked folder).
  - Left out: a second pane (one screen at a time on a phone), rename,
    delete and new folders on the phone (the phone's own file manager does
    those), and "All files access".
  - Amended (report 862305, the person's choice after the risk was put to
    them): "All files" as Material Files and Amaze have it, but opt-in,
    off by default: switched on after a warning that says the page (and
    whoever controls the server) could reach every file, then Android's
    `MANAGE_EXTERNAL_STORAGE` screen; the storage volumes listed beside the
    picked folders, named by a volume id and names looked up child by
    child, every path checked to be inside its volume as it really is (a
    link out is neither listed nor opened). Off again at once, and when
    another server is chosen.
  - Amended (report 6eaf00, the person's choice after the risk was put to
    them): delete, rename and new folders, as Material Files and Amaze have
    them, in the picked folders and "All files" alike, only where the
    person gave write access and the provider says it can (Android's
    `FLAG_SUPPORTS_DELETE`, `FLAG_SUPPORTS_RENAME`,
    `FLAG_DIR_SUPPORTS_CREATE`). Burrow's own: a delete is asked by the app
    in its own dialog, not by the page, so the page (or whoever controls
    the server) cannot delete a file of the phone without the person's tap
    there; a folder of "All files" is deleted without following a link in
    it; never a picked folder's or a volume's own top.
  - Amended (report 99d993, "as Material Files"): Material Files
    ([github](https://github.com/zhanghai/MaterialFiles),
    `FileListFragment.openFile`) sends an APK to the installer, opens what
    it can list (archives) as a folder, and hands the rest to another app;
    its file menu has Open with (always the chooser), Extract, Archive,
    Share and Properties. Taken over: the APK to Android's installer; zip,
    jar, apk, tar and tar.gz as read-only folders and unpacked beside
    themselves (Material Files reads more kinds through libarchive; Burrow
    keeps to what Java reads itself, no library), a file inside one shown by
    another app; Open with, Share and Properties. Left out: making an
    archive. Burrow's own: an entry's name that would lead out of the folder
    ("..", an absolute path, a link) is left out.

- **VS Code** Quick Open takes `file:line` and searches every folder of a
  multi-root workspace; Copy Path and New File/Folder are in the explorer's
  menu. Taken over (review 2026-10-24), as is opening a picture in a
  viewer instead of the text editor.

- **VS Code** (and **code-server**): the command palette (F1,
  Ctrl+Shift+P) finds every command by a few letters, shows its keys, and
  puts the ones used last first; **JetBrains** "Find Action" the same.
  Taken over: a workspace's palette with its own commands and those of the
  file in front (the tools menu's), Go to line among them. Ctrl+Shift+P is
  a private window in Firefox, so F1 and a button too.

- **VS Code**'s Source Control: Discard Changes per file and for all
  (asked first), the branch in the status bar to switch, and the editor's
  gutter marking lines against the last commit, not the saved text. Taken
  over (review 2026-10-24), the gutter falling back to the saved text for
  a file in no repository; a discard deletes a new file, so a step-up.
- **VS Code**'s split editor (groups side by side, a tab dragged or moved
  to the other) and its Outline and Problems views. Taken over: two sides
  on a wide screen (one on a phone), each editor kept when moved; the
  Problems list over the open files only, and the outline read from the
  text by language (headings, keys, sections, blocks, functions), so no
  language server has to see the host's files.
- **VS Code** (and code-server) find widget: one row with the field, the
  count ("3 of 12"), toggles for match case, whole word and regular
  expression inside or beside it, previous, next and close; replace a
  second row behind a chevron; Alt+Enter selects every match.
  CodeMirror's own panel lays out every field, button and box in rows
  that wrap. Taken over (report dccaf7): the editor's find panel is VS Code's
  shape in the app's controls, the options and Replace a second row on a
  phone, Replace's own row only when asked for.
- **VS Code** (and code-server) preview editors (`workbench.editor.enablePreview`):
  a file opened with one click shows in italics and is replaced by the next
  one so opened; a double click, an edit or a double click on the tab keeps
  it. Taken over (report 96a655) for a workspace's tree on a computer; on a
  phone every file keeps its tab (no double tap, no italics to notice).

- **VS Code** sizes the line numbers' side with `editor.lineNumbers`,
  `lineNumbersMinChars` (5 by default) and `lineDecorationsWidth`; Obsidian
  on a phone shows no line numbers unless they are turned on.
  - Taken over (report 202777): numbers stay on (Burrow is for files where
    a line's number matters), but on a phone in a smaller size, with less
    room around them and narrower fold and change columns.

- **VS Code** shows a line's problems as a squiggle in the text and a mark in
  the overview ruler at the right, with no column for them beside the line
  numbers; **JetBrains** IDEs and **Sublime Text**'s LSP put an icon in a
  gutter column of its own, which costs that column's width on every line.
  - Taken over (report 279f73, after 413d6f and f15675): no column of its
    own; a line with a problem has its number in the problem's colour, bold,
    on a tinted band across the line's side with a bar at its left, the
    squiggle and the count in the title bar as before.

## Containers, stacks and logs

- **Dozzle** and **Portainer** container lists: sorted by name, state, CPU
  or memory (Dozzle's column headers, Portainer's table).
  - Taken over (report d36ec8): the Containers page in the order chosen,
    by name, the busiest (CPU) or the most memory first, or problems first
    (as Apps' "Down first"); stacks by what they use together; kept on
    the device. A menu behind one icon, not a second dropdown (no room on
    a phone).

- **Cockpit** Logs page: the systemd journal per service and priority, read
  in the browser as the signed-in user.
  - Taken over: a host's services with their journal read like container
    logs (one or several merged), failed ones first, and a missing group
    membership said instead of an empty list.
- **Netdata** systemd-journal plugin: journal entries as a log source next
  to the metrics.
  - Taken over: a watched unit's journal goes through the same alert rules
    and reports as container logs and log files.
- **Dozzle** and **Portainer** follow logs through the Docker API: closing
  the request cancels it in the daemon. Over SSH, OpenSSH does not stop a
  command when its channel closes unless it has a terminal (`ssh -tt`, the
  usual advice): the command runs on until it writes, and keeps its session.
  - Taken over: a followed stream ends on the host with its channel, but
    without a terminal (it would mix stderr into the lines and change their
    endings): a watcher on the channel's stdin ends the command's process
    group when stdin ends (`endsWithChannel`).
- **Dockge** stack page: the compose file, the stack's terminal and its
  logs on one page.
  - Taken over: a stack's page has a shell in the stack's folder and its
    containers' logs in that panel, beside the services and the compose
    file.
- **Arcane** ([docs](https://getarcane.app/docs/guides/updates)): compose
  projects as real files, GitOps sync from a git repository, Trivy scans
  per image with "fix available"; updates per project recreate only the
  changed services; labels `...updater=false` (no auto-update, still
  checked) and `...update-check=false` (not checked at all); update
  strategies digest / auto / tag with constraints.
  - Burrow has: per-project updates, include/exclude labels for newer tags.
  - Taken over (N7): a label to keep checking but never auto-update one container;
    no vulnerability scans (decided 2026-10-06, see Dockhand).
- **Komodo** ([github](https://github.com/moghtech/komodo)): stacks from git
  with webhooks, an agent per server, resource sync. Burrow stays agentless
  (SSH only); git-backed stacks are out of scope for now.
- **Dozzle** ([github](https://github.com/amir20/dozzle)): live merged logs,
  alert expressions with ntfy/Discord/webhooks, SQL (DuckDB) over logs, AI
  that triages noisy alerts and answers questions about logs in plain words.
  - Burrow has: merged timelines, alert rules, AI analysis, log files.
  - Taken over (N6): ask a question about logs in words, turned into
    Burrow's own filter (shown, editable, never run as code).

- **Portainer CE** ([docs](https://docs.portainer.io/)): stacks from the UI or
  git, a webhook per stack that redeploys, an agent for remote hosts, RBAC,
  app templates; pages for images, volumes and networks with prune.
  - Taken over (N10): images, volumes and networks per host, with what uses them
    and a prune that says what it will remove first.
  - Leave out: app templates and stack webhooks (Burrow is an admin tool on
    the LAN, not an app store or a CI target).
- **Dockhand** ([site](https://dockhand.pro/)): stacks from git with
  webhooks; updates that pull to a temporary tag, scan it (Grype, Trivy) and
  deploy only when the vulnerability count does not rise; restic backups of
  volumes, bind mounts and stack files on a schedule, with retention and a
  restore that redeploys the stack, also on another host.
  - Not taken over (decided 2026-10-06): a scan before an automatic update
    (trivy on every host over SSH is heavy) and restic backups per stack
    (the host's own backup does this; Burrow shows its status).
- **Cosmos** ([github](https://github.com/azukaar/Cosmos-Server)): reverse
  proxy with HTTPS, a Nebula mesh VPN (Constellation), an identity provider
  for the apps, an app store, restic backups. Burrow keeps its own WireGuard
  in the app and leaves the proxy and app SSO to SWAG/Authelia.

- **Dozzle** ([github](https://github.com/amir20/dozzle)) groups containers
  by compose project in its side list, each group folded or open;
  **Portainer** and **Dockge** list stacks first and their containers one
  click deeper. Burrow keeps one page of all containers and folds a stack
  away by its arrow, kept per device; folded, it still says how many need a
  look, and a search or a state filter opens every stack (report df6153).

- **Docker Swarm** (`update_config: failure_action: rollback`, `monitor`)
  and **Kubernetes** (`progressDeadlineSeconds`, `kubectl rollout undo`)
  watch a rollout for a while and roll back one that does not come up.
  - Taken over (decision 11): a deploy's recreated services are watched for
    60 s like an update; not well, the compose file as Burrow last deployed
    it and the previous images go back on. Without a known previous file
    nothing is put back, and that is said.
- **Dozzle** streams a container list's changes (events, stats) to the
  page rather than the whole list again; **Portainer** reloads its lists.
  - Taken over (decision 19, OPS-W-03): the whole host once per watch, then
    only what changed each poll; a poll with no change is a few bytes, so a
    host that sends nothing at all is seen as not answering.

- **Dockge** lists every stack in its stacks folder, also one that is down,
  with Start; **Portainer** shows a stack it manages as "inactive" with
  Start. Burrow reads stacks from Docker's labels, so one brought down was
  gone. Taken over (review 2026-10-24): a stack brought down from Burrow is
  remembered with its files, listed under Down and brought up from there;
  one brought down elsewhere stays unknown (Burrow scans no folders).

- **Portainer**'s container list is an HTML table: a column
  as wide as its longest value, the name taking what is left.
  - Taken over (report 6fa349): a stack's rows share one table's columns
    (CSS subgrid), the state as wide as its words up to 40 characters, the
    update column only as wide as a flag in it; each row its own grid of
    shares had broken "running 14 days | healthy" over two lines.

## Image updates

- **Uptime Kuma** checks for a newer version of itself (a version address
  of its own, switchable in its settings), whatever way it was installed.
  - Taken over (2.22.0): an install on Burrow's prebuilt images reads its
    releases on GitHub (a git checkout still asks its upstream), and names
    the image tag that reaches the new version when its own does not.
- **Renovate** ignores a version once its pull request was closed without
  merging; **Watchtower** has no memory of an update that went wrong.
  - Taken over (W-FUNC-03): a digest that was rolled back is not tried again
    by the maintenance window until the registry has another; by hand it is
    asked first.

- **What's Up Docker**, **Watchtower**, **Diun**: semver include/exclude
  (Burrow took this in F1); Watchtower's pre/post update hooks; WUD's
  thresholds (only patch or minor updates go automatically).
  - Taken over (N1): auto-update only up to a level (every new version by
    default, minor, or patch); a bigger step waits for a person, and so does
    a breaking change the release notes announce, whatever the level.

- **What's Up Docker** and **Arcane** link an update to its release notes;
  Burrow shows them (GitHub releases of `org.opencontainers.image.source`)
  in the stack's update and, since report ac3a68, from a container's own
  "Update now" question, and says so when the image does not tell where its
  notes are.

- **What's Up Docker** and **Diun** read an image's version from its tag or
  its OCI labels; **Renovate** knows the official images' versions from
  their tags, and the Docker library images (postgres, redis, nginx,
  valkey) carry it only in their own `*_VERSION` variable (`PG_VERSION`,
  `REDIS_VERSION`), not in a label.
  - Taken over (report 9190c5): the version is the label when it is a
    version (not `latest` or `main`; `1.1.1-amd64` and `0.26.2.0+e472ecd7`
    cleaned), else the image's own `<name>_VERSION` variable, else a tag
    that is a whole version. Notes of the line the tag follows (`valkey:9`:
    the 9.x releases), and a new major version only against the highest
    before it, as **Renovate** compares versions, not the order on GitHub
    (a backport of 8.0 published after 9.0.7 is no "new major version").
    The dialog says why when it cannot match: no version, or one not among
    the last 100 releases.

- **Home Assistant** and **Immich** show a release's notes in the app
  (Settings -> About, or a dialog after an update). Taken over (report
  4c30b4): About Burrow shows the release's few sentences (the F-Droid
  changelog, English and Dutch) and links to the whole CHANGELOG.

## Monitoring, alerts and disks

- **Beszel** has a "Status" alert per system: told when it goes down (after
  a minute) and again when it is up. **Uptime Kuma** waits a number of
  failed checks (retries) before it calls a monitor down.
  - Taken over (2.22.0): *Host unreachable*, a built-in rule of its own,
    told at the second statistics round in a row that cannot reach the host
    and once when it answers again.
- **fail2ban** bans an address after a few failed logins in its window;
  **Prometheus**' scrapes and **Beszel**'s agent connect on every interval
  whatever the last one said.
  - Taken over (2.22.0, not the second): Burrow's rounds in the background
    (statistics, the container monitor, SMART, packages) wait out a host
    whose connects fail, as its alert streams do: from ten seconds, five
    minutes after a refused login, doubled up to half an hour.
- **smartd** (`-n standby` in smartd.conf) skips a sleeping disk rather
  than spinning it up for a check.
  - Taken over (decision 5): Burrow's SMART check does the same and keeps
    the disk's last reading, saying when it was taken.
- **cAdvisor** reads each container's block I/O from its cgroup (`io.stat`
  on cgroup v2), writeback included.
  - Taken over (decision 6): the disk activity view lists each container's
    bytes per disk from its cgroup, next to the processes.
- Docker names a container itself (`adjective_surname`) when `docker run`
  is given no name; such throwaways (tests, builds) are most of the exits.
  - Burrow (decision 18): no alerts for them outside compose; named ones and
    a stack's alert as before.

- **Beszel** keeps a history per container (CPU, memory) and charts it
  over a chosen period; **Dozzle** shows live stats only, nothing kept.
  - Taken over (report 428102): CPU and memory per container every five
    minutes, a month kept, a day / week / month chart on the container's
    page, and the list's sparklines starting with the kept hour.
  - Grafana, Beszel and Netdata show the time and value under the pointer
    in a tooltip beside it, across all charts of a panel. Taken over
    (report af0eec): one history chart for a host, a container and a disk,
    the moment nearest in time under the pointer (also across a gap in
    the samples) in a tooltip beside it, the same moment in each chart.

- **Beszel** ([github](https://github.com/henrygd/beszel)): alerts for CPU,
  memory, disk, bandwidth, temperature and down, with a duration ("CPU over
  90% for 5 minutes"); per-container history.
  - Taken over (N2): a duration on host alerts, so a short peak does not alert.
- **Uptime Kuma**: maintenance windows that silence alerts, keyword checks,
  push (heartbeat) monitors, resend while still down.
  - Taken over (N3): no alerts for containers that Burrow's own update window
    restarts on purpose. Still open: a keyword check for app uptime.
- **Gatus**: conditions such as status, body, response time and certificate
  expiry in one check. Burrow has the TLS expiry (F2).
- **Scrutiny** ([github](https://github.com/AnalogJ/scrutiny)): SMART with
  history and thresholds from Backblaze's real failure rates instead of the
  manufacturer's.
  - Taken over (N4): each disk judged by Backblaze's five attributes (5,
    187, 188, 197, 198): above zero is "watch it", growing since the oldest
    check kept (one a day, 90 days) is "failing". Not taken over: Scrutiny's
    per-value failure-rate buckets (their numbers depend on drive models
    Burrow cannot know).

- Disk activity per disk, and who reads and writes (report d4a9c0: "my
  hard disk spins all the time; which processes are writing?"):
  - **iostat** (sysstat) is the reference for a disk's numbers: from
    /proc/diskstats, per device, kB/s read and written, reads and writes a
    second, and %util (the io_ticks counter: the share of the time the
    device had I/O in flight).
  - **Beszel** charts disk I/O (read and write MB/s) per system and per
    extra filesystem, through its agent; no processes.
  - **Glances** shows per disk R/s and W/s (IOPS optionally) and, in its
    process list, each process's I/O read and write rates from
    /proc/<pid>/io (psutil); other users' processes need root and show as
    "?" without it.
  - **netdata** draws per disk io, ops, util, backlog and await, and per
    application group (apps.plugin, setuid or with capabilities) the disk
    reads and writes from /proc/<pid>/io; per container from the cgroup's
    blkio/io.stat.
  - **iotop** reads the kernel's taskstats over netlink (root or
    CAP_NET_ADMIN): per thread, with the share of time waiting for I/O;
    `-o` only the active ones, `-a` accumulated. The same counters as
    /proc/<pid>/io, but it needs a netlink client on the host.
  - **hdparm -C** and **smartctl -n standby** (smartd's `-n standby`) ask a
    drive for its power state with CHECK POWER MODE, which does not spin it
    up; root only. /sys/block/<dev>/device/state is the SCSI device's state
    ("running", "offline"), not whether it spins; device/power/runtime_status
    says "suspended" only when the kernel's runtime power management spun it
    down, not when the drive's own standby timer did.
  - Taken over: iostat's numbers per whole disk (partitions, loop, device
    mapper and RAID devices left out) in the same one-second read as the
    CPU, and its counters kept with every five-minute sample, so the history
    is the average of each interval (a disk woken now and then shows; one
    second's look would miss it). A hard disk's state: the drive asked as
    root (hdparm -C, else smartctl -n standby), the kernel's "suspended", or
    "active" when it did I/O just now; otherwise "unknown" - nothing is run
    that would wake it. Glances' and netdata's per-process /proc/<pid>/io,
    without an agent: one grep reads every process's counters, twice, two
    seconds apart, on demand only while the view is open; the busiest ten
    then get their name, container (the cgroup's id, named from the
    containers Burrow already reads) and open files (`ls -l /proc/<pid>/fd`,
    whose link mode is the open mode), each file put on its whole disk
    through the process's own mount table (a container's overlay through its
    upper layer in the host's mounts, LVM, LUKS and RAID through
    /sys/block's slaves). As root through sudo with the stored password (as
    SMART); refused, the SSH user's own processes, said so with sudo's words
    and not asked again for a quarter of an hour (each refusal is a failed
    sudo in the host's log). Admins only: it reads every process as root.
  - Not taken over (yet): iotop's per-thread view and I/O wait share
    (taskstats needs a netlink client on the host). A process's write counts
    when it is made, and the flush threads that put it on the disk show no
    files; the per-container numbers from `io.stat` (above) count that
    writeback.

- **PocketBase** (under **Beszel**) has backups in its admin screen: make
  one now, download, restore. Burrow's backups are made by a separate
  service that holds the key Burrow does not, so Settings -> Backups asks
  that service for one now (a request file in the data volume) and offers
  the newest encrypted archive for download (the backups folder mounted
  read-only); a restore stays a command with Burrow stopped (report 445f22).
  - 2026-11-07: Settings -> Backups shows that command for the newest
    archive, with a copy button and what it does.
- **Healthchecks** and **Uptime Kuma**'s push monitors are dead-man
  switches: a job calls a URL on a schedule, and the service alerts when
  the calls stop. Backup tools (Duplicati, restic wrappers) and cron jobs
  use them to say they ran.
  - Taken over (2026-11-07): Burrow calls `HEARTBEAT_URL` (or the address
    in Settings -> System) every five minutes while it runs well, so being
    down, stuck or full is told by someone else; its own notifications
    cannot.
- **Home Assistant**'s Repairs and **Uptime Kuma**'s notifications about
  itself tell an admin about the tool's own troubles, not only the
  monitored things.
  - Taken over (2026-11-07): Burrow sends over its channels, once per
    problem and once when it is gone, a job that keeps failing, its data
    disk filling (under 1 GB or 5 % free), a channel that fails (through
    the others), new errors in its own log, a new version (checked daily)
    and a self-update that failed or was rolled back; and once a week
    "Burrow runs" on every channel, whose silence means something broke.
- **fail2ban** bans an address after a few failed logins (by default 5 in
  10 minutes), so a tool that logs in for you must not retry a refused
  login at once.
  - Done (2026-11-07): Burrow's alert streams wait longer after
    each failed connect (10 s doubling up to 30 min, 5 min first after a
    refused login), and try again within seconds when the host's
    password or key is changed.

## Host administration

- **Cockpit**, **Termix** managers: systemd services, the journal, cron,
  packages, users, firewall.
  - Taken over (1.19.0): the journal (`journalctl -u`) as a log source
    beside containers and log files, with the same functions (System logs).
    Not taken over: managing services, cron, packages, users or the
    firewall (a terminal does that).
- **UpSnap** and **Home Assistant**'s `wake_on_lan` send the magic packet
  from their own container, which only reaches the LAN with host
  networking (Home Assistant takes a broadcast address to aim it).
  - Taken over (2.11.0): besides a host that is up (Burrow's way since
    1.x, which works in a bridge network), per host one chosen sender or
    Burrow itself, with the warning about host networking or macvlan; the
    packet goes to 255.255.255.255 and the host's /24 broadcast. A MAC
    address of its own for a host Burrow never reached.
- **Cockpit** (Software Updates, through PackageKit), **Webmin** (Software
  Package Updates) and **Proxmox VE** (a node's Updates panel): the
  packages that can be updated, security updates marked apart, and whether
  a restart is needed; Proxmox refreshes the lists daily itself and shows
  when. **Zabbix**'s and **Netdata**'s apt checks only count them, without
  root. **PatchMon** needs an agent on each host.
  - Taken over (2.11.0): what apt, dnf, apk or pacman says can be updated,
    read every six hours without root and without a refresh (Debian and
    Ubuntu run apt-daily; the lists' age is shown, and said as old after a
    week), security updates first (a `-security` suite, dnf's security
    advisories), a restart asked for (`/var/run/reboot-required`,
    `needs-restarting -r`); a mark on the host list, the host's statistics,
    a Host health alert for new security updates, a line in each report.
    Not taken over: installing them (Cockpit's Install all) - the command
    is there to copy into a terminal, as Burrow runs nothing on a host by
    itself.
- **Cronicle**, **Rundeck** and **Semaphore** run jobs on a schedule on
  chosen servers and keep each run's output; **Webmin** edits cron itself;
  **healthchecks.io** is told when a cron job did not run or failed.
  - Taken over (2.11.0): scheduled commands in Burrow, not in a host's
    crontab: weekly, daily or cron in a time zone (the reports' scheduler),
    on chosen hosts as their own user, a time limit (`timeout(1)` on the
    host), each run's output kept 30 days, a failure or a time-out a Host
    health alert (healthchecks.io's job). Not taken over: Rundeck's
    workflows and retries, Cronicle's job chains. sudo only without a
    password (`sudo -n`): nobody is there to type one, and Burrow does not
    hand the stored password to a command nobody watches.
- **restic** (`forget --keep-within ... --keep-last ...`) and **borg**
  (`prune --keep-within`) keep backups by age and by count together.
  - Taken over (decision 17): Burrow's own backups by age (30 days), capped
    at 60, the newest 30 kept whatever their age so a stopped backup service
    does not end with none.

- **Cockpit**'s Software Updates fetches the package lists (PackageKit's
  refresh) when it is opened or on "Check for updates"; **Webmin** does the
  same on its updates page. Both need root for it.
  - Taken over (report 1f6c0c): lists older than a week can be fetched at a
    press, through sudo as SMART, after a fresh confirmation; Burrow does not
    do it by itself, and shows the timer that has the host do it every day
    (apt-daily, dnf-makecache). apt marks the refresh as its daily one does.

## Apps

- **Homepage**, **Homarr**: apps found from container labels with groups and
  icons. Burrow reads `homepage.*`, Traefik, Caddy and SWAG labels already.

## AI

- **k8sgpt**, **HolmesGPT**: analysers with anonymisation; HolmesGPT runs
  read-only tools on its own to gather evidence. Burrow never runs anything
  by itself; it stays that way.
- **Google** documents an OpenAI-compatible endpoint for the Gemini API
  (base URL `https://generativelanguage.googleapis.com/v1beta/openai/`,
  the Gemini API key as the bearer token): chat completions, streaming,
  JSON schema output and the model list, so a client written for OpenAI's
  API reaches Gemini by its address and key.
  - Taken over: Gemini is its own choice in Settings -> AI (a key and a
    model, no address to type) on Burrow's OpenAI-compatible client;
    always external, like Claude.
- **Open WebUI**, **LibreChat**: tokens per answer and cost.
  - Taken over: tokens per analysis and an estimated cost from prices set
    in Settings -> AI, as LibreChat does with its configured rates; the use
    per month in Settings -> AI (report 18efc8).

- **GitHub Copilot in the CLI** (`gh copilot suggest`) and **Warp**'s AI:
  a suggested command can be revised ("Revise command", a follow-up in
  Warp's conversation) or explained, and earlier answers stay in the
  conversation; neither runs a command without the person.
  - Taken over (report 411dbe): the terminal's AI dialog is a conversation
    kept with the terminal session on the server (closing the dialog or
    another device keeps it; at most 20 turns, gone when the session
    ends), newest last; a question goes with the last four turns, masked
    and cut short, explanations left out; any earlier suggestion can be put
    on the line again or copied. Still never run by Burrow.

- **k8sgpt** (`analyze --explain --interactive`), **HolmesGPT** (`ask`
  with follow-ups) and **Datadog Bits AI**: after an explanation the person
  asks further in the same conversation, the earlier answer going along.
  - Taken over (report 0a86b2): a question under an analysis goes to the
    model with the logs as they were sent, the analysis and the questions
    before (each masked again for the provider it goes to), kept with the
    analysis and shown with it on the Reports page; at most 10 per
    analysis, counted in the hourly limit; still never run.

- **VS Code** (Copilot Chat: "Explain", inline chat on a selection) and
  **JetBrains AI Assistant** ("Explain code", chat with the selection or
  the file attached): the selection, else the file, goes along with the
  question; the answer is shown, a change applied only when the person
  takes it.
  - Taken over (report 76bcda): *Ask AI about this file* in the editor's
    menu and the palette: the selected lines or the whole file, numbered
    as in the file, masked and cut to the model's window, with the
    question; answered as Markdown, asked further like an analysis, kept
    per file and per person. Not taken over: applying a change (Burrow's
    AI never changes anything itself) and an inline chat in the text.

- **Grafana** (its LLM features) and **Datadog** turn a question in words
  into a query of their own log language, shown in the query editor before
  it runs.
  - Taken over (N6): a question about logs becomes the log viewer's own
    filters, set on its controls and said in a line with Undo; only the
    question and the source names go to the model, never a line.

## Android and the tunnel

- **Home Assistant**'s companion app has home screen widgets (an entity's
  state, refreshed by its own push and every 15 to 30 minutes); **Nextcloud**
  and **Proxmox**'s app have none for status. Android lets a widget update
  itself every half hour at most (`updatePeriodMillis`).
  - Taken over (2.11.0): a widget with counts only (hosts up, new alerts,
    hosts with package updates), nothing a locked phone should not show;
    every half hour and when the app is left. Away from home, chosen per
    phone: the app's own tunnel up for a few seconds, the last numbers with
    their time, or Burrow's push (UnifiedPush, as Home Assistant's own push)
    when the numbers change.

- **wg-easy**, the **WireGuard** app: a client config as a QR code, scanned
  by the app. Take over: import a tunnel by QR code (#96).
  - Taken over: a picture of the code since 1.1.0 (read in the page), and
    the camera itself (ZXing's embedded scanner, no Google services) in the
    app; the scanned configuration goes straight to the app, never through
    the page, and the scanner is kept out of screenshots.
- **Tailscale**: device import into Termix. Not for Burrow (own WireGuard).
- **Firefox for Android**, **Chrome for Android**: a download asks first in
  the browser's own sheet from the bottom (the file's name and size, Cancel
  and Download side by side), not in Android's platform dialog.
  - Taken over (decision 23): the app's download question, and an app
    tab's sign-in, in Burrow's own dialog look (a sheet on a phone, a box
    in the middle on a tablet, Cancel and the primary button as wide as
    each other), light or dark as the app.
- **Google's device list** (myaccount.google.com, "Your devices") and
  **Tailscale**'s machines: a device shows when it signed in first and was
  last active, "This device" is marked, and Tailscale's can be renamed.
  - Taken over (UIA-15): paired phones show when each was paired and when
    last used, "this device" in both of Settings -> Android app's lists,
    and a phone can be renamed (two of one model, or one paired again,
    read alike before).
- **Home Assistant**'s companion app has an entities widget: each entity on
  a line with its state, a tap opens it.
  - Taken over (report 05a818: the counts alone said too little): the
    widget lists each host on a line, a dot for up, down or not known yet,
    down first, its updates at the right, as many as its height holds and
    the rest counted; a tap opens the host. Home screen only, as before.

## Motion and polish

- **Linear, Vercel** dashboards: short (150-250 ms) ease-out transitions,
  dialogs that fade and scale from 0.96-0.98, a sliding tab indicator,
  skeletons where content will be; all of it off with
  `prefers-reduced-motion`. **Radix / shadcn** (and **Arcane**, built on
  shadcn-svelte) animate dialogs the same way with enter/exit keyframes.
  **Material** motion: durations by distance travelled, decelerate in,
  accelerate out.
  - Taken over (1.23.0): three duration tokens and one curve, dialogs in and
    out (CSS `@starting-style` and `allow-discrete`, so open/closed stay
    immediate for the code), the sliding tab line, skeleton lists, pages and
    toasts arriving; reduced motion turns it all off. Left out: spring or
    bounce effects, motion on live-updating numbers.

- **GitHub** settings and **Proxmox VE**'s side tree: the section list at
  the left scrolls with the page (GitHub) or the list is the window's own
  pane on an app-like screen (Proxmox); a content page with a list cut at
  the window's height that scrolls inside it is a second scroll bar beside
  the page's (**Bootstrap**'s docs sidebar does that: sticky with a
  max-height and its own scroll).
  - Taken over (report 9abc2b): the Settings list stays in view beside a
    long part only while all of it fits in the window; taller, it scrolls
    with the page. The tour checks every page for a second scroll beside
    the page's (files, terminals, logs and text boxes keep theirs).

- **Material** and **Apple's Human Interface Guidelines**: on a phone a
  form's main button spans the width (a "full-width" or "block" button at
  the foot of the form); on a wide screen it is as wide as its words, at
  the end of the row. **GitHub** mobile and **Home Assistant**'s companion
  app do the same in their settings; Home Assistant keeps a row of chips
  (its dashboard's badges) on one line that scrolls sideways rather than
  wrapping above the cards.
  - Taken over (reports 9d013e, ac7e33, 17c4ec, e67a3f, 6bd934, f1b358):
    in the phone's layout (the tab bar at the bottom, under 720 px, so a
    folded-open phone too) a button or field alone on its line takes the
    line, also a title row's button wrapped under its title; the tour
    checks it on every screen. The apps open as tabs: one row, sideways.
  - Later (reports c7665e, 46158b and seven more, 2026-11-02): on a
    computer the same in Settings' parts, a narrow column beside the list of
    parts: Save, Audit log, a lone select as wide as the column, buttons
    side by side sharing it, Open/Solved over the whole line.
- **Grafana**'s log rows in Explore: a line's copy and copy-link as small
  icon buttons on the line itself, not a row of their own.
  - Taken over (report 41947e): a chosen log line's Pin, Copy link and Copy
    on one row, an icon and a short word each, the icons alone where the
    words do not fit; on a phone no row of buttons goes over two rows.
- **Files (Android)**, **Gmail** and **Google Photos**: things chosen turn
  the top app bar into the selection's bar (close, the count, Select all,
  then what to do as icons); **Google Drive** on the web does the same with
  its toolbar. Nothing is laid over the list at the bottom.
  - Taken over (reports 1d6881, 7ff350, b06954): a host's files and the
    phone's own files, files chosen, have their title bar say how many and
    what to do (words beside the icons on a computer); the two-row bar at
    the bottom is gone.
- **Android's Settings** and **Home Assistant**'s automations list: a thing
  is switched on or off on its row; its editor is for what it does.
  - Taken over (reports e2d7d2, 3f6c59, 56d146): channels, report schedules
    and scheduled commands are switched on or off only on their row; their
    forms have no switch, a new one is on.

- **Termius** and **Warp** offer commands from history as snippets: picked,
  they open in the snippet editor filled in, to be named and changed before
  saving.
  - Taken over (report 76b6df): a suggestion's row opens the snippet form
    filled in, as a saved snippet's row opens it; its menu says "Edit and
    save as snippet".

- **Material**'s snackbar: the message takes the line and its one action
  (Retry, Undo) sits at the end as wide as its word; a message too long for
  one line wraps beside it, the action never stretches.
  - Taken over (report a3c513): the terminal's "the list of sessions could
    not be read" takes the line, Try again its own width beside it; the tour
    checks every screen for words squeezed beside a wider button.

## Sign-in

- **Termix**: OIDC, LDAP, GitHub, Google; TOTP and passkeys; four sharing
  levels. **Pocket ID**: passkey-only OIDC.
  - Burrow has: passkeys, TOTP, OIDC, admin and operator. LDAP and more
    roles: not for a one-household tool (the guest role was dropped).

## Problem reports

- **Sentry Session Replay** masks all text and inputs by default
  (`maskAllText`, `maskAllInputs`) and lets a page unmask parts on purpose;
  **PostHog** masks inputs by default. Taken over (report 50a6f6, whose
  picture showed a whole `.env`): a report's picture covers what files,
  terminals and logs show (parts marked `data-private`, a tour check that
  none is missed), and the person can tick to send them as they were.
  Passwords in fields were left out of the picture already.
- **GitHub** issues and comments, **Linear**, **Jira**: Ctrl+Enter sends a
  form; a picture pasted (Ctrl+V) or dropped on it is attached. **Sentry**'s
  feedback widget stays on the page for the next report. Taken over (the
  user, 2026-10-30, reporting from a computer): the same in the report form,
  the red button kept on until turned off, and the existing Ctrl+Shift+B
  said where reporting is set up and on the button.
- **Sentry** (Android SDK, `attachScreenshot`) and **Instabug** take a
  report's screenshot natively, from the app's own window (`PixelCopy`),
  not by drawing the web page again. Taken over (the user: "the picture is
  not the screen I see"): the Android app copies the WebView's pixels as
  they are on the screen (`Screenshot.kt`), the page covers the
  `data-private` parts on that picture as before; browsers keep the page's
  own drawing (modern-screenshot), as no browser API copies the screen
  without asking.

## Translations

- **Uptime Kuma** and **Dockge** (same author) translate on a hosted
  Weblate (weblate.kuma.pet), with one flat JSON file per language
  (`src/lang/*.json`, `frontend/src/lang/*.json`), English the source.
  - Taken over: one flat JSON file per language with English as the base,
    which Weblate's "JSON file" format edits as it is; the Android strings
    stay Android resources, also a Weblate format. Left out (for now): a
    hosted Weblate project, which the maintainer sets up after publishing;
    ICU plurals (Burrow keeps its own `{n:one|other}`, tested per language).

## Settings in the app or in the environment

- **Dozzle** is set up only through its `DOZZLE_*` environment variables
  (or the matching flags): no settings page for the server.
  - Taken over: what Burrow needs before anyone signs in (its address, the
    master key, the proxy's address) and what Docker sets up stays in the
    environment. Not taken over: the rest only there. The terminal limits,
    the online check, the update check's exceptions, registry addresses and
    the apps' domain are in Settings -> System as well, the environment's
    value the default and said under each field, so an install keeps what it
    has and a change needs no restart.
