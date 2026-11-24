import { expect, type Page } from '@playwright/test';

// Edges: nothing cut or run past a side, segmented choices, words whole, boxes and text apart. Part of checks.ts (lookAt).

/**
 * The same sideways: a flag, pill or control cut off at the right (or left) of
 * a box that hides what does not fit, with nothing in between that scrolls.
 * A stack's table on a screen just wide enough for two columns ran past its
 * border, its update flags cut to "updat" (report 5a729b).
 */
export async function nothingCutSideways(page: Page, where: string) {
  const out = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.flag, .pill, .badge, .chip, button, a[href]')]
      .filter((e) => e.getClientRects().length && e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && !e.closest('dialog:not([open]), [aria-hidden=true], [inert], .cm-editor, .xterm, details:not([open])'))
      .flatMap((e) => {
        const r = e.getBoundingClientRect();
        if (r.width < 4) return [];
        for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
          const ox = getComputedStyle(a).overflowX;
          // A box that scrolls on the way: reachable by scrolling it.
          if ((ox === 'auto' || ox === 'scroll') && a.scrollWidth > a.clientWidth + 1) return [];
          if (ox !== 'hidden' && ox !== 'clip') continue;
          const box = a.getBoundingClientRect();
          // Entirely out of it (a sliding strip, a folded part), or a box of a pixel (read aloud only): not meant to be seen.
          if (r.left >= box.right || r.right <= box.left || box.width < 3) return [];
          const cut = Math.max(r.right - box.right, box.left - r.left);
          if (cut <= 2) continue;
          const label = (e.getAttribute('aria-label') ?? e.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
          return [`${e.dataset.testid ?? e.tagName.toLowerCase()} "${label}": ${Math.round(cut)} px cut off by ${a.tagName.toLowerCase()}.${[...a.classList].filter((c) => !c.startsWith('svelte-')).join('.')}`];
        }
        return [];
      }),
  );
  expect.soft(out, `flags or controls cut off at the side with nothing that scrolls to them (${where})`).toEqual([]);
}

/**
 * A spacer pushes what follows it to the right only in a flex row: in a row left without one (the
 * processes dialog's title row, its own style missing), CPU/Memory fell under its words at the left,
 * half as wide (report 3767a7).
 */
export async function spacerInARow(page: Page, where: string) {
  const out = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.spacer')]
      .filter((s) => s.parentElement?.getClientRects().length && !s.closest('dialog:not([open]), [aria-hidden=true], [inert], details:not([open])'))
      .filter((s) => !getComputedStyle(s.parentElement!).display.includes('flex'))
      .map((s) => `${s.parentElement!.className || s.parentElement!.tagName}: ${(s.parentElement!.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)}`),
  );
  expect.soft([...new Set(out)], `a spacer in a row that is not a flex row: what follows it not pushed aside (${where})`).toEqual([]);
}

/**
 * The text of a bordered control stays inside its border: an app's tile on a phone turned had
 * "onbereikbaar" with its dot as wide as the tile, over its edges (report 95ce1f). Text clipped on
 * the way (an ellipsis) is the cut-off checks' to judge.
 */
export async function textInsideItsBorder(page: Page, where: string) {
  const out = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, a[href], [role=button]')]
      .filter((e) => e.getClientRects().length && e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && !e.closest('dialog:not([open]), [aria-hidden=true], [inert], .cm-editor, .xterm, details:not([open])'))
      .flatMap((e) => {
        const st = getComputedStyle(e);
        const bl = parseFloat(st.borderLeftWidth);
        const br = parseFloat(st.borderRightWidth);
        if (!bl || !br || st.borderLeftStyle === 'none' || st.borderRightStyle === 'none') return [];
        const box = e.getBoundingClientRect();
        const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.textContent?.trim()) continue;
          const holder = n.parentElement!;
          if (!holder.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || holder.closest('.sr-only')) continue;
          // Clipped between the text and the control: not painted past it.
          let clipped = false;
          for (let a: HTMLElement | null = holder; a && a !== e.parentElement; a = a.parentElement) {
            const ox = getComputedStyle(a).overflowX;
            if (ox !== 'visible') clipped = true;
          }
          if (clipped) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const r of range.getClientRects()) {
            const over = Math.max(box.left + bl - r.left, r.right - (box.right - br));
            if (over > 1) {
              const label = (e.getAttribute('aria-label') ?? e.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
              return [`${e.dataset.testid ?? e.tagName.toLowerCase()} "${label}": "${n.textContent.trim().slice(0, 20)}" ${Math.round(over)} px over its border`];
            }
          }
        }
        return [];
      }),
  );
  expect.soft(out, `text running over the border of its control (${where})`).toEqual([]);
}

