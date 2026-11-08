// Text put on a terminal's input line without running it (an AI answer, a
// snippet's Paste, a suggestion): nothing in it may act as Enter or another
// control key. A carriage return in an AI answer, or the line break of a
// multi-line snippet, ran the line before the person said so.

// Every control character except tab and line feed.
// eslint-disable-next-line no-control-regex -- control characters are what it takes out
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** One line: control characters out, line breaks (and CR) as spaces. */
export const oneLine = (text: string): string => text.replace(/\r\n?|\n/g, ' ').replace(CONTROL, '');

/**
 * How to put text on the line without running it: a single line goes as it
 * is; several lines go to the text box, to be looked at and sent by hand.
 * Not as a marked (bracketed) paste either: inside a tmux the terminal keeps
 * marking pastes while the shell in the pane no longer asks, and tmux hands
 * the lines over unmarked, each running (AUDIT2 TERM-02).
 */
export function pasteSafely(text: string): { send: string } | { stage: string } {
  const clean = text.replace(/\r\n?/g, '\n').replace(CONTROL, '');
  if (!clean.includes('\n')) return { send: clean };
  return { stage: clean };
}

/**
 * What the text box's Send does with its text: `run` sends and runs it,
 * else it goes onto the line to be edited there (Send held). Several lines
 * go as one paste when the program asks for pastes to be marked; otherwise
 * each with its Enter; held, several lines stay in the box.
 */
export function composePlan(text: string, run: boolean, bracketed: boolean): { paste: string; enter: true } | { type: string } | { keep: true } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // Held with several lines: each line break could be an Enter and every
  // line but the last would run (AUDIT2 TERM-02). Not even a marked paste is
  // safe: inside a tmux the terminal keeps marking pastes while the shell in
  // the pane no longer asks, and tmux hands the lines over unmarked. They stay.
  if (lines.length > 1 && !run) return { keep: true };
  if (lines.length > 1 && bracketed) return { paste: lines.join('\n'), enter: true };
  const joined = lines.join('\r');
  return { type: run ? `${joined}\r` : joined };
}
