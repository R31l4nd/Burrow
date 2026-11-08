// A workspace's open tab whose file was renamed or moved (from the tree): the same tab under the new
// path, on the same side of a split editor and still a preview if it was one; only its editor is
// made anew (the tabs are keyed by path). It went back to the left side, kept (audit 2026-11-05).
export function renamedTab<T extends { path: string; state: object; pane?: unknown }>(tab: T, path: string): Omit<T, 'pane'> {
  const { pane: _pane, ...rest } = tab;
  return { ...rest, path, state: { ...tab.state } };
}