/**
 * A segmented choice's options stay inside it, each on one line: "Zwart
 * (OLED)" broke over two lines past the edge on a 343 px wide phone, and
 * later hung below its box over the colours.
 */
export async function segmentsFit(page: Page, where: string) {
  const out = await page.evaluate(() =>
    [...document.querySelectorAll('.segmented')]
      .filter((s) => (s as HTMLElement).getClientRects().length)
      .flatMap((s) => {
        const box = s.getBoundingClientRect();
        return [...s.children].flatMap((b) => {
          const r = b.getBoundingClientRect();
          const lh = parseFloat(getComputedStyle(b).lineHeight) || parseFloat(getComputedStyle(b).fontSize) * 1.3;
          const range = document.createRange();
          range.selectNodeContents(b);
          const lines = new Set([...range.getClientRects()].map((x) => Math.round(x.top))).size;
          // Below it too: a third row of options hung under a box two rows high (report 36aa3d).
          const past = Math.max(r.right - box.right, box.left - r.left, range.getBoundingClientRect().right - box.right, r.bottom - box.bottom, box.top - r.top);
          return past > 1 || lines > 1 ? [`${b.textContent!.trim()} (${lines} lines, ${Math.round(past)} px past, line ${Math.round(lh)})`] : [];
        }).concat(
          // Two or three options side by side, never one under the other (report 3c862b: Reports over Analyses on a phone).
          s.children.length <= 3 && new Set([...s.children].filter((b) => (b as HTMLElement).getClientRects().length).map((b) => Math.round(b.getBoundingClientRect().top))).size > 1
            ? [`${[...s.children].map((b) => b.textContent!.trim()).join(' / ')} (one under the other)`]
            : [],
        );
      }),
  );
  expect.soft(out, `a segmented choice that does not fit (${where})`).toEqual([]);
}

/**
 * The options of a segmented choice on one line share it evenly, so the line
 * between them is in the middle: Open (2) | Solved (195) each got its words
 * plus a share of the rest, and the split stood off to one side (reports
 * 86756d, 4d0518). One whose words need more than an even share may be wider.
 */
export async function segmentsEven(page: Page, where: string) {
  const out = await page.evaluate(() =>
    [...document.querySelectorAll('.segmented')]
      .filter((s) => (s as HTMLElement).getClientRects().length)
      .flatMap((s) => {
        const btns = [...s.children].filter((b) => (b as HTMLElement).getClientRects().length) as HTMLElement[];
        // As wide as its words: measured with nothing stretching it, then put back as it was.
        const natural = (b: HTMLElement) => {
          const had = b.style.cssText;
          for (const [k, v] of [['transition', 'none'], ['flex', 'none'], ['width', 'max-content'], ['min-width', '0'], ['max-width', 'none']]) b.style.setProperty(k!, v!, 'important');
          const w = b.getBoundingClientRect().width;
          b.style.cssText = had;
          return w;
        };
        const lines = new Map<number, HTMLElement[]>();
        for (const b of btns) {
          const top = Math.round(b.getBoundingClientRect().top / 8);
          lines.set(top, [...(lines.get(top) ?? []), b]);
        }
        // On a computer a view switch is as wide as its words, not stretched over the page (A3-WEB-15);
        // in Settings the line's width on purpose, as its fields and buttons (.fill-controls).
        const box = s.closest('.fill-controls') ? 0 : s.getBoundingClientRect().width;
        const most = btns.length * Math.max(...btns.map(natural)) + 3 * (btns.length - 1) + 8;
        const stretchedOut = matchMedia('(pointer: fine) and (min-width: 900px)').matches && box > Math.max(320, most) + 4 ? [`${btns.map((b) => b.textContent!.trim()).join(' | ')} ${Math.round(box)}px wide, its words ${Math.round(most)}`] : [];
        return stretchedOut.concat([...lines.values()].flatMap((line) => {
          if (line.length < 2) return [];
          const ws = line.map((b) => b.getBoundingClientRect().width);
          const stretched = line.map((b, i) => ws[i]! > natural(b) + 2);
          const wide = ws.filter((_, i) => stretched[i]);
          const asWords = ws.filter((_, i) => !stretched[i]);
          if (!wide.length) return [];
          const uneven = Math.max(...wide) - Math.min(...wide) > 2 || asWords.some((w) => Math.max(...wide) > w + 2);
          return uneven ? [line.map((b, i) => `${b.textContent!.trim()} ${Math.round(ws[i]!)}px`).join(' | ')] : [];
        }));
      }),
  );
  expect.soft(out, `a segmented choice whose options share its line unevenly, or on a computer stretched past its words (${where})`).toEqual([]);
}

