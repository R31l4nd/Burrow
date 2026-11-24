import { expect, type Page } from '@playwright/test';

// Rows and buttons: terminals in their box, buttons on one line, tables, controls filling their line. Part of checks.ts (lookAt).

/**
 * The terminal page keeps its bar (the way back, the session tabs) while
 * there is room for it, the keyboard up too: on a foldable's inner screen
 * it went, and with it every way out but the phone's Back (report ce0acd).
 * Only a phone turned on its side with its keyboard up is too low for it.
 */
export async function termBarKept(page: Page, where: string) {
  const lost = await page.evaluate(() => {
    if (!document.querySelector('.term-page') || window.innerHeight <= 300) return null;
    const bar = document.querySelector<HTMLElement>('.term-top');
    const shown = (e: Element | null | undefined) => !!e && (e as HTMLElement).getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    // Its tabs, where there are tabs: the direct route (the Android app's own) has one session at a time, its name in the bar.
    const tabs = !!bar?.querySelector('[data-testid=route-direct]') || shown(bar?.querySelector('[role=tablist]')) || shown(bar?.querySelector('.title'));
    return shown(bar) && shown(bar?.querySelector('button')) && tabs ? null : `${window.innerWidth}x${window.innerHeight}`;
  });
  expect.soft(lost, `terminal without its bar (way back, tabs) although there is room (${where})`).toBeNull();
}

/**
 * A terminal's rows and columns inside its box: the fit once counted the box's padding as room, and
 * at some heights the last row (the prompt) went half under the box's edge (report de3278). Not while
 * the keyboard keeps the rows (the box scrolls) or another device's size is shown (it scrolls too).
 */
export async function termRowsInside(page: Page, where: string) {
  const measure = () =>
    [...document.querySelectorAll<HTMLElement>('.term-wrap:not(.kept):not(.other)')].flatMap((w) => {
      const screen = w.querySelector('.xterm-screen');
      if (!screen || !w.getClientRects().length) return [];
      const box = w.getBoundingClientRect();
      const r = screen.getBoundingClientRect();
      const out = [];
      // What was shown, for a cut seen once in a gate and not again (2026-11-06): rows, box, window.
      const seen = `(${screen.querySelectorAll('.xterm-rows > div').length} rows of ${Math.round(r.height)}px in a ${Math.round(box.height)}px box, window ${window.innerWidth}x${window.innerHeight}, ${w.className})`;
      if (r.bottom > box.bottom + 0.5) out.push(`${Math.round(r.bottom - box.bottom)}px under its bottom edge ${seen}`);
      if (r.right > box.right + 0.5) out.push(`${Math.round(r.right - box.right)}px past its right edge ${seen}`);
      return out;
    });
  // Right after the window changed size the fit is still on its way (a frame, the session's new size
  // from the server): a moment for it, then what stays cut is cut (the sizes run, 2026-11-06). Up to
  // ten seconds: under a gate's load three were not always enough (a NOTE at size-desktop-terminal);
  // a fit that is done ends the wait at once.
  await page.waitForFunction(`(${measure.toString()})().length === 0`, undefined, { timeout: 10_000 }).catch(() => {});
  const cut = await page.evaluate(measure);
  expect.soft(cut, `terminal rows or columns cut off by its box (${where})`).toEqual([]);
}

/**
 * A laptop gets a laptop's layout: the navigation a rail on the left (not a
 * phone's tab bar across the bottom), and what a page is about under its
 * title, not as a pill at the far end of the top bar.
 */
/** A field's placeholder fits the field (a cut-off hint says half of what it means). */
export async function placeholdersWhole(page: Page, where: string) {
  const cut = await page.locator('input[placeholder]:visible, textarea[placeholder]:visible').evaluateAll((els) => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    return (els as HTMLInputElement[])
      .filter((e) => !e.value && e.tagName === 'INPUT')
      .filter((e) => {
        const cs = getComputedStyle(e);
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const room = e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        return ctx.measureText(e.placeholder).width > room + 1;
      })
      .map((e) => e.placeholder);
  });
  expect.soft(cut, `placeholders cut off (${where})`).toEqual([]);
}

