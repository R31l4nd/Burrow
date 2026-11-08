import Fuse from 'fuse.js';

// The command palette (F1, Ctrl+Shift+P in a workspace): every action of the
// workspace and of the file in front, found by a few letters of its name, as
// VS Code's "Show All Commands" and JetBrains' "Find Action".

export interface Command {
  id: string;
  /** Its name, as the button or menu item says it. */
  title: string;
  /** Its own keys, said beside it ("Ctrl+P"). */
  keys?: string;
  run: () => void;
}

/** The commands a query names, the best first; all of them, in their order, for none. Used last first. */
export function findCommands(list: Command[], query: string, recent: string[] = []): Command[] {
  const q = query.trim();
  if (!q) {
    const rank = (c: Command) => {
      const i = recent.indexOf(c.id);
      return i < 0 ? recent.length : i;
    };
    return [...list].sort((a, b) => rank(a) - rank(b));
  }
  return new Fuse(list, { keys: ['title'], threshold: 0.4, ignoreLocation: true }).search(q).map((r) => r.item);
}

/** The ids used last, newest first, a handful kept. */
export function usedNow(recent: string[], id: string): string[] {
  return [id, ...recent.filter((x) => x !== id)].slice(0, 8);
}