/**
 * A word is never broken in two between letters: "Audiobookshel / f" and
 * "Homeassistan / t" on the app tiles (report 050019). Words only (paths,
 * addresses and code may break where they must).
 */
export async function wordsWhole(page: Page, where: string) {
  const broken = await page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      // Machine text breaks where it must: code, terminals, and log lines (a narrow column of logs side by side).
      if (!el || !el.getClientRects().length || el.closest('.xterm, .cm-editor, pre, code, .mono, [data-testid=log], [aria-hidden=true], dialog:not([open])')) continue;
      const text = n.textContent ?? '';
      for (const m of text.matchAll(/[A-Za-z\u00C0-\u017F]{5,}/g)) {
        const r = document.createRange();
        r.setStart(n, m.index);
        r.setEnd(n, m.index + m[0].length);
        const tops = new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)));
        if (tops.size > 1) out.push(m[0]);
      }
    }
    return [...new Set(out)];
  });
  expect.soft(broken, `words broken between their letters (${where})`).toEqual([]);
}

/**
 * In a column that centres what it holds, each part is centred: the
 * "Try again" under a centred error sat at the left edge.
 */
export async function centredTogether(page: Page, where: string) {
  const off = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display !== 'flex' || !cs.flexDirection.startsWith('column') || cs.alignItems !== 'center' || !el.getClientRects().length) continue;
      const box = el.getBoundingClientRect();
      const mid = box.left + parseFloat(cs.paddingLeft) + (box.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / 2;
      for (const c of el.children) {
        const r = (c as HTMLElement).getBoundingClientRect();
        if (!r.width || getComputedStyle(c).position === 'absolute' || getComputedStyle(c).position === 'fixed') continue;
        if (Math.abs(r.left + r.width / 2 - mid) > 3) out.push(`${c.tagName.toLowerCase()}.${(c as HTMLElement).className || ''} ${(c.textContent ?? '').trim().slice(0, 30)}`);
      }
    }
    return out;
  });
  expect.soft(off, `not centred in a centred column (${where})`).toEqual([]);
}

/**
 * A card or a list keeps a gap to what comes right under it: two cards
 * touched in Settings -> Android, and "Sign out everywhere else" stuck to
 * the list of devices.
 */
export async function cardsApart(page: Page, where: string) {
  const touching = await page.evaluate(() =>
    [...document.querySelectorAll('.card, .list')]
      .filter((c) => (c as HTMLElement).getClientRects().length && !c.parentElement?.closest('.card, .list, dialog'))
      .flatMap((c) => {
        const next = c.nextElementSibling as HTMLElement | null;
        if (!next || !next.offsetParent || getComputedStyle(next).position === 'absolute' || getComputedStyle(next).position === 'fixed') return [];
        // Only what is below it (a row of them side by side is not "under").
        if (next.getBoundingClientRect().top < c.getBoundingClientRect().bottom - 1) return [];
        const gap = next.getBoundingClientRect().top - c.getBoundingClientRect().bottom;
        return gap >= 0 && gap < 6 ? [`${(c.textContent ?? '').trim().slice(0, 40)} | ${(next.textContent ?? '').trim().slice(0, 40)} (${Math.round(gap)}px)`] : [];
      }),
  );
  expect.soft(touching, `cards without a gap between them (${where})`).toEqual([]);
}

/**
 * A button keeps room from the line that parts its row from the next (a
 * border between the rows): the busy list's "Clear finished" stood on the
 * line under its head on a phone (report dfda31).
 */