/** Text is never squeezed into a sliver (a word a letter per line beside a greedy neighbour). */
export async function textNotSqueezed(page: Page, where: string) {
  const squeezed = await page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent!.trim();
      const el = n.parentElement;
      if (text.length < 6 || !el || !el.getClientRects().length) continue;
      // The text's own box: text straight in a grid or flex container is an item of its own,
      // as narrow as its track, while its element is wide (a disk's "3 more files", report d4a9c0).
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      const line = parseFloat(getComputedStyle(el).lineHeight) || 16;
      // Narrower than three letters and taller than four lines.
      if (r.width < line * 1.5 && r.height > line * 4) out.push(text.slice(0, 30));
    }
    return out;
  });
  expect.soft(squeezed, `text squeezed into a sliver (${where})`).toEqual([]);
}

/** A button at the end of a list's row keeps its label on one line ("Hosts kiezen" wrapped). */
export async function rowButtonOneLine(page: Page, where: string) {
  const wrapped = await page.evaluate(() =>
    [...document.querySelectorAll('.list-item > .btn')]
      .filter((b) => (b as HTMLElement).getClientRects().length)
      .filter((b) => {
        // The distinct tops of the label's text (icons left out).
        const tops = new Set<number>();
        const walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (!n.textContent!.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const x of range.getClientRects()) if (x.width > 1) tops.add(Math.round(x.top / 4));
        }
        return tops.size > 1;
      })
      .map((b) => b.textContent!.trim()),
  );
  expect.soft(wrapped, `a row's button on two lines (${where})`).toEqual([]);
}

/**
 * A button narrower than its box keeps its label on one line: it had room to
 * be wider. "Nu controleren" beside the image updates' title and "Uitvoer
 * verbergen" beside its chevron each broke over two lines (report 1d821b);
 * rowButtonsEven sees only rows of two or more. A full-width button may wrap
 * a label longer than the screen.
 */
export async function buttonLabelsOneLine(page: Page, where: string) {
  const wrapped = await page.evaluate(() =>
    [...document.querySelectorAll('.btn')]
      .filter((b) => (b as HTMLElement).checkVisibility() && !b.closest('.xterm, .cm-editor'))
      .filter((b) => {
        const box = b.parentElement!;
        const cs = getComputedStyle(box);
        const inner = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        if (b.getBoundingClientRect().width >= inner - 4) return false;
        // One text of the label over more than one line (a title and its line under it are two texts).
        const walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          if (!n.textContent!.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          const tops = new Set([...range.getClientRects()].filter((x) => x.width > 1).map((x) => Math.round(x.top / 4)));
          if (tops.size > 1) return true;
        }
        return false;
      })
      .map((b) => `"${b.textContent!.trim()}" ${Math.round(b.getBoundingClientRect().width)} px wide`),
  );
  expect.soft(wrapped, `a button's label on two lines though it had room (${where})`).toEqual([]);
}

/**
 * Buttons of one rank that share a line and are stretched to fill it are
 * equally wide: the stack's Pull | Up | Herstarten | Down filled the row in
 * four widths, each its word plus a share of the room (report 1d821b).
 * Buttons as wide as their words (a computer's compact row) are left alone,
 * and so is one whose words need more than an even share; a primary beside
 * plain ones is of another rank.
 */
