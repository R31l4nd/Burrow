# Burrow's interface

How every screen looks and behaves, on a laptop, a phone and in the Android
app. The rules here are checked: in the tour (`e2e/tests/workspace-tour.spec.ts`
and `e2e/tests/checks.ts`) and in `web/src/*.test.ts`. A rule without a
check is marked so. The tour makes six passes over every page and dialog:
a phone, a laptop, Dutch on a 343 px phone, dark mode on a phone, Dutch on
an 820 px tablet (touch) and dark mode in Dutch on a 1440 px computer
(where the rail is). All six run the layout checks; the accessibility scan
(axe) runs in all but the small Dutch phone, the help-tip checks on phone
and laptop. Screens made once
(the paired phone, the signed-out sign-in and invite pages) are looked at in
the phone pass. `e2e/tests/workspace-sizes.spec.ts` runs the 16 main pages
it lists at 11 sizes with the layout checks (the editor, a workspace, a
stack, a report and a container's page only in the tour); the states each screen is shown in (empty,
loading, error, many) are listed in the tour, not all of them in every pass.

## Screens

- Every page and every dialog is in the tour. A dialog has a name
  (`<Dialog tour="...">`) and the tour fails when one was never looked at;
  pages are listed in `e2e/tests/pages.ts`.
- The main content keeps the screen. An editor, terminal or log has at
  least 65% of the height on a phone (50% with the keyboard open); on list
  pages the bars above the first list or card take at most 22%.
- No sideways scrolling of the page. A dialog fits the screen; a long one
  scrolls inside.

## Sizes

- A phone (below 720 px): one column, rows of two lines.
- A tablet (720 to 899 px, e.g. an iPad or a foldable upright): the
  phone's navigation at the bottom and its title bar, but lists that are a
  table on a computer are a table here too (hosts, containers with their
  sparklines, files), and app tiles in a grid (`tablesFromTablet` in
  checks.ts). The busy list opens from its pill at the foot.
- A computer (900 px and more): the rail on the left, buttons as wide as
  their words (a view switch too).

## The top bar

- The page title, with its help tip right beside it (never at the far end).
- The page's own actions as icons or small buttons on the right: search,
  check for updates, save, a menu (three dots) for the rest. One save button per
  screen.
- Status that is only news when something is wrong (updates, problems) is a
  badge that appears then, not a line that is always there.
- On a phone and tablet the bar (and a row of tabs under it) runs from edge
  to edge of the screen, its contents over the page's column.

- A page's own Back (the arrow at the start of its bar) goes up to the
  page it belongs to: a container, a stack or merged logs to Containers, a
  host's statistics, journal or form to Hosts, a file to its folder (or
  the stack it was opened from), also when the page was opened from a
  link, a push or another section. When that page is the one before in
  the tab's history, it goes back there. The browser's and the phone's own
  Back go back in history (`workspace-back.spec.ts`).

## Buttons and links

- An action is a button; a text link only goes somewhere.
- Green (primary) only for the one confirming action of a form or dialog:
  Save, Deploy, Send. Creating something on a page ("New rule", "Add app")
  is a small outlined button with a plus.
- Destructive actions are red (outline), and ask first.
- Buttons side by side have the same height and fit on one line; if they
  do not fit on a phone, they stack.
- One width rule per screen size: on a phone an action button is full
  width; several actions side by side (`.btnrow`) fill the line together.
  On a tablet and a computer too, a row of actions in a card, a form or on
  a page fills its line, one width each (report 71a779: words-wide at the
  left beside a card whose row filled it); a button alone on its line in a
  card or a form is as wide as the column, as on a phone (report d4ba33).
  A title bar's, a list row's, a toolbar's or a card head's button stays as
  wide as its words. A full-width button never sits beside narrow ones
  on one line. A dialog's footer is the
  exception on every size: its buttons share the line (Cancel beside the
  confirming one), so the confirming one is always in the same place.
- Boxes (buttons, fields, chips, cards) never touch or overlap: there is
  always a gap, also between a search box and the list under it.