export async function buttonsOffLines(page: Page, where: string) {
  const touching = await page.evaluate(() => {
    const out: string[] = [];
    const shown = (e: Element) => (e as HTMLElement).getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    // What scrolls an element (from its parent up: a box's own border does not move with its
    // scroll), and whether it is stuck (sticky) on the way there.
    const scroller = (e: Element): Element => {
      for (let a = e.parentElement; a; a = a.parentElement) {
        const o = getComputedStyle(a).overflowY;
        if ((o === 'auto' || o === 'scroll') && a.scrollHeight > a.clientHeight + 1) return a;
      }
      return document.scrollingElement ?? document.documentElement;
    };
    // A line between rows is one of the page's own flow: a dialog's border (in the top layer) or
    // a floating box beside the row is none (a tall dialog's top met the Hosts bar's add button).
    const inFlow = (e: Element) => e.tagName !== 'DIALOG' && !['fixed', 'absolute'].includes(getComputedStyle(e).position);
    const stuck = (e: Element, upTo: Element) => {
      for (let a: Element | null = e; a && a !== upTo; a = a.parentElement) if (getComputedStyle(a).position === 'sticky') return true;
      return false;
    };
    // A scrolled box moves its content past a line beside it on the way (the host menu scrolled
    // to its Delete, the page under a sticky bar): that passing is no layout. Kept: the two in
    // one scroll, or the box scrolled to its end towards the line.
    const passing = (b: Element, line: Element, under: boolean) => {
      const sb = scroller(b);
      const sl = scroller(line);
      if ((stuck(b, sb) || stuck(line, sl)) && (sb.scrollTop > 0 || sl.scrollTop > 0)) return true;
      if (sb === sl) return false;
      if (!sl.contains(sb) && sl !== document.scrollingElement) return true;
      return under ? sb.scrollTop + sb.clientHeight < sb.scrollHeight - 1 : sb.scrollTop > 0;
    };
    for (const b of document.querySelectorAll<HTMLElement>('button.btn, a.btn')) {
      if (!shown(b)) continue;
      const r = b.getBoundingClientRect();
      // Its row and the rows around it, up to three levels out.
      let row: Element | null = b.parentElement;
      for (let i = 0; i < 3 && row && row !== document.body; i++, row = row.parentElement) {
        const next = row.nextElementSibling;
        const prev = row.previousElementSibling;
        if (next && shown(next) && inFlow(next) && parseFloat(getComputedStyle(next).borderTopWidth) >= 1) {
          const gap = next.getBoundingClientRect().top - r.bottom;
          if (gap > -1 && gap < 3 && !passing(b, next, true)) out.push(`"${(b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(gap)}px from the line under it`);
          break;
        }
        if (prev && shown(prev) && inFlow(prev) && parseFloat(getComputedStyle(prev).borderBottomWidth) >= 1) {
          const gap = r.top - prev.getBoundingClientRect().bottom;
          if (gap > -1 && gap < 3 && !passing(b, prev, false)) out.push(`"${(b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(gap)}px from the line over it`);
          break;
        }
      }
    }
    return out;
  });
  expect.soft(touching, `a button on the line between rows (${where})`).toEqual([]);
}

/**
 * Two boxes (buttons, fields, chips, cards, list rows: anything with a
 * border or background of its own) never touch or overlap, unless they are
 * one thing on purpose: rows of one list, the parts of a segmented control,
 * or a group marked data-joined. The UI round of 2026-10-09: "elements that
 * touch each other".
 */