export async function rowButtonsSameWidth(page: Page, where: string) {
  const uneven = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll('.btn')].map((b) => b.parentElement!))]
      .filter((r) => r.checkVisibility() && !r.closest('.jump, .keys, .keybar, .seg, [role=tablist]'))
      .flatMap((r) => {
        const cs = getComputedStyle(r);
        const flexRow = cs.display.includes('flex') && cs.flexDirection.startsWith('row');
        if (!flexRow && !cs.display.includes('grid')) return [];
        const btns = [...r.children].filter((c) => c.classList.contains('btn') && (c as HTMLElement).checkVisibility()) as HTMLElement[];
        // Only buttons: a button beside a field, a title or words is sized by what it sits beside.
        if (btns.length < 2 || [...r.children].some((c) => !c.classList.contains('btn') && (c as HTMLElement).checkVisibility() && c.getBoundingClientRect().width > 0)) return [];
        // As wide as its words: measured with nothing stretching it, then put back as it was.
        const natural = (b: HTMLElement) => {
          const had = b.style.cssText;
          for (const [k, v] of [['transition', 'none'], ['flex', 'none'], ['width', 'max-content'], ['min-width', '0'], ['max-width', 'none'], ['justify-self', 'start'], ['align-self', 'start']]) b.style.setProperty(k!, v!, 'important');
          const w = b.getBoundingClientRect().width;
          b.style.cssText = had;
          return w;
        };
        const lines = new Map<number, HTMLElement[]>();
        for (const b of btns) {
          const top = Math.round(b.getBoundingClientRect().top / 8);
          lines.set(top, [...(lines.get(top) ?? []), b]);
        }
        return [...lines.values()].flatMap((line) => {
          if (line.length < 2 || new Set(line.map((b) => b.classList.contains('primary'))).size > 1) return [];
          const ws = line.map((b) => b.getBoundingClientRect().width);
          const stretched = line.map((b, i) => ws[i]! > natural(b) + 2);
          const wide = ws.filter((_, i) => stretched[i]);
          const asWords = ws.filter((_, i) => !stretched[i]);
          if (!wide.length) return [];
          // Stretched ones of different widths, or one stretched past another left as wide as its words.
          const uneven = Math.max(...wide) - Math.min(...wide) > 2 || asWords.some((w) => Math.max(...wide) > w + 2);
          return uneven ? [line.map((b, i) => `${b.textContent!.trim()} ${Math.round(ws[i]!)}px`).join(' | ')] : [];
        });
      }),
  );
  expect.soft(uneven, `buttons of one rank filling a line in different widths (${where})`).toEqual([]);
}

/**
 * From a tablet up (720 px) a list whose rows are a table on a computer is
 * one there too (hosts, containers, files as a list): an
 * 820 px tablet got the phone's two-line rows stretched over 760 px, the
 * buttons far from the names and no sparklines (A3-WEB-15).
 */
export async function tablesFromTablet(page: Page, where: string) {
  const flat = await page.evaluate(() =>
    window.innerWidth < 720
      ? []
      : [...document.querySelectorAll<HTMLElement>('.host-row .tap, .crow, .list:not(.grid) > [data-testid=file-row] > .tap')]
          .filter((r) => r.checkVisibility() && !r.closest('dialog'))
          .filter((r) => {
            const cs = getComputedStyle(r);
            return !cs.display.includes('grid') || cs.gridTemplateColumns.split(' ').length < 5;
          })
          .map((r) => r.textContent!.trim().slice(0, 30)),
  );
  expect.soft([...new Set(flat)].slice(0, 5), `rows not laid out as a table from a tablet up (${where})`).toEqual([]);
}

/**
 * A log line keeps its parts in sight: a long source name in a merged log
 * is cut with "...", not clipped mid-word at the screen's edge with the
 * level pushed out of sight (A3-WEB-10); a JSON line's {...} button is one
 * piece, not "{..." over "}" (report 87f290's picture).
 */
export async function logLinesWhole(page: Page, where: string) {
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid=log-line]')]
      .filter((l) => l.checkVisibility())
      .slice(0, 200)
      .flatMap((l) => {
        const box = l.getBoundingClientRect();
        const out: string[] = [];
        for (const part of l.querySelectorAll<HTMLElement>(':scope > time, :scope > .src, :scope > .lvl')) {
          const r = part.getBoundingClientRect();
          if (r.right > box.right + 1) out.push(`${part.className.split(' ')[0] || part.tagName.toLowerCase()} "${part.textContent!.trim().slice(0, 30)}" past the line's edge`);
          if (part.scrollWidth > part.clientWidth + 1 && getComputedStyle(part).textOverflow !== 'ellipsis') out.push(`"${part.textContent!.trim().slice(0, 30)}" cut without ...`);
        }
        for (const j of l.querySelectorAll<HTMLElement>('button.json')) {
          const rects = [...j.getClientRects()];
          if (rects.length > 1 || (rects[0] && rects[0].height > parseFloat(getComputedStyle(j).lineHeight || '0') * 1.6 && rects[0].height > 24)) out.push(`"${j.textContent!.trim()}" on two lines`);
        }
        return out;
      }),
  );
  expect.soft([...new Set(bad)].slice(0, 10), `log lines with parts cut or out of sight (${where})`).toEqual([]);
}

