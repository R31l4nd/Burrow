import type { ShellState } from '@burrow/shared';

// Where is the input on screen? With the shell integration Burrow knows the
// prompt text and whether the shell waits at a prompt; without it, the input
// is guessed from a typical prompt ending ($, #, %, >, ❯) and the UI says the
// completion is limited.

export interface InputLine {
  text: string;
  limited: boolean;
}

// A prompt ends in one of these, followed by a space, within 80 characters.
const PROMPT_END = /^.{0,80}?[$#%>❯»➜λ] /;
// On the alternate screen, or while a program runs (tmux, screen, but also
// vim or an assistant), only an unmistakable shell prompt counts: user@host,
// then $ or #. A "> " there is more often a program's own input line.
const ALT_PROMPT = /^.{0,40}?[\w.-]+@[\w.-]+[^$#\n]{0,80}?[$#] /;

/**
 * `rows`: the cursor's logical line (wrapped rows joined), cut at the cursor.
 * Returns null when there is no input line to complete (a program runs, a
 * full-screen app is open, or no prompt is recognised).
 */
export function extractInput(rowText: string, shell: ShellState | null, alternateScreen: boolean): InputLine | null {
  if (alternateScreen) {
    // A shell inside the person's own tmux: its prompt, guessed.
    const m = ALT_PROMPT.exec(rowText);
    return m ? { text: rowText.slice(m[0].length), limited: true } : null;
  }
  if (shell?.integration) {
    // A program runs (the integration says so). When it shows a shell's
    // prompt itself (a tmux of your own, an ssh further on), that one is
    // guessed as on the alternate screen; there is none since sessions
    // without tmux no longer switch to it (shared/src/altscreen.ts).
    if (!shell.atPrompt) {
      const m = ALT_PROMPT.exec(rowText);
      return m ? { text: rowText.slice(m[0].length), limited: true } : null;
    }
    const p = shell.prompt?.replace(/\s+$/, '') ?? '';
    if (p) {
      const at = rowText.indexOf(p);
      if (at >= 0) return { text: rowText.slice(at + p.length).replace(/^ /, ''), limited: false };
    }
  }
  const m = PROMPT_END.exec(rowText);
  if (!m) return null;
  return { text: rowText.slice(m[0].length), limited: !shell?.integration };
}

/** Minimal view of an xterm buffer, so this stays testable without a DOM. */
export interface BufferView {
  type: 'normal' | 'alternate';
  baseY: number;
  cursorX: number;
  cursorY: number;
  getLine(y: number): { isWrapped: boolean; translateToString(trimRight?: boolean, start?: number, end?: number): string } | undefined;
}

/** The logical line under the cursor, up to the cursor. */
export function cursorLine(buf: BufferView): string {
  let y = buf.baseY + buf.cursorY;
  let text = buf.getLine(y)?.translateToString(false, 0, buf.cursorX) ?? '';
  let guard = 0;
  while (buf.getLine(y)?.isWrapped && y > 0 && guard++ < 20) {
    y--;
    text = (buf.getLine(y)?.translateToString(false) ?? '') + text;
  }
  return text;
}

/**
 * The input under the cursor. A program that redraws the screen (tmux after
 * a resize) can write a long line's rows each on its own, not marked as
 * wrapped: the input was lost, and the suggestions with it (gate 2026-11-02,
 * the bar's own coming and going resized the terminal). Without a prompt on
 * the cursor's line, rows above it filled to their last column count as the
 * same line.
 */
export function inputAtCursor(buf: BufferView, cols: number, shell: ShellState | null, alternateScreen: boolean): InputLine | null {
  let text = cursorLine(buf);
  const found = extractInput(text, shell, alternateScreen);
  if (found || cols <= 0) return found;
  let y = buf.baseY + buf.cursorY;
  let guard = 0;
  while (buf.getLine(y)?.isWrapped && y > 0 && guard++ < 20) y--;
  guard = 0;
  while (y > 0 && guard++ < 20) {
    const above = buf.getLine(y - 1)?.translateToString(false) ?? '';
    if (above.length < cols || above.trimEnd().length < cols) return null;
    text = above + text;
    y--;
    const joined = extractInput(text, shell, alternateScreen);
    if (joined) return joined;
  }
  return null;
}