export async function boxesApart(page: Page, where: string) {
  const bad = await page.evaluate(() => {
    const scope = document.querySelector('dialog[open]') ?? document.querySelector('main') ?? document.body;
    const clear = (c: string) => c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c);
    const boxed = (e: Element) => {
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      const border = (['Top', 'Right', 'Bottom', 'Left'] as const).some((s) => parseFloat(cs[`border${s}Width`]) > 0 && !clear(cs[`border${s}Color`]));
      return border || !clear(cs.backgroundColor);
    };
    // What shows of a box: cut by the boxes that scroll it (rows scrolled under a dialog's buttons are out of sight).
    const shown = (e: Element) => {
      const r = e.getBoundingClientRect();
      let [l, t, rt, b] = [r.left, r.top, r.right, r.bottom];
      for (let p = e.parentElement; p && p !== scope.parentElement; p = p.parentElement) {
        if (getComputedStyle(p).overflow === 'visible') continue;
        const q = p.getBoundingClientRect();
        [l, t, rt, b] = [Math.max(l, q.left), Math.max(t, q.top), Math.min(rt, q.right), Math.min(b, q.bottom)];
      }
      return { left: l, top: t, right: rt, bottom: b };
    };
    // A layer over the page (a docked panel, a selection bar) covers it on purpose: floatersClear looks at those.
    const floating = (e: Element) => {
      for (let p: Element | null = e; p && p !== scope; p = p.parentElement) if (['fixed', 'absolute', 'sticky'].includes(getComputedStyle(p).position)) return true;
      return false;
    };
    const items = [...scope.querySelectorAll('button, a.btn, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]), select, textarea, .chip, .pill, .card, .list, .alert, .segmented')].filter((e) => {
      // Drawn: not inside a closed <details> (its content keeps its boxes, out of sight).
      if (!(e as HTMLElement).checkVisibility({ visibilityProperty: true, opacityProperty: true }) || !boxed(e) || floating(e)) return false;
      // A segmented control is one box: its parts touch each other on purpose, not what is around it.
      if ((e.matches('.segmented') ? e.parentElement : e)?.closest('.xterm, .cm-editor, .keybar, [data-joined], [role=tablist], .seg, .segmented, nav, .topbar, .tabs')) return false;
      const r = shown(e);
      return r.right - r.left > 4 && r.bottom - r.top > 4;
    });
    const name = (e: Element) => `${e.tagName.toLowerCase()}${e.classList.length ? `.${[...e.classList].slice(0, 2).join('.')}` : ''} "${(e.textContent || (e as HTMLInputElement).placeholder || e.getAttribute('aria-label') || '').trim().slice(0, 24)}"`;
    const out: string[] = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]!;
        const b = items[j]!;
        // Rows of one list sit against each other by design.
        if (a.contains(b) || b.contains(a) || (a.matches('.list-item') && b.matches('.list-item'))) continue;
        const ra = shown(a);
        const rb = shown(b);
        const h = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const v = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (h > 2 && v > 2) out.push(`${name(a)} overlaps ${name(b)}`);
        else if (v > 4 && h > -2 && h <= 1) out.push(`${name(a)} touches ${name(b)} side by side (${Math.round(-h)}px)`);
        else if (h > 4 && v > -2 && v <= 1) out.push(`${name(a)} touches ${name(b)} above/below (${Math.round(-v)}px)`);
        // A segmented control a hair above its list read as part of it (report 8a99b4: Open/Solved 2 px above the reports).
        else if (h > 4 && v > -8 && v <= 1 && (a.matches('.segmented') || b.matches('.segmented'))) out.push(`${name(a)} too close to ${name(b)} above/below (${Math.round(-v)}px, 8 at least)`);
      }
    }
    return out.slice(0, 20);
  });
  expect.soft(bad, `boxes touching or overlapping (${where})`).toEqual([]);
}

/**
 * Words never lie over other words: a stack's update history put the end of
 * its date line ("| handmatig") over the image named under it (report
 * 71a779). By the lines of the text as drawn, cut by what scrolls or clips
 * them (an ellipsis hides the rest); a layer over the page is left to the
 * floater checks.
 */