/**
 * A button stays inside the box that cuts it off: "Add a folder" ran 16 px
 * under the edge of the workspace's side bar (full width plus a margin).
 * A strip that scrolls sideways on purpose (tabs, keys) is left alone.
 */
export async function buttonsInside(page: Page, where: string) {
  const out = await page.evaluate(() =>
    [...document.querySelectorAll('.btn, .icon-btn')]
      .filter((b) => (b as HTMLElement).getClientRects().length)
      .flatMap((b) => {
        let box = b.parentElement;
        while (box && box !== document.body) {
          const cs = getComputedStyle(box);
          if (cs.overflowX !== 'visible') break;
          box = box.parentElement;
        }
        if (!box || box === document.body) return [];
        const cs = getComputedStyle(box);
        if (cs.display.includes('flex') && cs.flexDirection === 'row' && cs.flexWrap === 'nowrap') return [];
        const r = b.getBoundingClientRect();
        const c = box.getBoundingClientRect();
        const past = Math.max(r.right - c.right, c.left - r.left);
        return past > 1 ? [`${b.textContent!.trim() || b.getAttribute('aria-label')} (${Math.round(past)} px)`] : [];
      }),
  );
  expect.soft(out, `a button past the edge of its box (${where})`).toEqual([]);
}

/**
 * In a phone's layout (the tab bar at the bottom, under 720 px) a button or a field alone on its
 * line takes the whole line, as the fields around it: Save words-wide at the right of a settings
 * part (reports 9d013e, ac7e33, 17c4ec), Check now words-wide at the left under its title
 * (e67a3f), how long recordings are kept in a narrow select (6bd934). A centred column (an empty
 * page's way on) is its own. Settings' parts (`.fill-controls`) are laid out so at every width:
 * on a computer Save, Audit log and the recordings' select sat words-wide beside full-width
 * fields and lists (reports c7665e, c75bda, a08646, bc933c).
 */
export async function loneControlsFill(page: Page, where: string) {
  const out = await page.evaluate(() => {
    const phone = innerWidth < 720;
    // Settings' parts fill only where app.css makes them: a computer (a tablet keeps its own layout).
    const fill = matchMedia('(pointer: fine) and (min-width: 900px)').matches;
    const shown = (e: Element) => (e as HTMLElement).getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    // A select of its own (a range in a title row: report a6548d, a narrow Last day under its title) too; one in a field is the field's.
    return [...document.querySelectorAll('.btn, label.field, select:not(label.field select)')]
      .filter((e) => phone || (fill && e.closest('.fill-controls') && !e.closest('dialog')))
      .filter((e) => shown(e) && !e.closest('dialog footer, .list-item, .topbar, .bottomnav, .center-screen, .empty, .fab, .toast, .btnrow, .row, .form-end > span'))
      .flatMap((e) => {
        const parent = e.parentElement;
        if (!parent) return [];
        // Floating over the page (the history layer's Back to live): on no line at all.
        if (['absolute', 'fixed'].includes(getComputedStyle(e).position)) return [];
        const pcs = getComputedStyle(parent);
        if (pcs.display.includes('flex') && pcs.flexDirection.startsWith('column') && pcs.alignItems === 'center') return [];
        // A bar of controls that never wraps (a panel's header): the button is one of the bar's, not a line's.
        if (pcs.display.includes('flex') && pcs.flexDirection === 'row' && pcs.flexWrap === 'nowrap') return [];
        if (pcs.display === 'inline' || pcs.display === 'contents') return [];
        const r = e.getBoundingClientRect();
        const beside = [...parent.children].some((s) => {
          if (s === e || !shown(s) || getComputedStyle(s).position === 'absolute') return false;
          const b = s.getBoundingClientRect();
          return b.width > 0 && b.top < r.bottom - 2 && r.top < b.bottom - 2;
        });
        if (beside) return [];
        const p = parent.getBoundingClientRect();
        const room = p.width - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight) - parseFloat(pcs.borderLeftWidth) - parseFloat(pcs.borderRightWidth);
        const short = room - r.width;
        return short > 8 ? [`${(e.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40) || e.getAttribute('aria-label')} (${Math.round(r.width)} of ${Math.round(room)} px)`] : [];
      });
  });
  expect.soft(out, `a button or field alone on its line, not the line's width, on a phone or in settings (${where})`).toEqual([]);
}

