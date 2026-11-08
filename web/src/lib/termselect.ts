// Selecting with a finger in the terminal (components/TermView.svelte): the
// parts that only read the terminal's lines, apart from the touches.

export interface Cell {
  col: number;
  row: number;
}
export interface CellRange {
  from: Cell;
  to: Cell;
}

/** The lines as xterm keeps them (its buffer), only what is read here. */
export interface Lines {
  getLine(row: number): { isWrapped: boolean; translateToString(trimRight?: boolean, start?: number, end?: number): string } | undefined;
}

/** Two ends in reading order, whichever the finger held first. */
export function ordered(a: Cell, b: Cell): CellRange {
  return a.row < b.row || (a.row === b.row && a.col <= b.col) ? { from: a, to: b } : { from: b, to: a };
}

/** How many cells from the start to the end, both in, as xterm's select() counts them. */
export function cellCount(r: CellRange, cols: number): number {
  return (r.to.row - r.from.row) * cols + r.to.col - r.from.col + 1;
}

/** A line's cells as xterm keeps them: a wide character takes two, the second of width 0. */
export interface CellLine {
  length: number;
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
}

/**
 * The word (what has no space) on [line] around [col]: its first and last
 * column. Counted in cells: the letters of the line's text are not its
 * columns once a wide character or a combining mark is in it (AUDIT2 TERM-16).
 */
export function wordAt(line: CellLine, col: number): { from: number; to: number } {
  const word = (i: number): boolean => {
    const c = i >= 0 && i < line.length ? line.getCell(i) : undefined;
    if (!c) return false;
    // The second cell of a wide character: as the first.
    if (c.getWidth() === 0) return word(i - 1);
    const ch = c.getChars();
    return ch !== '' && ch !== ' ';
  };
  let a = col;
  let b = col;
  while (word(a - 1)) a--;
  while (word(b + 1)) b++;
  return { from: a, to: b };
}

/** The selected text: a wrapped line joined to the one before, spaces at line ends dropped. */
export function rangeText(lines: Lines, r: CellRange, cols: number): string {
  let out = '';
  for (let row = r.from.row; row <= r.to.row; row++) {
    const line = lines.getLine(row);
    if (!line) continue;
    const text = line.translateToString(false, row === r.from.row ? r.from.col : 0, row === r.to.row ? r.to.col + 1 : cols);
    out += row === r.from.row ? text : (line.isWrapped ? '' : '\n') + text;
  }
  return out.replace(/ +$/gm, '');
}
