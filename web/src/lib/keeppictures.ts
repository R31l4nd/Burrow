/**
 * HTML put into an element again and again (Markdown beside its file, after each pause in typing),
 * its pictures kept: {@html} made every <img> anew each time, and a picture beside the file (the raw
 * route sends no-store) was fetched again and blinked at each pause (audit 2026-11-05). A picture
 * whose tag is the same as before is the same element, moved to its new place; only new or changed
 * ones load. Parsed in a template first: nothing in it is fetched before it is in the page.
 */
export function keepPictures(node: HTMLElement, html: string) {
  const put = (h: string) => {
    const old = new Map<string, HTMLImageElement[]>();
    for (const img of node.querySelectorAll('img')) old.set(img.outerHTML, [...(old.get(img.outerHTML) ?? []), img]);
    const tpl = document.createElement('template');
    tpl.innerHTML = h;
    // The old element goes in where its mark is once the new content is in place: moved within the
    // page, never through the template's own document (that would load it again).
    const kept: [Comment, HTMLImageElement][] = [];
    for (const img of tpl.content.querySelectorAll('img')) {
      const same = old.get(img.outerHTML)?.shift();
      if (!same) continue;
      const mark = tpl.content.ownerDocument.createComment('');
      img.replaceWith(mark);
      kept.push([mark, same]);
    }
    node.replaceChildren(tpl.content);
    for (const [mark, img] of kept) mark.replaceWith(img);
  };
  put(html);
  return { update: put };
}
