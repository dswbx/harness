type Changed = { path: string; additions: number; deletions: number };

export type TreeRow<T> =
  | { kind: "dir"; key: string; name: string; depth: number; open: boolean; additions: number; deletions: number }
  | { kind: "file"; key: string; name: string; depth: number; file: T };

type Node<T> = { dirs: Map<string, Node<T>>; files: T[] };

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * Changed files as a folder tree: folders first, then files, each sorted by name; a folder holding only one folder
 * merges with it (`packages/api/src`). `rows` skips the contents of folders in `closed` (keyed by full folder path);
 * `order` is every file in tree order, for next/previous file.
 */
export function fileTree<T extends Changed>(files: readonly T[], closed: ReadonlySet<string>): { rows: TreeRow<T>[]; order: T[] } {
  const root: Node<T> = { dirs: new Map(), files: [] };
  for (const f of files) {
    let n = root;
    for (const part of f.path.split("/").slice(0, -1)) {
      let next = n.dirs.get(part);
      if (!next) n.dirs.set(part, (next = { dirs: new Map(), files: [] }));
      n = next;
    }
    n.files.push(f);
  }
  const sum = (n: Node<T>): [number, number] => {
    let a = 0;
    let d = 0;
    for (const f of n.files) { a += f.additions; d += f.deletions; }
    for (const c of n.dirs.values()) { const [ca, cd] = sum(c); a += ca; d += cd; }
    return [a, d];
  };
  const rows: TreeRow<T>[] = [];
  const order: T[] = [];
  const walk = (n: Node<T>, depth: number, prefix: string, visible: boolean) => {
    for (const name of [...n.dirs.keys()].sort(byName)) {
      let child = n.dirs.get(name)!;
      let label = name;
      while (child.files.length === 0 && child.dirs.size === 1) {
        const [k, only] = [...child.dirs][0]!;
        label += "/" + k;
        child = only;
      }
      const key = prefix + label;
      const open = !closed.has(key);
      const [additions, deletions] = sum(child);
      if (visible) rows.push({ kind: "dir", key, name: label, depth, open, additions, deletions });
      walk(child, depth + 1, key + "/", visible && open);
    }
    for (const f of [...n.files].sort((a, b) => byName(baseName(a.path), baseName(b.path)))) {
      order.push(f);
      if (visible) rows.push({ kind: "file", key: f.path, name: baseName(f.path), depth, file: f });
    }
  };
  walk(root, 0, "", true);
  return { rows, order };
}

/** Folder keys (as `fileTree` makes them) that contain `path`, for opening them when that file is selected. */
export function ancestorKeys(closed: ReadonlySet<string>, path: string): string[] {
  return [...closed].filter((k) => path.startsWith(k + "/"));
}
