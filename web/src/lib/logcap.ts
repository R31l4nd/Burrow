/**
 * A merged log view's lines capped: at most `perSource` of each source (the
 * oldest of a source over its share go), and at most `total` in all (the
 * oldest go). A loud source took the whole cap of a merged view and pushed
 * the quiet ones' lines out (decision 3). Works in place on the lines and
 * their sort keys (one key per line, same order); returns how many went.
 */
export function capLines<T extends { i: number }>(lines: T[], keys: string[], perSource: number, total: number): number {
  let dropped = 0;
  const count = new Map<number, number>();
  for (const l of lines) count.set(l.i, (count.get(l.i) ?? 0) + 1);
  const over = new Map([...count].filter(([, n]) => n > perSource).map(([i, n]) => [i, n - perSource]));
  if (over.size) {
    let w = 0;
    for (let r = 0; r < lines.length; r++) {
      const l = lines[r]!;
      const left = over.get(l.i) ?? 0;
      if (left > 0) {
        over.set(l.i, left - 1);
        dropped++;
        continue;
      }
      lines[w] = l;
      keys[w] = keys[r]!;
      w++;
    }
    lines.length = w;
    keys.length = w;
  }
  if (lines.length > total) {
    const cut = lines.length - total;
    lines.splice(0, cut);
    keys.splice(0, cut);
    dropped += cut;
  }
  return dropped;
}