export async function textApart(page: Page, where: string) {
  const out = await page.evaluate(() => {
    const scope = document.querySelector('dialog[open]') ?? document.querySelector('main') ?? document.body;
    const floating = (e: Element) => {
      for (let p: Element | null = e; p && p !== scope; p = p.parentElement) if (['fixed', 'absolute', 'sticky'].includes(getComputedStyle(p).position)) return true;
      return false;
    };
    const clip = (e: Element, r: DOMRect) => {
      let [l, t, rt, b] = [r.left, r.top, r.right, r.bottom];
      for (let p: Element | null = e; p && p !== scope.parentElement; p = p.parentElement) {
        if (getComputedStyle(p).overflow === 'visible') continue;
        const q = p.getBoundingClientRect();
        [l, t, rt, b] = [Math.max(l, q.left), Math.max(t, q.top), Math.min(rt, q.right), Math.min(b, q.bottom)];
      }
      return { l, t, r: rt, b };
    };
    const lines: { l: number; t: number; r: number; b: number; el: Element; text: string }[] = [];
    const walk = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    const seen = new Map<Element, boolean>();
    for (let n = walk.nextNode(); n && lines.length < 3000; n = walk.nextNode()) {
      const text = n.textContent!.trim();
      const el = n.parentElement;
      if (!text || !el) continue;
      let ok = seen.get(el);
      if (ok === undefined) {
        ok = el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && !el.closest('.xterm, .cm-editor, .toast, svg, [data-axe-skip], .sr-only, .visually-hidden') && !floating(el);
        seen.set(el, ok);
      }
      if (!ok) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const x of range.getClientRects()) {
        const c = clip(el, x);
        if (c.r - c.l > 3 && c.b - c.t > 4 && c.b > 0 && c.t < innerHeight) lines.push({ ...c, el, text });
      }
    }
    const found: string[] = [];
    const rows = new Map<number, number[]>();
    lines.forEach((x, i) => {
      for (let k = Math.floor(x.t / 16); k <= Math.floor(x.b / 16); k++) rows.set(k, [...(rows.get(k) ?? []), i]);
    });
    const told = new Set<string>();
    for (const idx of rows.values()) {
      for (let i = 0; i < idx.length; i++) {
        for (let j = i + 1; j < idx.length; j++) {
          const a = lines[idx[i]!]!;
          const b = lines[idx[j]!]!;
          if (a.el === b.el) continue;
          const h = Math.min(a.r, b.r) - Math.max(a.l, b.l);
          const v = Math.min(a.b, b.b) - Math.max(a.t, b.t);
          // More than a sliver: a third of the lower line's height, and a few pixels across.
          if (h > 3 && v > Math.min(a.b - a.t, b.b - b.t) / 3) {
            const key = `"${a.text.slice(0, 24)}" over "${b.text.slice(0, 24)}"`;
            if (!told.has(key)) {
              told.add(key);
              found.push(key);
            }
          }
        }
      }
    }
    return found.slice(0, 10);
  });
  expect.soft(out, `words over other words (${where})`).toEqual([]);
}

/**
 * A field, a button or a chip keeps room from the edge of the pane it is in:
 * the logs' search and filters in a workspace's bottom panel sat against the
 * file tree's line, as if part of it (report d31c8d). The pane is the nearest
 * ancestor that draws itself (a border, or a background unlike the one behind
 * it) or clips (overflow hidden); a control that starts where that pane starts
 * (within 2 px) touches its edge. The screen's own edge is not a pane's (a
 * phone's full-width bar), nor a scrolling row's or column's (chips, sessions:
 * no line there, the content scrolls to it), nor a sticky form's that has the
 * dialog's own background (the AI dialog's question).
 */
export async function controlsOffEdges(page: Page, where: string) {
  const bad = await page.evaluate(() => {
    const scope = document.querySelector('dialog[open]') ?? document.querySelector('main') ?? document.body;
    const clear = (c: string) => c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c);
    const behind = (e: Element) => {
      for (let a = e.parentElement; a; a = a.parentElement) if (!clear(getComputedStyle(a).backgroundColor)) return getComputedStyle(a).backgroundColor;
      return '';
    };
    const draws = (a: Element, cs: CSSStyleDeclaration, side: 'Left' | 'Right') =>
      (parseFloat(cs[`border${side}Width`]) > 0 && !clear(cs[`border${side}Color`])) || (!clear(cs.backgroundColor) && cs.backgroundColor !== behind(a)) || cs.overflowX === 'hidden' || cs.overflowX === 'clip';
    const boxed = (e: Element) => {
      const cs = getComputedStyle(e);
      return (['Top', 'Left'] as const).some((x) => parseFloat(cs[`border${x}Width`]) > 0 && !clear(cs[`border${x}Color`])) || !clear(cs.backgroundColor);
    };
    const out: string[] = [];
    for (const e of scope.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]), select, textarea, .chip, .btn')) {
      if (!(e as HTMLElement).checkVisibility({ visibilityProperty: true, opacityProperty: true }) || !boxed(e)) continue;
      // Joined on purpose, or a bar's own parts.
      if (e.closest('.xterm, .cm-editor, .keybar, [data-joined], [role=tablist], .segmented, .seg, nav, .topbar, .tabs, .list-item, .list, dialog > footer, .bulkbar, .actionbar')) continue;
      const r = e.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      for (let a = e.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const cs = getComputedStyle(a);
        const q = a.getBoundingClientRect();
        const left = q.left + parseFloat(cs.borderLeftWidth);
        const right = q.right - parseFloat(cs.borderRightWidth);
        const atLeft = draws(a, cs, 'Left') && Math.abs(r.left - left) < 2 && left > 1;
        const atRight = draws(a, cs, 'Right') && Math.abs(right - r.right) < 2 && right < window.innerWidth - 1;
        if (atLeft || atRight) out.push(`${e.tagName.toLowerCase()} "${((e as HTMLInputElement).placeholder || e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 24)}" against the ${atLeft ? 'left' : 'right'} edge of ${a.tagName.toLowerCase()}.${[...a.classList].slice(0, 2).join('.')}`);
        if (draws(a, cs, 'Left') || draws(a, cs, 'Right')) break;
      }
    }
    return [...new Set(out)].slice(0, 10);
  });
  expect.soft(bad, `controls against the edge of their pane (${where})`).toEqual([]);
}

