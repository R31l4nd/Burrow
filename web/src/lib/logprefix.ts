import { detectLevel, type LogLevel } from '@burrow/shared';

// Many apps start each line with their own time and level ("[01:31:59] [INF]
// ..."), right after the time and level Burrow shows already (the live UI
// round: Jellyfin's lines said both twice). That repeated head is shown
// dimmed, not dropped: search, copy and the line itself stay as written.

const TIME = /^\[?(?:\d{4}-\d\d-\d\d[T ])?\d\d:\d\d:\d\d(?:[.,]\d+)?(?: ?(?:Z|[+-]\d\d:?\d\d))?\]?\s+/;
const LEVEL = /^[[<]?([A-Za-z]{3,8})[\]>]?:?\s+/;

/** How many characters at the start repeat the line's time and level; 0 for none. */
export function repeatedHead(text: string, level: LogLevel | null): number {
  let n = 0;
  const time = TIME.exec(text);
  if (time) n = time[0].length;
  const lvl = level ? LEVEL.exec(text.slice(n)) : null;
  // Only the level word of the line itself, written as a tag (upper case or in brackets).
  if (lvl && detectLevel(lvl[0]) === level) n += lvl[0].length;
  // Never the whole line: something is left to read.
  return n < text.trimEnd().length ? n : 0;
}
