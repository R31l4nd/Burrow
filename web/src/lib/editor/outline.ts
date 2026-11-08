// A file's outline, as VS Code's: its headings, keys, sections, blocks or
// functions, read from the text by its language. From the text itself, so
// the languages without a syntax tree here (shell, nginx, INI) have one too,
// and no language server needs the host's files.

export interface OutlineItem {
  name: string;
  /** 1-based. */
  line: number;
  depth: number;
}

const MAX = 500;

/** Depth by indent, the indents met so far giving the levels. */
function byIndent(): (indent: number) => number {
  const levels: number[] = [];
  return (indent) => {
    while (levels.length && levels[levels.length - 1]! >= indent) levels.pop();
    levels.push(indent);
    return levels.length - 1;
  };
}

export function outline(text: string, lang: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const lines = text.split(/\r?\n/);
  const add = (name: string, line: number, depth: number) => out.length < MAX && out.push({ name, line, depth });
  if (lang === 'Markdown') {
    let fence = false;
    lines.forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
      if (m) add(m[2]!, i + 1, m[1]!.length - 1);
    });
  } else if (lang === 'YAML' || lang === 'JSON') {
    const depth = byIndent();
    const key = lang === 'YAML' ? /^(\s*)(?:-\s+)?([^\s#'"-][^:#]*?|"[^"]*"|'[^']*'):(\s|$)/ : /^(\s*)"([^"]+)"\s*:/;
    lines.forEach((l, i) => {
      const m = key.exec(l);
      if (m) add(m[2]!.replace(/^["']|["']$/g, ''), i + 1, depth(m[1]!.length));
    });
    // JSON's own braces are one level more than its keys: from the top.
    if (lang === 'JSON' && out.length && out.every((x) => x.depth > 0)) for (const x of out) x.depth--;
  } else if (lang === 'Python') {
    const depth = byIndent();
    lines.forEach((l, i) => {
      const m = /^(\s*)(?:async\s+)?(?:def|class)\s+(\w+)/.exec(l);
      if (m) add(m[2]!, i + 1, depth(m[1]!.length));
    });
  } else if (lang === 'Shell') {
    lines.forEach((l, i) => {
      const m = /^\s*(?:function\s+([\w.:-]+)|([\w.:-]+)\s*\(\s*\))/.exec(l);
      if (m) add((m[1] ?? m[2])!, i + 1, 0);
    });
  } else if (lang === 'nginx') {
    let depth = 0;
    lines.forEach((l, i) => {
      const code = l.replace(/#.*/, '');
      const m = /^\s*([a-z_]+(?:\s+[^{;]+?)?)\s*\{/.exec(code);
      if (m) add(m[1]!.trim(), i + 1, depth);
      depth = Math.max(0, depth + (code.split('{').length - 1) - (code.split('}').length - 1));
    });
  } else if (lang === 'TOML' || lang === 'INI' || lang === '.env') {
    lines.forEach((l, i) => {
      const m = /^\s*\[+([^\]]+)\]+/.exec(l);
      if (m) add(m[1]!.trim(), i + 1, 0);
    });
  } else if (lang === 'Dockerfile') {
    lines.forEach((l, i) => {
      const m = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(l);
      if (m) add(m[2] ? `${m[2]} (${m[1]})` : m[1]!, i + 1, 0);
    });
  }
  return out;
}