/**
 * Text keeps room inside a box drawn with a border (a list, a card, a
 * notice): the Proxmox guests' names and states sat against their list's
 * border (padding-inline: 0 on the rows).
 */
export async function textInsideBorders(page: Page, where: string) {
  const bad = await page.evaluate(() => {
    const scope = document.querySelector('dialog[open]') ?? document.querySelector('main') ?? document.body;
    const clear = (c: string) => c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c) || /\/\s*0\)$/.test(c);
    const out: string[] = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && out.length < 10; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const el = n.parentElement!;
      if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || el.closest('.xterm, .cm-editor, .keybar, button, a.btn, .chip, .pill, input, select, textarea, svg, pre, code, table')) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
      if (!rects.length) continue;
      let left = Math.min(...rects.map((r) => r.left));
      let right = Math.max(...rects.map((r) => r.right));
      // The nearest box with a side border around it, of a list, card or notice.
      // Text cut off on the way (an ellipsis, a scrolling box) ends where it is cut.
      for (let c: Element | null = el; c && !c.matches('.list, .card, .alert'); c = c.parentElement) {
        if (getComputedStyle(c).overflowX === 'visible') continue;
        const q = c.getBoundingClientRect();
        left = Math.max(left, q.left);
        right = Math.min(right, q.right);
      }
      for (let b: Element | null = el; b && b !== scope.parentElement; b = b.parentElement) {
        if (!b.matches('.list, .card, .alert, .list-item')) continue;
        const cs = getComputedStyle(b);
        const box = b.getBoundingClientRect();
        const lw = parseFloat(cs.borderLeftWidth);
        const rw = parseFloat(cs.borderRightWidth);
        const hasL = lw > 0 && !clear(cs.borderLeftColor);
        const hasR = rw > 0 && !clear(cs.borderRightColor);
        if (!hasL && !hasR) continue;
        const gapL = left - (box.left + lw);
        const gapR = box.right - rw - right;
        const what = `"${n.textContent.trim().slice(0, 24)}" in ${b.tagName.toLowerCase()}.${[...b.classList].slice(0, 2).join('.')}`;
        if (hasL && gapL > -1 && gapL < 3) out.push(`${what}: ${Math.round(gapL)}px from its left border`);
        else if (hasR && gapR > -1 && gapR < 3) out.push(`${what}: ${Math.round(gapR)}px from its right border`);
        break;
      }
    }
    return out;
  });
  expect.soft(bad, `text against the border of its box (${where})`).toEqual([]);
}

/**
 * In one column, blocks are as wide as each other: a card, list, notice or
 * field narrower than the column its siblings fill stands out; and in one
 * card on a phone the buttons are all full width or none (the stack page
 * had Pull/Up/Restart/Down small under full-width Edit and Update now).
 * The UI round of 2026-10-09: "full width or not".
 */
