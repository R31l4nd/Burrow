import { describe, expect, it } from 'vitest';
import { releaseImageAllowed } from '@burrow/shared';
import { localPicture, markdownToHtml, splitFences } from './markdown.js';

describe('markdownToHtml', () => {
  it('renders the sections of an analysis', () => {
    expect(markdownToHtml('## Likely cause\n- The **db** is down\n- Check `docker ps`\n\nDone.')).toBe(
      '<h3>Likely cause</h3><ul><li>The <strong>db</strong> is down</li><li>Check <code>docker ps</code></li></ul><p>Done.</p>',
    );
    expect(markdownToHtml('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
    expect(markdownToHtml('```\nls -la\n```')).toBe('<pre><code>ls -la</code></pre>');
  });

  it('never lets HTML through', () => {
    const html = markdownToHtml('<img src=x onerror=alert(1)> **<script>** `<b>`\n```\n</code><script>\n```');
    expect(html).not.toMatch(/<(img|script|b)\b/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('release notes: links that open on their site, never javascript:, never a loaded image', () => {
    const html = markdownToHtml('See [the docs](https://example.com/docs) and https://example.com/x.\n![shot](https://example.com/a.png) [bad](javascript:alert(1))', { links: true });
    expect(html).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">the docs</a>');
    expect(html).toContain('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>.');
    expect(html).toContain('>shot</a>');
    expect(html).not.toMatch(/<img|href="javascript/);
    expect(html).toContain('[bad](javascript:alert(1))');
    // Without asking: links stay text (a model's answer).
    expect(markdownToHtml('[x](https://example.com)')).toBe('<p>[x](https://example.com)</p>');
  });

  it('release notes: a GitHub picture shown through Burrow, with or without a title or an <img> tag; any other stays a link (report 64498b)', () => {
    const proxy = (src: string) => (releaseImageAllowed(src) ? `/api/changelog/image?url=${encodeURIComponent(src)}` : null);
    const shot = 'https://github.com/user-attachments/assets/b011c1a2-b81c-47a8-b3d8-159d829fcf82';
    // GitHub's own size hint after the address (this one showed as text).
    const html = markdownToHtml(`As a user you can share people:\n![](${shot} "=428x659")`, { links: true, image: proxy, pictureLabel: 'Picture' });
    // Without its own text, the picture (and so its link) is named all the same.
    expect(html).toContain(`<a href="${shot}" target="_blank" rel="noopener noreferrer"><img src="${proxy(shot)}" alt="Picture" loading="lazy"></a>`);
    expect(html).not.toContain('![](');
    expect(markdownToHtml(`<img width="600" alt="New menu" src="${shot}" />`, { links: true, image: proxy })).toContain(`<img src="${proxy(shot)}" alt="New menu" loading="lazy">`);
    // Not on GitHub's image hosts: a link, never loaded.
    const other = markdownToHtml('![logo](https://example.com/a.png "Logo")', { links: true, image: proxy });
    expect(other).toContain('<a href="https://example.com/a.png" target="_blank" rel="noopener noreferrer">logo</a>');
    expect(other).not.toContain('<img');
    // Without the image option (a model's answer, the editor): never an image.
    expect(markdownToHtml(`![](${shot})`, { links: true })).not.toContain('<img');
    // A quote in the alt text cannot break out of its attribute: it stays text.
    const quoted = markdownToHtml(`<img alt='x" onerror="alert(1)' src="${shot}">`, { links: true, image: proxy });
    expect(quoted).toContain('alt="x&quot; onerror=&quot;alert(1)" loading="lazy">');
    expect(quoted).not.toMatch(/<img[^>]*" onerror="/);
  });

  it('release notes: italic, quotes, rules, headings with closing hashes, code untouched', () => {
    expect(markdownToHtml('*new* and _also_ but not file_name_here', { links: true })).toBe('<p><em>new</em> and <em>also</em> but not file_name_here</p>');
    expect(markdownToHtml('> Note\n> more\n\n---\n### Fixes ###\n`a_b_c` and `[x](https://e.com)`', { links: true })).toBe(
      '<blockquote><p>Note</p><p>more</p></blockquote><h4>Fixes</h4><p><code>a_b_c</code> and <code>[x](https://e.com)</code></p>',
    );
    expect(markdownToHtml('+ plus\n* star')).toBe('<ul><li>plus</li><li>star</li></ul>');
    // An address with underscores stays whole.
    expect(markdownToHtml('see https://e.com/_x_/a_b_ and [y](https://e.com/_z_)', { links: true })).toBe(
      '<p>see <a href="https://e.com/_x_/a_b_" target="_blank" rel="noopener noreferrer">https://e.com/_x_/a_b_</a> and <a href="https://e.com/_z_" target="_blank" rel="noopener noreferrer">y</a></p>',
    );
  });

  it('a table with a line of dashes is a table, its cells escaped; without it, text', () => {
    const html = markdownToHtml('| Name | State |\n|---|:---:|\n| web | **up** |\n| <b>db</b> | down |');
    expect(html).toContain('<table><thead><tr><th>Name</th><th>State</th></tr></thead>');
    expect(html).toContain('<td><strong>up</strong></td>');
    expect(html).toContain('&lt;b&gt;db&lt;/b&gt;');
    expect(html).not.toContain('<b>');
    expect(markdownToHtml('| just | pipes |')).toBe('<p>| just | pipes |</p>');
  });

  it("the editor's preview: a picture next to the file shown from the host, no link around it; one it cannot place stays as written", () => {
    const local = (src: string) => {
      const p = localPicture('/srv/docs', src);
      return p ? `/raw?path=${encodeURIComponent(p)}` : null;
    };
    const html = markdownToHtml('See ![the menu](img/menu.png) and <img src="../shot one.webp">.', { links: true, image: local, pictureLabel: 'Picture' });
    expect(html).toContain('<img src="/raw?path=%2Fsrv%2Fdocs%2Fimg%2Fmenu.png" alt="the menu" loading="lazy">');
    expect(html).toContain('<img src="/raw?path=%2Fsrv%2Fshot%20one.webp" alt="Picture" loading="lazy">');
    expect(html).not.toContain('<a ');
    expect(markdownToHtml('![x](notes.txt)', { links: true, image: local })).toBe('<p>![x](notes.txt)</p>');
  });
});

describe('an address glued to a link or code (A3-WEB-08)', () => {
  it('keeps the link and the code: no placeholder characters in an address, nothing lost', () => {
    const a = markdownToHtml('http://x[t](https://y)', { links: true });
    expect(a).not.toMatch(/[\uE000\uE001]/);
    expect(a).toContain('<a href="https://y" target="_blank" rel="noopener noreferrer">t</a>');
    const b = markdownToHtml('http://x`code`', { links: true });
    expect(b).not.toMatch(/[\uE000\uE001]/);
    expect(b).toContain('<code>code</code>');
    expect(b).not.toMatch(/href="[^"]*code/);
  });
});

describe('localPicture', () => {
  it('a picture beside the file, by a path relative to it; never another scheme, an address or a guess for /', () => {
    expect(localPicture('/srv/docs', 'a.png')).toBe('/srv/docs/a.png');
    expect(localPicture('/srv/docs', './img/a%20b.JPG?raw=1#x')).toBe('/srv/docs/img/a b.JPG');
    expect(localPicture('/srv/docs', '../../../../a.gif')).toBe('/a.gif');
    expect(localPicture('/srv/docs', 'a.svg')).toBe('/srv/docs/a.svg');
    for (const bad of ['javascript:alert(1)//a.png', 'data:image/png;base64,AA', '//evil.example/a.png', 'https://example.com/a.png', '/etc/a.png', 'a.txt', 'img/', '']) expect(localPicture('/srv/docs', bad)).toBeNull();
  });
});

describe('an analysis with commands (report a7532e)', () => {
  const md = '1. **Check the client**\n```\ndocker logs --tail 200 aurral\n```\nThen:\n2. **The path**\n```sh\ndocker inspect aurral\n```';
  it('a numbered list goes on from its number after a command, not from 1 again', () => {
    expect(markdownToHtml(md)).toContain('<ol start="2"><li><strong>The path</strong></li></ol>');
  });
  it('split into text and commands, each command apart; an unclosed one runs to the end', () => {
    expect(splitFences(md)).toEqual([
      { kind: 'text', text: '1. **Check the client**' },
      { kind: 'code', text: 'docker logs --tail 200 aurral' },
      { kind: 'text', text: 'Then:\n2. **The path**' },
      { kind: 'code', text: 'docker inspect aurral' },
    ]);
    expect(splitFences('a\n```\nls -l')).toEqual([{ kind: 'text', text: 'a' }, { kind: 'code', text: 'ls -l' }]);
    expect(splitFences('')).toEqual([{ kind: 'text', text: '' }]);
  });
});