/**
 * A button on a field's line is as high as the field: the search's Aa, .* and Replace sat lower
 * than the search beside them (report eb4f8a). Buttons with a border only: an icon without one
 * has no edge to line up.
 */
export async function besideFieldSameHeight(page: Page, where: string) {
  const out = await page.evaluate(() => {
    const shown = (e: Element) => (e as HTMLElement).getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0;
    return [...document.querySelectorAll("input:not([type='checkbox'], [type='radio'], [type='range'], [type='color'], [type='hidden'], [type='file']), select")].filter(shown).flatMap((f) => {
      const line = f.parentElement;
      if (!line) return [];
      const cs = getComputedStyle(line);
      if (!cs.display.includes('flex') || !cs.flexDirection.startsWith('row')) return [];
      // A field without a border is part of a box around it (a log search with its .* inside).
      if (parseFloat(getComputedStyle(f).borderTopWidth) === 0) return [];
      const r = f.getBoundingClientRect();
      return [...line.children]
        .filter((b) => b !== f && b.tagName === 'BUTTON' && shown(b) && parseFloat(getComputedStyle(b).borderTopWidth) > 0)
        .flatMap((b) => {
          const q = b.getBoundingClientRect();
          if (q.top >= r.bottom - 2 || r.top >= q.bottom - 2) return [];
          // Inside the field (a log search's .*): part of it, not beside it.
          if (q.left >= r.left - 1 && q.right <= r.right + 1) return [];
          const name = (b.textContent ?? '').trim().slice(0, 20) || b.getAttribute('aria-label');
          return Math.abs(q.height - r.height) > 2 ? [`${name}: ${Math.round(q.height)} px beside a field of ${Math.round(r.height)} px`] : [];
        });
    });
  });
  expect.soft(out, `a button lower or higher than the field on its line (${where})`).toEqual([]);
}

/**
 * Text cut after a few lines is cut: shown past its lines it ran over the row below (report e458b7,
 * a service's description in System logs over the next service).
 */