- Words never lie over other words: a line that wraps pushes what is under
  it down (report 71a779).
- Menus: every item has an icon, or none has.
- A button's label says what happens; the same action has the same word
  everywhere.
- A link into Burrow (a shortcut, a push, `burrow://open?to=...`, or any
  address with `?connect=`, `&analyze=1`, `?run=1`, `?review=1`) opens its
  page and never acts by itself: a terminal session, an AI analysis or a
  command starts only after a tap on a question that names the host, the
  logs and the model, or the command (`workspace-deeplinks.spec.ts`).
  The app's own shortcuts get no way around it.

## Lists, pills and text

- A list row: title and subtitle on two lines, its buttons on the right;
  the title is cut with "..." before its buttons are squeezed. A row has at
  most one thing to do beside its words (a tap on the row itself, a switch,
  one icon); more goes behind one menu button (three dots) at its end,
  never on a line of their own under it (`rowActionsBeside` in checks.ts).
- Items of two lines or more (rows, records, warnings) have a line between
  them (`listsApart`, `recordsApart`).
- Pills (host, state, "New") never touch each other and are never cut off:
  the name beside them is cut instead.
- Dates one way: the month in words and 24 hours ("28 Sep 2026, 16:05"),
  or relative ("2 minutes ago"). Never 9/28/26 or 4:05 PM.
- Words for people, not internal names (no "@temperature").
- Singular for one ("1 host"), in both languages.
- Two things with the same name are told apart ("test-sshd", "test-sshd 2").

## Forms and settings

- A single choice (a switch, a select) is saved at once.
- Fields that belong together (an AI provider and its key) have a Save
  button, say "Not saved yet" when changed, and ask before leaving.
- A feature that is off shows only its switch; its fields appear when on.
- "Inherit" says what it inherits ("Inherit: Use when available").
- Help tips next to the field or heading they explain.

## Phone and app

- Touch targets are at least 36 px; key bars only while typing. The
  terminal's key bar and text box are the exception: 28 px high, the keys
  only as wide as their label (they take room from the terminal), and the
  key bar stays on a touch screen with the keyboard closed too, on purpose:
  its keys (arrows, Esc, Ctrl+C, page up and down) are used without typing,
  to answer a program or scroll it. On a computer with its own keyboard it
  is not shown.
- The terminal's bar (the way back, the session tabs) stays with the
  keyboard up, compact (36 px); only a screen lower than 300 px (a phone
  turned on its side with its keyboard up) leaves it out (`termBarKept`).
- Something that can be opened or folded shows so (a chevron), also on a
  phone.
- Filters fold away behind one button on a phone; that button counts the
  filters that are on.
- The Android app's own screens (setup, lock, errors, direct route) follow
  the same rules and are looked at in `scripts/android-test.sh`
  (screenshots in `artifacts/android-screens/`). Errors are said in words,
  with the technical code small below.

## Accessibility

- axe-core finds nothing on any screen (contrast included: a link on a
  tinted box takes the text colour).
- Every control has a name; icons without text have an aria-label.
- Motion respects "reduce motion".

## Motion

- Quiet and quick: three durations (`--dur-1` 120 ms for a control's colour
  or press, `--dur-2` 200 ms for something arriving, `--dur-3` 320 ms for a
  line or bar travelling) and one curve (`--ease`). Nothing bounces or
  loops, except a spinner and the waiting shimmer.
- A dialog fades and rises in (a phone's sheet from the bottom) and back
  out; the page fades in; a toast rises in; the line under the section tabs
  slides to the tab chosen; folded parts open by their height.
- Waiting for a list or numbers shows their shape (`Skeleton`), not the
  word "Loading..." in an empty page.
- Every transition and animation uses the tokens (web/src/conventions.test.ts),
  so the system's "reduce motion" stops all of it; the e2e specs run that way
  and workspace-motion.spec.ts looks at the motion itself. A spinner has its
  own reduced-motion rule: with less motion asked for, nothing turns or pulses
  for ever (`stillWhenAsked` in e2e/tests/checks.ts, on every screenshot).
