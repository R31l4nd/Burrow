// A stack trace is one event over many log lines: its first line (the
// error) and lines that go on from it (indented frames, "Caused by:",
// "... 12 more"). The log view folds those under the first, so twenty
// frames do not push the rest of the log away.

const GOES_ON = /^(?:[ \t]+\S|Caused by: |\.\.\. \d+ (?:more|common frames omitted)|During handling of the above exception|The above exception was the direct cause)/;

/** A line that continues the one before it (a frame of a stack trace, an indented detail). */
export function continues(text: string): boolean {
  return GOES_ON.test(text);
}

/**
 * For lines in display order: the lines that go on from each first line
 * (by index), counted only within one source. A continuation without a
 * first line before it (the start of the view) stands on its own.
 */
export function foldStacks(lines: { source: number; text: string }[]): { more: Map<number, number>; headOf: Map<number, number> } {
  const more = new Map<number, number>();
  const headOf = new Map<number, number>();
  let head = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (head >= 0 && lines[head]!.source === l.source && continues(l.text)) {
      headOf.set(i, head);
      more.set(head, (more.get(head) ?? 0) + 1);
    } else head = i;
  }
  return { more, headOf };
}