export async function clampedTextInside(page: Page, where: string) {
  const out = await page.evaluate(() => {
    // Only what a stylesheet clamps: every element of a page of logs took minutes (gate 40).
    const selectors: string[] = [];
    const walk = (rules: CSSRuleList) => {
      for (const r of rules) {
        if (r instanceof CSSStyleRule && (r.style.getPropertyValue('-webkit-line-clamp') || r.style.getPropertyValue('line-clamp'))) selectors.push(r.selectorText);
        if ('cssRules' in r && (r as CSSGroupingRule).cssRules?.length) walk((r as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch {
        // Another origin's sheet: not ours to clamp.
      }
    }
    const clamped = new Set(
      selectors.flatMap((sel) => {
        try {
          return [...document.querySelectorAll(sel)];
        } catch {
          return [];
        }
      }),
    );
    return [...clamped].flatMap((e) => {
      const cs = getComputedStyle(e);
      const clamp = cs.getPropertyValue('-webkit-line-clamp');
      if (!clamp || clamp === 'none' || !cs.display.includes('-webkit-box') || cs.overflowY !== 'visible') return [];
      const h = e as HTMLElement;
      return h.scrollHeight > h.clientHeight + 1 ? [(h.textContent ?? '').trim().slice(0, 40)] : [];
    });
  });
  expect.soft(out, `text cut after its lines but shown past them, over what is below (${where})`).toEqual([]);
}

/**
 * On a phone a row of actions stays one row: a chosen log line's Pin, Copy link and Copy went onto
 * a second row (report 41947e, the user: "not wanted on a phone"); where words do not fit, icons.
 * Rows that are meant to stack (`.btnrow.stacks`, `.btnrow.even`, a dialog's footer, a form's end)
 * and a sideways strip are their own.
 */
export async function actionRowsOneLine(page: Page, where: string) {
  const out = await page.evaluate(() => {
    if (innerWidth >= 720) return [];
    const shown = (e: Element) => (e as HTMLElement).getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0;
    return [...new Set([...document.querySelectorAll('.btn')].map((b) => b.parentElement!))]
      .filter((r) => shown(r) && !r.matches('.btnrow.stacks, .btnrow.even, .form-end, footer') && !r.closest('dialog footer'))
      .flatMap((r) => {
        const cs = getComputedStyle(r);
        if (!cs.display.includes('flex') || !cs.flexDirection.startsWith('row') || cs.overflowX !== 'visible') return [];
        const kids = [...r.children].filter(shown);
        if (kids.length < 2 || kids.some((c) => !c.classList.contains('btn'))) return [];
        const tops = new Set(kids.map((c) => Math.round(c.getBoundingClientRect().top / 4)));
        return tops.size > 1 ? [kids.map((c) => (c.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 20) || c.getAttribute('aria-label')).join(' | ')] : [];
      });
  });
  expect.soft(out, `a row of buttons over two rows on a phone (${where})`).toEqual([]);
}

/**
 * Where lone controls fill their line (a phone's layout, settings' parts), buttons side by side
 * fill it together, and a view switch is the line's width: New snippet and A command on several
 * hosts, Back up now and Download, Show all and Sign out everywhere else, Open and Solved sat
 * words-wide at the left of a computer's settings (reports 46158b, 23a0b1, a08646, f6bfd6).
 */
export async function rowsFill(page: Page, where: string) {
  const out = await page.evaluate(() => {
    const phone = innerWidth < 720;
    const fill = matchMedia('(pointer: fine) and (min-width: 900px)').matches;
    const shown = (e: Element) => (e as HTMLElement).getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const room = (p: Element) => {
      const cs = getComputedStyle(p);
      const r = p.getBoundingClientRect();
      return { left: r.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth), right: r.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth) };
    };
    return [...document.querySelectorAll('.btnrow, .form-end, .row, .segmented')]
      // A row of buttons on every screen (report 71a779: words-wide at the left on a computer beside a
      // card whose row filled it); a view switch on a phone and in Settings.
      .filter((r) => shown(r) && (phone || (!r.closest('dialog') && (!r.classList.contains('segmented') || (fill && r.closest('.fill-controls'))))) && !r.closest('dialog footer, .list-item, .topbar, .toolbar, .bottomnav, .center-screen, .empty, .toast'))
      .flatMap((r) => {
        const seg = r.classList.contains('segmented');
        const kids = [...r.children].filter((c) => shown(c) && c.getBoundingClientRect().width > 0);
        if (!seg && (kids.length < 2 || kids.some((c) => !c.classList.contains('btn')))) return [];
        // The switch fills its parent's line; buttons fill their row's last line.
        const box = seg ? room(r.parentElement!) : room(r);
        const outer = seg ? r.getBoundingClientRect() : (() => {
          const rs = kids.map((c) => c.getBoundingClientRect());
          return { left: Math.min(...rs.map((x) => x.left)), right: Math.max(...rs.map((x) => x.right)) };
        })();
        const short = box.right - box.left - (outer.right - outer.left);
        return short > 8 ? [`${kids.map((c) => (c.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24)).join(' | ')} (${Math.round(outer.right - outer.left)} of ${Math.round(box.right - box.left)} px)`] : [];
      });
  });
  expect.soft(out, `buttons side by side or a view switch short of their line where lone ones fill it (${where})`).toEqual([]);
}

/**
 * Words beside a button get the room, not the button: on a folded-open phone the terminal's "the
 * list of sessions could not be read" stood one word a line in a narrow column while Try again
 * took the rest of the line (report a3c513). A text a few lines high, narrower than the button
 * beside it and than a third of their row.
 */
export async function textBesideButton(page: Page, where: string) {
  const out = await page.evaluate(() => {
    const shown = (e: Element) => (e as HTMLElement).getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0;
    return [...new Set([...document.querySelectorAll('.btn')].filter(shown).map((b) => b.parentElement!))].flatMap((r) => {
      const cs = getComputedStyle(r);
      if (!cs.display.includes('flex') || !cs.flexDirection.startsWith('row')) return [];
      const kids = [...r.children].filter(shown);
      const btns = kids.filter((k) => k.classList.contains('btn'));
      const row = r.getBoundingClientRect().width;
      return kids
        .filter((k) => !k.matches('.btn, .icon-btn, svg, input, select, textarea') && (k.textContent ?? '').trim().length > 20)
        .flatMap((k) => {
          const b = k.getBoundingClientRect();
          const line = parseFloat(getComputedStyle(k).lineHeight) || parseFloat(getComputedStyle(k).fontSize) * 1.4;
          const wider = btns.some((x) => x.getBoundingClientRect().width > b.width);
          return b.height > 2.5 * line && b.width < row / 3 && wider ? [`${(k.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)} (${Math.round(b.width)} of ${Math.round(row)} px)`] : [];
        });
    });
  });
  expect.soft(out, `words squeezed into a narrow column beside a wide button (${where})`).toEqual([]);
}

/**
 * A page's top bar ends where its content starts: a page that fills the screen kept the bar at the
 * top while its content began under it, the logs' search against the bar's lower edge (report
 * dc7a4c). Only before anything is scrolled.
 */
export async function contentUnderBar(page: Page, where: string) {
  const out = await page.evaluate(() =>
    [...document.querySelectorAll('.topbar')]
      .filter((b) => (b as HTMLElement).getClientRects().length && !b.closest('dialog'))
      .flatMap((b) => {
        let next = b.nextElementSibling;
        while (next && (!(next as HTMLElement).getClientRects().length || ['absolute', 'fixed'].includes(getComputedStyle(next).position))) next = next.nextElementSibling;
        if (!next || (b.parentElement && b.parentElement.scrollTop > 0) || scrollY > 0) return [];
        const over = b.getBoundingClientRect().bottom - next.getBoundingClientRect().top;
        return over > 0.5 ? [`${(b.querySelector('h1')?.textContent ?? '').trim().slice(0, 30)}: ${Math.round(over)} px over ${next.tagName.toLowerCase()}.${[...next.classList].filter((c) => !c.startsWith('svelte-')).join('.')}`] : [];
      }),
  );
  expect.soft(out, `a top bar over the start of its page's content (${where})`).toEqual([]);
}

/**
 * A control cut off below (or above) a box that hides what does not fit, with
 * nothing in between that scrolls, cannot be reached at all: the panel's
 * running sessions under a stack on a phone could only be reached by making
 * the panel higher (report ffef5f).
 */
export async function nothingOutOfReach(page: Page, where: string) {
  const out = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, .list-item')]
      // A file input inside the button-label that opens it is reached through that label.
      .filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).opacity !== '0' && !e.matches('label input[type=file]') && !e.closest('dialog:not([open]), [aria-hidden=true], [inert], .cm-editor, .xterm, details:not([open])'))
      .flatMap((e) => {
        const r = e.getBoundingClientRect();
        if (r.height < 4) return [];
        for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
          const oy = getComputedStyle(a).overflowY;
          // A box that scrolls on the way: reachable by scrolling it.
          if ((oy === 'auto' || oy === 'scroll') && a.scrollHeight > a.clientHeight + 1) return [];
          if (oy !== 'hidden' && oy !== 'clip') continue;
          const box = a.getBoundingClientRect();
          // Entirely out of it (a sliding sheet, a folded part): not drawn, not meant to be reached.
          if (r.top >= box.bottom || r.bottom <= box.top) return [];
          const cut = Math.max(r.bottom - box.bottom, box.top - r.top);
          if (cut <= 2) continue;
          const label = (e.getAttribute('aria-label') ?? e.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
          return [`${e.dataset.testid ?? e.tagName.toLowerCase()} "${label}": ${Math.round(cut)} px cut off by ${a.tagName.toLowerCase()}.${[...a.classList].filter((c) => !c.startsWith('svelte-')).join('.')}`];
        }
        return [];
      }),
  );
  expect.soft(out, `controls cut off with nothing that scrolls to them (${where})`).toEqual([]);
}