export async function widthsEven(page: Page, where: string) {
  const bad = await page.evaluate(() => {
    const scope = document.querySelector('dialog[open]') ?? document.querySelector('main') ?? document.body;
    const out: string[] = [];
    const blocks = 'section.card, .card, .list, .alert, form, textarea, select, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden])';
    for (const col of [scope, ...scope.querySelectorAll('*')] as HTMLElement[]) {
      if (!col.getClientRects().length || col.closest('.xterm, .cm-editor')) continue;
      const cs = getComputedStyle(col);
      const column = cs.display === 'block' || (cs.display.includes('flex') && cs.flexDirection === 'column') || (cs.display.includes('grid') && cs.gridTemplateColumns.split(' ').length === 1);
      if (!column) continue;
      const inner = col.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth);
      const kids = [...col.children].filter((k) => k.matches(blocks) && (k as HTMLElement).getClientRects().length && !['fixed', 'absolute'].includes(getComputedStyle(k).position)) as HTMLElement[];
      if (kids.length < 2) continue;
      const full = kids.filter((k) => Math.abs(k.getBoundingClientRect().width - inner) <= 2);
      if (!full.length) continue;
      for (const k of kids) {
        const w = k.getBoundingClientRect().width;
        if (inner - w > 16 && getComputedStyle(k).marginLeft !== 'auto') out.push(`${k.tagName.toLowerCase()}.${[...k.classList].slice(0, 2).join('.')} "${(k.textContent || (k as HTMLInputElement).placeholder || '').trim().slice(0, 24)}" ${Math.round(w)} of ${Math.round(inner)}px`);
      }
    }
    // A page's parts are as wide as each other: on a very wide screen the
    // stacks ran in two columns across the screen and the search row above
    // them stopped at two thirds (report 5fee2b).
    for (const pg of document.querySelectorAll('.page')) {
      // Blocks: a button standing on its own in the page is not one of its parts.
      const kids = [...pg.children].filter((k) => !k.matches('.topbar, .full-bleed, button, a, .btn') && (k as HTMLElement).checkVisibility() && !['fixed', 'absolute', 'sticky'].includes(getComputedStyle(k).position) && !['inline', 'contents', 'none'].includes(getComputedStyle(k).display)) as HTMLElement[];
      const widest = Math.max(0, ...kids.map((k) => k.getBoundingClientRect().width));
      for (const k of kids) {
        const w = k.getBoundingClientRect().width;
        const [ml, mr] = [parseFloat(getComputedStyle(k).marginLeft), parseFloat(getComputedStyle(k).marginRight)];
        // Centred on purpose (an empty page's actions under its text): also when the page's column
        // is itself centred and narrower than the page (a tablet, A3-WEB-15).
        if (Math.abs(ml - mr) < 1 && ml > 8 && w < widest) continue;
        if (widest - w > 16) out.push(`page part ${k.tagName.toLowerCase()}.${[...k.classList].slice(0, 2).join('.')} ${Math.round(w)} of ${Math.round(widest)}px`);
      }
    }
    // A phone: a card's actions fill their line, one full-width button or a
    // row of them together (the stack page had Pull, Up, Restart and Down
    // small at the left, under full-width Edit and Update now).
    if (window.innerWidth <= 600) {
      const groups = new Map<HTMLElement, HTMLElement[]>();
      for (const b of scope.querySelectorAll('.card .btn')) {
        const el = b as HTMLElement;
        if (!el.checkVisibility() || el.closest('.card .card, .list, .list-item, [role=tablist], .seg, .linkrow, dialog footer, .topbar')) continue;
        const parent = el.parentElement!;
        // A small button beside a heading is the heading's.
        if (parent.querySelector(':scope > h2, :scope > h3, :scope > h4')) continue;
        groups.set(parent, [...(groups.get(parent) ?? []), el]);
      }
      for (const [parent, btns] of groups) {
        const cs = getComputedStyle(parent);
        const row = cs.display.includes('flex') && !cs.flexDirection.startsWith('column');
        // A button beside a field, a command or words: sized by what it sits beside.
        if (row && [...parent.children].some((c) => !c.matches('.btn') && (c as HTMLElement).checkVisibility() && c.getBoundingClientRect().width > 0)) continue;
        const inner = parent.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const lines = new Map<number, HTMLElement[]>();
        for (const b of btns) lines.set(Math.round(b.getBoundingClientRect().top), [...(lines.get(Math.round(b.getBoundingClientRect().top)) ?? []), b]);
        for (const line of lines.values()) {
          const span = Math.max(...line.map((b) => b.getBoundingClientRect().right)) - Math.min(...line.map((b) => b.getBoundingClientRect().left));
          if (span < inner - 4) out.push(`${line.map((b) => `"${b.textContent!.trim().slice(0, 20)}"`).join(', ')} ${Math.round(span)} of ${Math.round(inner)}px wide`);
        }
      }
    }
    return [...new Set(out)].slice(0, 20);
  });
  expect.soft(bad, `blocks of one column not equally wide (${where})`).toEqual([]);
}
