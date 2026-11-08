// The app's own "are you sure?", instead of the browser's confirm(): the same
// look as every other dialog, and a button that says what happens ("Delete",
// "Close session") in red when it cannot be undone, not a bare "OK".

export interface Question {
  /** What happens, as a question; the dialog's text. */
  text: string;
  /** The button that goes ahead, named after the action. */
  confirm: string;
  /** Cannot be undone: the button is red. */
  danger?: boolean;
  /** Also asks for a line of text (a name), prefilled with this. */
  input?: { label: string; value: string; max?: number };
  /** The text may be left empty (it then means "none"). */
  empty?: boolean;
  /** Things to read before answering, each under its own name (report 06354e: one run of text). */
  items?: { title: string; lines: string[] }[];
  /** A second way to go ahead, beside the first (an upload over a name: Replace, or Keep both). */
  other?: string;
}

/** What `choose` says for the second way. */
export const OTHER = '\u0000other';

export const asking = $state<{ q: Question | null }>({ q: null });

let answer: ((v: string | null) => void) | null = null;
let queue: Promise<unknown> = Promise.resolve();

function open(q: Question): Promise<string | null> {
  // One question at a time: a second waits for the first to be answered.
  const next = queue.then(
    () =>
      new Promise<string | null>((resolve) => {
        asking.q = q;
        answer = resolve;
      }),
  );
  queue = next.catch(() => null);
  return next;
}

/** Yes or no. */
export async function ask(q: Question): Promise<boolean> {
  return (await open(q)) !== null;
}

/** One of two ways, or null when cancelled. */
export async function choose(q: Question & { other: string }): Promise<'confirm' | 'other' | null> {
  const v = await open(q);
  return v === null ? null : v === OTHER ? 'other' : 'confirm';
}

/** A line of text, or null when cancelled. */
export function askText(q: Question & { input: { label: string; value: string } }): Promise<string | null> {
  return open(q);
}

/** Called by the dialog: the answer (null: cancelled). */
export function answered(v: string | null): void {
  const a = answer;
  answer = null;
  asking.q = null;
  a?.(v);
}
