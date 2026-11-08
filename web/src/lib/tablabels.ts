// Names for open files, as VS Code gives them (report 9d710d: two tabs both
// "docker-compose.yml"): a file whose name no other open file has is its
// name alone; files that share a name each get the shortest end of their
// folder that tells them apart. Under a workspace folder the path is read
// from that folder's own name ("data/docker-compose.yml"), and when the
// files are in different folders of the workspace, that folder's name leads
// ("hdd/AppData", "hdd/.../x"), as the tree shows the folders by name.

export interface FileLabel {
  name: string;
  /** Empty when the name alone is enough. */
  dir: string;
}

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1) || p;

/** The folder of a path, as segments read from the workspace folder that holds it (the deepest), else from /. */
function folderOf(path: string, roots: readonly string[]): { root: string; segs: string[] } {
  const r = [...roots].sort((a, b) => b.length - a.length).find((x) => path.startsWith(x === '/' ? '/' : `${x}/`));
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (!r) return { root: '', segs: dir.split('/').filter(Boolean) };
  const rootName = base(r.replace(/\/+$/, '')) || '/';
  return { root: r, segs: [rootName, ...dir.slice(r.length).split('/').filter(Boolean)] };
}

/** Labels for open files (absolute paths), by path. */
export function fileLabels(paths: readonly string[], roots: readonly string[] = []): Map<string, FileLabel> {
  const out = new Map<string, FileLabel>();
  const byName = new Map<string, string[]>();
  for (const p of paths) byName.set(base(p), [...(byName.get(base(p)) ?? []), p]);
  for (const [name, group] of byName) {
    if (group.length === 1) {
      out.set(group[0]!, { name, dir: '' });
      continue;
    }
    const folders = group.map((p) => folderOf(p, roots));
    const longest = Math.max(...folders.map((f) => f.segs.length));
    const tail = (segs: string[], k: number) => segs.slice(Math.max(0, segs.length - k)).join('/');
    let k = 1;
    while (k < longest && new Set(folders.map((f) => tail(f.segs, k))).size < group.length) k++;
    // Folders of the same name everywhere (two roots both called "data"): the whole path.
    const told = new Set(folders.map((f) => tail(f.segs, k))).size === group.length;
    const manyRoots = new Set(folders.map((f) => f.root)).size > 1;
    group.forEach((p, i) => {
      const f = folders[i]!;
      let dir = told ? tail(f.segs, k) : p.slice(0, p.lastIndexOf('/')) || '/';
      if (told && manyRoots && f.root && f.segs.length > k) dir = f.segs.length === k + 1 ? f.segs.join('/') : `${f.segs[0]}/.../${dir}`;
      out.set(p, { name, dir: dir || '/' });
    });
  }
  return out;
}
