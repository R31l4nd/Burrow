// A small, safe Markdown to HTML for model answers, release notes and the
// editor's preview: headings, lists, quotes, tables, bold, italic, inline
// code and code blocks.
// Everything is escaped first; the only HTML is the tags made here. Links
// stay text unless asked for (release notes), and then only http(s) ones,
// opening elsewhere. A picture is a link, unless the caller gives an address
// to show it from (release notes: GitHub's pictures through Burrow).

import { escapeHtml as esc } from './escape.js';

export interface MarkdownOptions {
  /** [text](https://...) and bare https:// addresses as links that open in another tab. */
  links?: boolean;
  /** With links: where a picture may be shown from (null: only a link to it). */
  image?: (src: string) => string | null;
  /** A shown picture's text when the notes give none (its link needs a name). */
  pictureLabel?: string;
}

const PICTURE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

/**
 * A picture written next to a Markdown file ("img/menu.png", "../shot.webp"):
 * its path on the host, or null for anything else (another scheme, an
 * address, "/..." whose root is not known, not a picture).
 */
export function localPicture(dir: string, src: string): string | null {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/')) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(src.replace(/[?#].*$/, ''));
  } catch {
    return null;
  }
  if (!PICTURE.test(rel)) return null;
  const parts: string[] = [];
  for (const seg of `${dir}/${rel}`.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const link = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

function inline(s: string, o: MarkdownOptions): string {
  // Code first, kept aside: nothing inside it is Markdown.
  const codes: string[] = [];
  // Kept-aside pieces are marked with private-use characters, taken out of the text first.
  let out = esc(s.replace(/[\uE000\uE001]/g, '')).replace(/`([^`]+)`/g, (_m, c: string) => `\uE000${codes.push(`<code>${c}</code>`) - 1}\uE000`);
  const links: string[] = [];
  if (o.links) {
    const keep = (html: string) => `\uE001${links.push(html) - 1}\uE001`;
    // A picture: shown when the caller says from where, else its address as
    // a link. alt and href are escaped already (esc above).
    const picture = (href: string, alt: string, whole: string) => {
      const src = o.image?.(unesc(href)) ?? null;
      const img = src ? `<img src="${esc(src)}" alt="${alt || esc(o.pictureLabel ?? 'Picture')}" loading="lazy">` : '';
      if (/^https?:\/\//.test(href)) return keep(link(href, img || alt || href));
      // A picture beside the file (the editor's preview): shown, without a
      // link that would open a host's file as a page; else left as written.
      return img ? keep(img) : whole;
    };
    // <img ... src="..." alt="..."> as GitHub's release notes write it (escaped by now).
    out = out.replace(/&lt;img\s((?:(?!&gt;).)*)&gt;/g, (whole, attrs: string) => {
      const src = /\bsrc=(?:&quot;(.*?)&quot;|'([^']*)')/.exec(attrs);
      const href = src ? (src[1] ?? src[2] ?? '') : '';
      if (!href) return whole;
      const alt = /\balt=(?:&quot;(.*?)&quot;|'([^']*)')/.exec(attrs);
      return picture(href, alt ? (alt[1] ?? alt[2] ?? '') : '', whole);
    });
    // ![alt](url "title"): GitHub puts a size there ("=428x659"); a title is left out.
    const title = '(?:\\s+&quot;.*?&quot;)?';
    // Addresses never take in a kept-aside piece (\uE000/\uE001): glued to a link or code, the
    // address ended there; it ran over the placeholder and the link or code was lost (A3-WEB-08).
    out = out.replace(new RegExp(`!\\[([^\\]]*)\\]\\(([^\\s)\\uE000\\uE001]+)${title}\\)`, 'g'), (m, alt: string, href: string) => picture(href, alt, m));
    out = out.replace(new RegExp(`\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)\\uE000\\uE001]+)${title}\\)`, 'g'), (_m, text: string, href: string) => keep(link(href, text)));
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)\uE000\uE001]+[^\s<).,;:!?\uE000\uE001])/g, (_m, pre: string, href: string) => pre + keep(link(href, href)));
  }
  // Emphasis around the kept-aside links, never inside an address (a_b_ in a URL).
  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/\uE001(\d+)\uE001/g, (_m, i: string) => links[Number(i)]!);
  return out.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => codes[Number(i)]!);
}

export function markdownToHtml(md: string, o: MarkdownOptions = {}): string {
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let code: string[] | null = null;
  let quote: string[] = [];
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  const closeQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.map((q) => `<p>${q}</p>`).join('')}</blockquote>`);
    quote = [];
  };
  // A table: rows of | cells |, the second a line of dashes. Without that
  // line they are paragraphs, as written.
  let table: string[] = [];
  const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const closeTable = () => {
    if (!table.length) return;
    if (table.length > 1 && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(table[1]!)) {
      const head = cells(table[0]!);
      const body = table.slice(2).map(cells);
      out.push(
        `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c, o)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${head.map((_h, i) => `<td>${inline(r[i] ?? '', o)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`,
      );
    } else for (const row of table) out.push(`<p>${inline(row, o)}</p>`);
    table = [];
  };
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!code && /^\s*\|/.test(line)) {
      closeList();
      closeQuote();
      table.push(line);
      continue;
    }
    closeTable();
    if (code) {
      if (/^\s*```/.test(line)) {
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) {
      closeList();
      closeQuote();
      code = [];
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      closeList();
      if (q[1]!.trim()) quote.push(inline(q[1]!, o));
      continue;
    }
    closeQuote();
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (h) {
      closeList();
      const level = Math.min(4, h[1]!.length + 1);
      out.push(`<h${level}>${inline(h[2]!, o)}</h${level}>`);
      continue;
    }
    // A rule (--- or ***) between sections: nothing to show.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList();
      continue;
    }
    const li = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (li) {
      const kind = li[1] ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        // A numbered list taken up again after a code block goes on from its number (it started at
        // 1 after each command of an analysis, report a7532e).
        out.push(kind === 'ol' && li[2] !== '1' ? `<ol start="${Number(li[2])}">` : `<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline(li[3]!, o)}</li>`);
      continue;
    }
    closeList();
    if (line.trim()) out.push(`<p>${inline(line, o)}</p>`);
  }
  if (code) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  closeTable();
  closeList();
  closeQuote();
  return out.join('');
}

/**
 * A model's answer in parts: text, and the commands in ``` blocks apart, so each command can have
 * its own Copy and Run (report a7532e). The fences are found as markdownToHtml finds them.
 */
export function splitFences(md: string): { kind: 'text' | 'code'; text: string }[] {
  const out: { kind: 'text' | 'code'; text: string }[] = [];
  let text: string[] = [];
  let code: string[] | null = null;
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*```/.test(line)) {
      if (code) {
        out.push({ kind: 'code', text: code.join('\n') });
        code = null;
      } else {
        if (text.length) out.push({ kind: 'text', text: text.join('\n') });
        text = [];
        code = [];
      }
      continue;
    }
    (code ?? text).push(line);
  }
  if (code) out.push({ kind: 'code', text: code.join('\n') });
  else if (text.length) out.push({ kind: 'text', text: text.join('\n') });
  return out;
}
