import { AxeBuilder } from '@axe-core/playwright';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { CONTROL_ID, flushCoverage } from './fixtures.js';
import { pageOf } from './pages.js';

// Checks for the slips people notice first, shared by the specs that look
// at pages and dialogs. lookAt() runs them all and keeps a screenshot.

// TOUR_DIR: a look at another Burrow (the live one, by hand) keeps its pictures apart from the gate's.
const TOUR = process.env.TOUR_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'test-results', 'tour');
/** Every page and dialog lookAt saw, one per line ("page:hosts", "dialog:host-sheet"). */
export const SEEN = join(TOUR, 'seen.txt');

/** No accessibility violations that axe-core finds (any impact). */
export async function accessible(page: Page, where: string) {
  // A log shows up to 2000 lines of one template: axe over all of them took minutes a pass under
  // load (the many-logs test ran out of time). The last 100 stand for the rest.
  await page.evaluate(() => {
    const lines = [...document.querySelectorAll('[data-testid=log-line]')];
    for (const l of lines.slice(0, -100)) l.setAttribute('data-axe-skip', '');
  });
  const { violations } = await new AxeBuilder({ page }).exclude('[data-axe-skip]').analyze();
  const found = violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} (${(n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 140)})`).join('; ')}`);
  expect.soft(found, `accessibility (${where})`).toEqual([]);
}

/**
 * Titles and subtitles in lists never run together ("Debian192.168.1.10"):
 * two lines in a list, or two columns apart in a row laid out as a table
 * (a grid, on a wide screen).
 */
export async function listsReadable(page: Page, where: string) {
  const glued = await page.locator('.list-item .main').evaluateAll((els) =>
    els
      .map((m) => {
        const title = m.querySelector('.title');
        const sub = [...m.querySelectorAll('.sub')].find((x) => (x as HTMLElement).getClientRects().length);
        if (!title || !sub || !(title as HTMLElement).getClientRects().length) return null;
        const t = title.getBoundingClientRect();
        const s = sub.getBoundingClientRect();
        if (getComputedStyle(m).display === 'grid' && Math.abs(t.top - s.top) < t.height) return t.right + 4 <= s.left ? null : m.textContent?.trim();
        return t.bottom <= s.top + 1 ? null : m.textContent?.trim();
      })
      .filter(Boolean),
  );
  expect.soft(glued, `list items with title and subtitle on one line (${where})`).toEqual([]);
}

/** A row's buttons leave its title room: no title cut off in a sliver of the row. */
export async function titlesRoomy(page: Page, where: string) {
  const squeezed = await page.locator('.list-item .main').evaluateAll((els) =>
    els
      .filter((m) => (m as HTMLElement).getClientRects().length)
      .filter((m) => {
        const title = m.querySelector<HTMLElement>('.title');
        const row = m.closest('.list-item')!;
        return !!title && title.scrollWidth > title.clientWidth + 1 && m.getBoundingClientRect().width < row.getBoundingClientRect().width * 0.45;
      })
      .map((m) => m.querySelector('.title')!.textContent!.trim()),
  );
  expect.soft(squeezed, `titles cut off by the buttons next to them (${where})`).toEqual([]);
}

/** Dropdowns have our arrow, away from the edge (the native one sat against it). */
export async function selectsRoomy(page: Page, where: string) {
  const bad = await page.locator('select').evaluateAll((els) =>
    els
      .filter((e) => (e as HTMLElement).getClientRects().length)
      .filter((e) => {
        const cs = getComputedStyle(e);
        return cs.appearance !== 'none' || parseFloat(cs.paddingRight) < 30;
      })
      .map((e) => e.getAttribute('aria-label') ?? e.id ?? 'select'),
  );
  expect.soft(bad, `dropdowns with the arrow against the edge (${where})`).toEqual([]);
}

/** A name in a bar keeps room to be read ("Deploy" beside it once took it all). */
export async function namesRoomy(page: Page, where: string) {
  const squeezed = await page.locator('h1, [data-testid="editor-title"]').evaluateAll((els) =>
    els
      .filter((e) => (e as HTMLElement).getClientRects().length && e.textContent!.trim())
      .filter((e) => e.getBoundingClientRect().width < Math.min(96, e.scrollWidth))
      .map((e) => `${e.textContent!.trim().slice(0, 40)} (${Math.round(e.getBoundingClientRect().width)} px)`),
  );
  expect.soft(squeezed, `names squeezed out of their bar (${where})`).toEqual([]);
}

/** A dropdown shows its whole choice ("Live | 500 r..." said too little). */
export async function selectsFit(page: Page, where: string) {
  const cut = await page.locator('select').evaluateAll((els) => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    return els
      .filter((e) => (e as HTMLElement).getClientRects().length)
      .filter((e) => {
        const sel = e as HTMLSelectElement;
        const cs = getComputedStyle(sel);
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const text = sel.selectedOptions[0]?.text ?? '';
        return ctx.measureText(text).width > sel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + 1;
      })
      .map((e) => `${e.getAttribute('aria-label') ?? e.id}: ${(e as HTMLSelectElement).selectedOptions[0]?.text}`);
  });
  expect.soft(cut, `dropdowns whose choice is cut off (${where})`).toEqual([]);
}

/** Tick boxes and radio buttons keep their small size (a radio once took a text field's). */
export async function togglesSmall(page: Page, where: string) {
  const big = await page.locator('input[type=checkbox], input[type=radio]').evaluateAll((els) =>
    els
      .filter((e) => (e as HTMLElement).getClientRects().length)
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 30 || r.height > 30;
      })
      .map((e) => `${(e as HTMLInputElement).type} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)} ${e.closest('label')?.textContent?.trim().slice(0, 30) ?? ''}`),
  );
  expect.soft(big, `oversized tick boxes or radio buttons (${where})`).toEqual([]);
}

/** Buttons side by side or stacked in one menu: all with an icon, or none (a menu once had two without). */
export async function iconsConsistent(page: Page, where: string) {
  const mixed = await page.locator('.btn').evaluateAll((els) => {
    const parents = new Set(els.map((e) => e.parentElement!).filter((p) => (p as HTMLElement).getClientRects().length));
    return [...parents]
      .map((p) => [...p.children].filter((c) => c.classList.contains('btn') && (c as HTMLElement).getClientRects().length && c.textContent!.trim()))
      .filter((btns) => btns.length >= 3)
      .filter((btns) => {
        const withIcon = btns.filter((b) => b.querySelector('svg')).length;
        return withIcon > 0 && withIcon < btns.length;
      })
      .map((btns) => btns.filter((b) => !b.querySelector('svg')).map((b) => b.textContent!.trim()).join(', '));
  });
  expect.soft(mixed, `menus where some buttons have an icon and others not (${where})`).toEqual([]);
}

/** Pills and badges side by side keep a gap: the "new" pill once touched the host's. */
export async function pillsSpaced(page: Page, where: string) {
  const touching = await page.locator('.badge, .pill, .chip, .new, .host').evaluateAll((els) => {
    const pills = els.filter((e) => (e as HTMLElement).getClientRects().length && getComputedStyle(e).borderTopWidth !== '0px');
    const out: string[] = [];
    for (const a of pills) {
      for (const b of pills) {
        if (a === b || a.parentElement !== b.parentElement) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const sameLine = Math.abs(ra.top - rb.top) < 4;
        if (sameLine && rb.left >= ra.left && rb.left - ra.right < 3) out.push(`${a.textContent?.trim()} | ${b.textContent?.trim()}`);
      }
    }
    return out;
  });
  expect.soft(touching, `pills touching each other (${where})`).toEqual([]);
}

/** Controls stay inside their card: a dropdown past a card's edge ends up
 * past a small phone's screen (the statistics' period did, in Dutch). */
export async function controlsInCards(page: Page, where: string) {
  const out = await page.locator('.card :is(select, input, button, textarea)').evaluateAll((els) =>
    els
      .filter((e) => (e as HTMLElement).getClientRects().length)
      .filter((e) => {
        const card = e.closest('.card')!;
        const box = card.getBoundingClientRect();
        const cs = getComputedStyle(card);
        const r = e.getBoundingClientRect();
        return r.right > box.right - parseFloat(cs.paddingRight) + 1 || r.left < box.left + parseFloat(cs.paddingLeft) - 1;
      })
      .map((e) => e.getAttribute('aria-label') ?? e.getAttribute('data-testid') ?? e.textContent?.trim() ?? e.tagName),
  );
  expect.soft(out, `controls sticking out of their card (${where})`).toEqual([]);
}

/** A help tip belongs beside its checkbox, not on a line of its own below it. */
export async function helpTipsBeside(page: Page, where: string) {
  const below = await page.locator('label.check + .helptip').evaluateAll((els) =>
    els
      .filter((h) => (h as HTMLElement).getClientRects().length)
      .filter((h) => h.getBoundingClientRect().top >= h.previousElementSibling!.getBoundingClientRect().bottom - 2)
      .map((h) => h.previousElementSibling!.textContent?.trim()),
  );
  expect.soft(below, `help tips below their checkbox (${where})`).toEqual([]);
}

/**
 * Tappable text looks tappable: a button or link that is just coloured text
 * (no border, no background, no icon) is underlined.
 */
export async function textLinksUnderlined(page: Page, where: string) {
  const bare = await page.locator('main button, main a, .page button, .page a, .detail button, .detail a, dialog button, dialog a').evaluateAll((els) =>
    els
      .filter((e) => (e as HTMLElement).getClientRects().length && !e.querySelector('svg') && e.textContent!.trim())
      .filter((e) => {
        const cs = getComputedStyle(e);
        const plain = cs.backgroundColor === 'rgba(0, 0, 0, 0)' && parseFloat(cs.borderTopWidth) === 0 && parseFloat(cs.borderBottomWidth) === 0;
        const coloured = cs.color !== getComputedStyle(document.body).color;
        // Inside a list row, a tab bar or a heading the look says enough.
        const structural = e.closest('.list-item, [role=tablist], nav, h1, h2, h3, .segmented, .chips, .crumbs, [aria-label=Path]');
        return plain && coloured && !structural && !cs.textDecorationLine.includes('underline');
      })
      .map((e) => e.textContent!.trim().slice(0, 30)),
  );
  expect.soft([...new Set(bare)], `tappable text without underline (${where})`).toEqual([]);
}

/** Every help tip opens its note when tapped, and closes again. */
export async function helpTipsWork(page: Page, where: string) {
  // In an open dialog, only its own tips: the page behind it is inert.
  const scope = (await page.locator('dialog[open]').count()) ? page.locator('dialog[open]') : page.locator('body');
  const tips = scope.locator('.helptip button');
  // The tip's own note: a page's notices are notes too (Settings' hints beside a section, 2.3.0).
  const note = page.locator('.helptip [role=note]');
  const n = await tips.count();
  for (let i = 0; i < n; i++) {
    const tip = tips.nth(i);
    if (!(await tip.isVisible())) continue;
    await tip.scrollIntoViewIfNeeded();
    await tip.click();
    await expect.soft(note, `help tip ${i} opens (${where})`).toBeVisible();
    // Drawn over everything: on the terminal page a tip next to the rail fell under it (report 6779f4).
    const covered = await note
      .evaluate((n) => {
        const r = n.getBoundingClientRect();
        return [
          [r.left + 6, r.top + 6],
          [r.left + r.width / 2, r.top + r.height / 2],
          [r.right - 6, r.bottom - 6],
        ].filter(([x, y]) => {
          const e = document.elementFromPoint(x!, y!);
          return !e || !n.contains(e);
        }).length;
      })
      .catch(() => 0);
    expect.soft(covered, `help tip ${i} under something else (${where})`).toBe(0);
    await tip.click();
    await expect.soft(note, `help tip ${i} closes (${where})`).toHaveCount(0);
  }
}

/** Fields side by side (two columns) line up, also when one label wraps. */
export async function fieldsAligned(page: Page, where: string) {
  const off = await page.locator('.grid2').evaluateAll((grids) =>
    grids
      .filter((g) => (g as HTMLElement).getClientRects().length)
      .flatMap((g) => {
        const controls = [...g.querySelectorAll(':scope > label > :is(input, select)')].map((c) => c.getBoundingClientRect());
        const rows = new Map<number, number[]>();
        // Same grid row: controls whose tops are within a label's height.
        for (const r of controls) {
          const key = [...rows.keys()].find((k) => Math.abs(k - r.bottom) < 40) ?? r.bottom;
          rows.set(key, [...(rows.get(key) ?? []), r.bottom]);
        }
        return [...rows.values()].filter((b) => Math.max(...b) - Math.min(...b) > 1).map(() => g.textContent?.trim().slice(0, 40));
      }),
  );
  expect.soft(off, `fields side by side not lined up (${where})`).toEqual([]);
}

/** A help tip in a heading sits on the heading's first line, not below its text. */
export async function headingTipsBeside(page: Page, where: string) {
  const below = await page.locator(':is(h1, h2, h3) > .helptip').evaluateAll((els) =>
    els
      .filter((h) => (h as HTMLElement).getClientRects().length)
      .filter((h) => {
        const heading = h.parentElement!;
        const text = [...heading.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim());
        if (!text) return false;
        const range = document.createRange();
        range.selectNodeContents(text);
        const lines = [...range.getClientRects()];
        const r = h.getBoundingClientRect();
        const mid = (r.top + r.bottom) / 2;
        // Beside the text: its middle within one of the text's lines.
        return !lines.some((l) => mid >= l.top - 4 && mid <= l.bottom + 4);
      })
      .map((h) => h.parentElement!.textContent?.trim()),
  );
  expect.soft(below, `help tips below their heading (${where})`).toEqual([]);
}

/**
 * Less motion asked for (the tests run so): nothing spins or pulses for ever.
 * A spinner kept turning under reduced motion (AUDIT2 UX-06). The terminal's
 * own blinking cursor is xterm's, not ours.
 */
export async function stillWhenAsked(page: Page, where: string) {
  const moving = await page.evaluate(() => {
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) return [];
    return document
      .getAnimations()
      .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity)
      .map((a) => (a.effect as KeyframeEffect | null)?.target as Element | null)
      .filter((el): el is Element => !!el && !el.closest('.xterm'))
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
  });
  expect.soft(moving, `moving for ever although less motion is asked for (${where})`).toEqual([]);
}

/**
 * A button never sits in a row that scrolls sideways where it is out of that row's sight: the star
 * of a folder came after its path, and a long path took it off a phone's screen (report b7caab).
 * Rows of chips, keys and tabs scroll on purpose; their buttons are not icon buttons.
 */
export async function buttonsInSight(page: Page, where: string) {
  const hidden = await page.evaluate(() => {
    const scroller = (e: Element) => {
      for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX;
        if ((ox === 'auto' || ox === 'scroll' || ox === 'hidden') && a.scrollWidth > a.clientWidth + 1) return a;
      }
      return null;
    };
    return [...document.querySelectorAll<HTMLElement>('.icon-btn')]
      .filter((b) => b.getClientRects().length && !b.closest('dialog:not([open]), [aria-hidden=true], .cm-editor, .xterm'))
      .flatMap((b) => {
        const row = scroller(b);
        if (!row) return [];
        const r = b.getBoundingClientRect();
        const box = row.getBoundingClientRect();
        return r.right > box.right + 1 || r.left < box.left - 1 ? [b.getAttribute('aria-label') ?? b.className] : [];
      });
  });
  expect.soft(hidden, `buttons out of sight in a row that scrolls sideways (${where})`).toEqual([]);
  // A folding header's words wider than the header: its arrow went off the screen (report d0da1c).
  const wide = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('details > summary')]
      .filter((e) => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1)
      .map((e) => e.textContent!.trim().slice(0, 60)),
  );
  expect.soft(wide, `folding headers wider than their row (${where})`).toEqual([]);
}

/**
 * A screen's main content (the editor, the terminal, the log: data-main) is never squeezed away,
 * whatever else is open beside it: on a phone held sideways a container's details took the whole
 * page and its log could not be reached (report 5d0b33). At least 30% of the screen, or 140 px.
 */
export async function mainReachable(page: Page, where: string) {
  if (await page.locator('dialog[open]').count()) return;
  const squeezed = await page.evaluate(() => {
    const vh = window.innerHeight;
    return [...document.querySelectorAll<HTMLElement>('[data-main]')]
      .filter((e) => !e.closest('[data-dock]') && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { px: Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)), what: e.dataset.testid ?? e.className };
      })
      .filter((x) => x.px < Math.min(140, vh * 0.3))
      .map((x) => `${x.what}: ${Math.round(x.px)} px`);
  });
  expect.soft(squeezed, `main content squeezed out of reach (${where})`).toEqual([]);
}

/**
 * A screen's main content (the editor, the terminal, the log: data-main)
 * keeps most of the screen; bars, counters and help do not eat it away.
 * Split on purpose (the panel under a workspace: data-split), the two
 * together count; a panel docked over a page is as high as it was made.
 */
export async function mainRoomy(page: Page, where: string, min = 0.65) {
  if (await page.locator('dialog[open]').count()) return;
  const short = await page.evaluate((min) => {
    const vh = window.innerHeight;
    const outer = (e: HTMLElement) => e.closest<HTMLElement>('[data-split]') ?? e;
    return [...new Set([...document.querySelectorAll<HTMLElement>('[data-main]')].filter((e) => !e.closest('[data-dock]')).map(outer))]
      .filter((e) => e.getClientRects().length)
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { share: (Math.min(r.bottom, vh) - Math.max(r.top, 0)) / vh, what: e.dataset.testid ?? e.className };
      })
      .filter((x) => x.share < min)
      .map((x) => `${x.what}: ${Math.round(x.share * 100)}%`);
  }, min);
  expect.soft(short, `main content with too little of the screen (${where})`).toEqual([]);
}

/**
 * The terminal page keeps its bar (the way back, the session tabs) while
 * there is room for it, the keyboard up too: on a foldable's inner screen
 * it went, and with it every way out but the phone's Back (report ce0acd).
 * Only a phone turned on its side with its keyboard up is too low for it.
 */
async function termBarKept(page: Page, where: string) {
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
async function termRowsInside(page: Page, where: string) {
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
  // from the server): a moment for it, then what stays cut is cut (the sizes run, 2026-11-06).
  await page.waitForFunction(`(${measure.toString()})().length === 0`, undefined, { timeout: 3000 }).catch(() => {});
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
async function rowButtonOneLine(page: Page, where: string) {
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
async function buttonLabelsOneLine(page: Page, where: string) {
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
async function rowButtonsSameWidth(page: Page, where: string) {
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
async function tablesFromTablet(page: Page, where: string) {
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
async function logLinesWhole(page: Page, where: string) {
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
async function buttonsInside(page: Page, where: string) {
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
async function besideFieldSameHeight(page: Page, where: string) {
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
async function clampedTextInside(page: Page, where: string) {
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
async function actionRowsOneLine(page: Page, where: string) {
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
async function rowsFill(page: Page, where: string) {
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
async function textBesideButton(page: Page, where: string) {
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

/**
 * A segmented choice's options stay inside it, each on one line: "Zwart
 * (OLED)" broke over two lines past the edge on a 343 px wide phone, and
 * later hung below its box over the colours.
 */
async function segmentsFit(page: Page, where: string) {
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
async function segmentsEven(page: Page, where: string) {
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
async function wordsWhole(page: Page, where: string) {
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
async function centredTogether(page: Page, where: string) {
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
async function cardsApart(page: Page, where: string) {
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
async function buttonsOffLines(page: Page, where: string) {
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
async function boxesApart(page: Page, where: string) {
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
async function textApart(page: Page, where: string) {
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
async function controlsOffEdges(page: Page, where: string) {
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
async function textInsideBorders(page: Page, where: string) {
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
async function widthsEven(page: Page, where: string) {
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

/**
 * Cards and lists stacked in one column are evenly spaced: the host
 * statistics had 12 px between some cards and 24 px between others.
 */
async function gapsEven(page: Page, where: string) {
  const bad = await page.evaluate(() => {
    const scope = document.querySelector('dialog[open]') ?? document.querySelector('main') ?? document.body;
    const out: string[] = [];
    for (const col of [scope, ...scope.querySelectorAll('*')] as HTMLElement[]) {
      // Shown children in order; a gap counts only between two cards next to each other (a heading or tabs between them has room of its own).
      const kids = [...col.children].filter((k) => (k as HTMLElement).getClientRects().length && !['fixed', 'absolute'].includes(getComputedStyle(k).position)) as HTMLElement[];
      const gaps: number[] = [];
      for (let i = 1; i < kids.length; i++) {
        const [a, b] = [kids[i - 1]!, kids[i]!];
        if (!a.matches('.card, .list') || !b.matches('.card, .list')) continue;
        const [ra, rb] = [a.getBoundingClientRect(), b.getBoundingClientRect()];
        // One column: below it, on the same left edge.
        if (rb.top < ra.bottom - 1 || Math.abs(ra.left - rb.left) > 2) continue;
        gaps.push(Math.round(rb.top - ra.bottom));
      }
      if (gaps.length >= 2 && Math.max(...gaps) - Math.min(...gaps) > 4) out.push(`${col.tagName.toLowerCase()}.${[...col.classList].slice(0, 2).join('.')}: ${gaps.join(', ')} px`);
    }
    return out;
  });
  expect.soft(bad, `cards in one column unevenly spaced (${where})`).toEqual([]);
}

/** A page's title bar reaches both edges of the screen (beside the rail): on a tablet it stopped 20 px short. */
async function barsEdgeToEdge(page: Page, where: string) {
  const bad = await page.evaluate(() => {
    const rail = document.querySelector('.bottomnav') as HTMLElement | null;
    const left = rail && getComputedStyle(rail).flexDirection === 'column' ? rail.getBoundingClientRect().right : 0;
    return [...document.querySelectorAll('.topbar, .term-top, .appbar')]
      .filter((b) => (b as HTMLElement).getClientRects().length && !b.closest('dialog'))
      .flatMap((b) => {
        const r = b.getBoundingClientRect();
        return r.left > left + 1 || r.right < document.documentElement.clientWidth - 1 ? [`${b.className.split(' ')[0]} ${Math.round(r.left)}..${Math.round(r.right)} of ${Math.round(left)}..${document.documentElement.clientWidth}`] : [];
      });
  });
  expect.soft(bad, `title bar short of the screen's edges (${where})`).toEqual([]);
}

/**
 * A floating pill or button (the busy pill, the add button) keeps its words
 * on one line inside itself: in the narrow rail beside the workspace,
 * "Transfers done" broke over the rail's edge.
 */
async function floatersOneLine(page: Page, where: string) {
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll('button, a')]
      .filter((b) => (b as HTMLElement).getClientRects().length && getComputedStyle(b).position === 'fixed' && (b as HTMLElement).innerText.trim())
      .flatMap((b) => {
        const el = b as HTMLElement;
        const line = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.3;
        const inner = el.clientHeight - parseFloat(getComputedStyle(el).paddingTop) - parseFloat(getComputedStyle(el).paddingBottom);
        return inner > line * 1.6 || el.scrollWidth > el.clientWidth + 1 ? [`"${el.innerText.trim()}" ${el.clientWidth}x${el.clientHeight}px`] : [];
      }),
  );
  expect.soft(bad, `floating button's words not on one line inside it (${where})`).toEqual([]);
}

/**
 * In a row of things centred on one line, nothing towers over the rest: the
 * container page put an update's output (a tall, narrow column) on the line
 * of its state, which then floated half way down (report 09ddbf).
 */
async function rowsBalanced(page: Page, where: string) {
  const bad = await page.evaluate(() => {
    const scope = document.querySelector('dialog[open]') ?? document.querySelector('main') ?? document.body;
    const out: string[] = [];
    for (const row of [scope, ...scope.querySelectorAll('*')] as HTMLElement[]) {
      const cs = getComputedStyle(row);
      if (!cs.display.includes('flex') || cs.flexDirection.startsWith('column') || cs.alignItems !== 'center') continue;
      if (row.closest('.xterm, .cm-editor, nav, .topbar')) continue;
      const kids = [...row.children].filter((k) => (k as HTMLElement).checkVisibility() && !['fixed', 'absolute'].includes(getComputedStyle(k).position)) as HTMLElement[];
      const rs = kids.map((k) => k.getBoundingClientRect());
      for (let i = 0; i < kids.length; i++) {
        if (rs[i]!.height < 160) continue;
        // On its line: the small ones beside it whose middle sits far below its top.
        for (let j = 0; j < kids.length; j++) {
          if (i === j || rs[j]!.height > 48) continue;
          const sameLine = rs[j]!.top < rs[i]!.bottom && rs[j]!.bottom > rs[i]!.top;
          if (sameLine && rs[j]!.top - rs[i]!.top > 40) out.push(`${kids[i]!.tagName.toLowerCase()}.${[...kids[i]!.classList].slice(0, 2).join('.')} ${Math.round(rs[i]!.height)}px tall beside "${(kids[j]!.textContent ?? '').trim().slice(0, 24)}"`);
        }
      }
    }
    return [...new Set(out)].slice(0, 10);
  });
  expect.soft(bad, `a tall block beside small ones in one centred row (${where})`).toEqual([]);
}

/**
 * A field and the buttons beside it on one line are one height: the
 * WireGuard list's search box stood taller than its All and None.
 */
async function controlsEven(page: Page, where: string) {
  const uneven = await page.evaluate(() =>
    [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]), select')]
      .filter((f) => (f as HTMLElement).getClientRects().length && !f.closest('.keybar, .xterm'))
      .flatMap((f) => {
        const row = f.parentElement!;
        const cs = getComputedStyle(row);
        if (!cs.display.includes('flex') || cs.flexDirection !== 'row') return [];
        const fr = f.getBoundingClientRect();
        const beside = [...row.children].filter((c) => c.matches('.btn') && (c as HTMLElement).getClientRects().length) as HTMLElement[];
        return beside
          .filter((b) => Math.abs(b.getBoundingClientRect().top - fr.top) < fr.height && Math.abs(b.getBoundingClientRect().height - fr.height) > 2)
          .map((b) => `${(f as HTMLInputElement).placeholder || f.getAttribute('aria-label') || f.tagName} ${Math.round(fr.height)}px, "${b.textContent!.trim()}" ${Math.round(b.getBoundingClientRect().height)}px`);
      }),
  );
  // Fields side by side are one height too: the containers' search box stood lower than the filter beside it (report 5fee2b).
  const fields = await page.evaluate(() =>
    [...document.querySelectorAll('select')]
      .filter((f) => (f as HTMLElement).checkVisibility() && !f.closest('.keybar, .xterm'))
      .flatMap((f) => {
        const row = f.parentElement!;
        const cs = getComputedStyle(row);
        if (!cs.display.includes('flex') || cs.flexDirection !== 'row') return [];
        const fr = f.getBoundingClientRect();
        const beside = [...row.children].map((c) => (c.matches('input') ? (c as HTMLInputElement) : c.querySelector<HTMLInputElement>(':scope > input'))).filter((c): c is HTMLInputElement => !!c && c.checkVisibility() && !['checkbox', 'radio', 'range', 'hidden'].includes(c.type));
        return beside
          .filter((b) => Math.abs(b.getBoundingClientRect().top - fr.top) < fr.height && Math.abs(b.getBoundingClientRect().height - fr.height) > 2)
          .map((b) => `${b.placeholder || b.getAttribute('aria-label') || 'input'} ${Math.round(b.getBoundingClientRect().height)}px, ${f.getAttribute('aria-label') ?? 'select'} ${Math.round(fr.height)}px`);
      }),
  );
  expect.soft(uneven.concat(fields), `a field and the buttons or fields beside it of different heights (${where})`).toEqual([]);
}

/**
 * A status dot with a state (running, failed, up, ...) is shown at full
 * strength: a faint one reads as "unknown". The redesign's own dot style
 * once made every stack's and report's dots half see-through.
 */
async function dotsSolid(page: Page, where: string) {
  const faint = await page.evaluate(() =>
    [...document.querySelectorAll('.dot')]
      .filter((d) => (d as HTMLElement).getClientRects().length && d.classList.length > 1)
      .flatMap((d) => {
        let o = 1;
        for (let e: Element | null = d; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
        return o < 0.99 ? [`${d.className} (${o.toFixed(2)})`] : [];
      }),
  );
  expect.soft(faint, `status dots shown faint (${where})`).toEqual([]);
}

/**
 * Something that floats (a pill, a bar, a toast) leaves a page's title bar
 * and its tabs free: the activity pill once sat on the tab row of every
 * page on a computer.
 */
async function floatersClear(page: Page, where: string) {
  const over = await page.evaluate(() => {
    const bars = [...document.querySelectorAll('.topbar, [role=tablist]')].filter((b) => (b as HTMLElement).getClientRects().length && !b.closest('dialog'));
    const hit = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    return [...document.querySelectorAll('body *')]
      .filter((e) => {
        const cs = getComputedStyle(e);
        return cs.position === 'fixed' && (e as HTMLElement).getClientRects().length && cs.visibility !== 'hidden' && !e.closest('dialog, nav, .topbar, [role=tablist]') && !e.querySelector('.topbar, [role=tablist]') && e.getBoundingClientRect().width < window.innerWidth * 0.9;
      })
      .flatMap((e) => {
        const r = e.getBoundingClientRect();
        return bars.filter((b) => hit(r, b.getBoundingClientRect())).map((b) => `"${(e.textContent ?? '').trim().slice(0, 30)}" over ${b.matches('.topbar') ? 'the title bar' : 'the tabs'}`);
      });
  });
  expect.soft(over, `floating over the title bar or tabs (${where})`).toEqual([]);
}

/**
 * The busy list and its pill leave a page's foot bar free (the clipboard's "Paste here", the bulk
 * actions): on a computer the list lay over the clipboard bar's words, and on a phone the pill
 * over them (2026-11-06).
 */
async function footBarsFree(page: Page, where: string) {
  const over = await page.evaluate(() => {
    const shown = (e: Element) => (e as HTMLElement).getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const hit = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const bars = [...document.querySelectorAll('.actionbar, .bulkbar')].filter(shown);
    return [...document.querySelectorAll('[data-testid=transfers], [data-testid=transfers-pill]')].filter(shown).flatMap((f) =>
      bars.filter((b) => hit(f.getBoundingClientRect(), b.getBoundingClientRect())).map((b) => `${f.getAttribute('data-testid')} over "${(b.textContent ?? '').trim().slice(0, 30)}"`),
    );
  });
  expect.soft(over, `the busy list over a foot bar (${where})`).toEqual([]);
}

/**
 * A button's words stand out from its own background. Axe leaves a case it
 * cannot work out unreported: the host form's Save once took a card's
 * white background under its white words, an empty box.
 */
async function buttonsLegible(page: Page, where: string) {
  const faint = await page.evaluate(() => {
    // rgb(a)(0-255) or color(srgb 0-1 ...), as a color-mix() comes back (the accent-tinted neutrals).
    const rgba = (c: string) => {
      const n = (c.match(/[\d.]+/g) ?? []).map(Number);
      return c.startsWith('color(') ? n.map((v, i) => (i < 3 ? v * 255 : v)) : n;
    };
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    return [...document.querySelectorAll('button, .btn')]
      .filter((b) => (b as HTMLElement).getClientRects().length && (b.textContent ?? '').trim() && !(b as HTMLButtonElement).disabled)
      .flatMap((b) => {
        const cs = getComputedStyle(b);
        const bg = rgba(cs.backgroundColor);
        const fg = rgba(cs.color);
        if (bg.length < 3 || (bg.length > 3 && bg[3]! < 1) || cs.backgroundImage !== 'none') return [];
        const [a, z] = [lum(fg), lum(bg)].sort((x, y) => y - x);
        const ratio = (a! + 0.05) / (z! + 0.05);
        return ratio < 3 ? [`"${(b.textContent ?? '').trim().slice(0, 30)}" ${ratio.toFixed(1)}:1`] : [];
      });
  });
  expect.soft(faint, `buttons whose words do not stand out from their background (${where})`).toEqual([]);
}

/**
 * The chosen one of a segmented choice stands out from the others: in the
 * black theme every surface was black and "Black (OLED)" looked unchosen.
 */
async function chosenVisible(page: Page, where: string) {
  const flat = await page.evaluate(() =>
    [...document.querySelectorAll('.segmented [aria-checked="true"]')]
      .filter((b) => (b as HTMLElement).getClientRects().length)
      .flatMap((b) => {
        const other = [...(b.parentElement?.querySelectorAll('[aria-checked="false"]') ?? [])][0];
        if (!other) return [];
        const a = getComputedStyle(b);
        const o = getComputedStyle(other);
        const rgb = (c: string) => {
          const n = (c.match(/[\d.]+/g) ?? []).map(Number);
          return c.startsWith('color(') ? n.map((v, i) => (i < 3 ? Math.round(v * 255) : v)) : n;
        };
        // A shadow shows only in a colour apart from what is behind it (black on black does not).
        const back = rgb(getComputedStyle(b.parentElement!).backgroundColor);
        const shadow = rgb(/rgba?\([^)]*\)/.exec(a.boxShadow)?.[0] ?? '');
        const shadowSeen = a.boxShadow !== 'none' && shadow.length >= 3 && (shadow[3] ?? 1) > 0.05 && shadow.slice(0, 3).some((v, i) => Math.abs(v - (back[i] ?? 0)) > 24);
        // A see-through background is the one behind it.
        const fill = (c: string) => {
          const v = rgb(c);
          return v.length < 3 || v[3] === 0 ? back.slice(0, 3).join(',') : v.slice(0, 3).join(',');
        };
        // A border counts only where there is one.
        const edge = (c: CSSStyleDeclaration) => (parseFloat(c.borderTopWidth) > 0 ? c.borderTopColor : 'none');
        return fill(a.backgroundColor) === fill(o.backgroundColor) && !shadowSeen && edge(a) === edge(o) ? [(b.textContent ?? '').trim()] : [];
      }),
  );
  expect.soft(flat, `a chosen segment that looks like the others (${where})`).toEqual([]);
}

/** A keyboard shortcut means nothing on a phone: "(Ctrl+Shift+F)" wrapped the menu's search button there. */
async function noKeysOnTouch(page: Page, where: string) {
  const shown = await page.evaluate(() =>
    window.innerWidth < 900 ? [...document.querySelectorAll('.kbd-hint')].filter((e) => (e as HTMLElement).getClientRects().length).map((e) => e.textContent!.trim()) : [],
  );
  expect.soft(shown, `keyboard shortcuts shown on a phone (${where})`).toEqual([]);
}

/** A message says itself once: never a stack of the same toast. */
export async function toastsOnce(page: Page, where: string) {
  const texts = await page.locator('[data-testid=toasts] .toast').allTextContents();
  const twice = texts.filter((x, i) => texts.indexOf(x) !== i);
  expect.soft(twice, `the same toast more than once (${where})`).toEqual([]);
}

export async function layoutForScreen(page: Page, where: string) {
  const vw = page.viewportSize()!;
  // No navigation at all (sign-in, setup): nothing to check there.
  const nav = (await page.locator('nav.bottomnav').count()) ? await page.locator('nav.bottomnav').boundingBox() : null;
  // The rail from a tablet up (720 px, decision 27), a bar below on a phone.
  if (nav && vw.width >= 720) expect.soft(nav.height > nav.width && nav.x <= 1, `navigation as a rail on the left (${where})`).toBe(true);
  if (nav && vw.width < 720) expect.soft(nav.width > nav.height, `navigation as a bar below on a phone (${where})`).toBe(true);
  // Beside the rail, the page's column is centred in the room that is left, not in the window.
  if (nav && vw.width >= 720 && (await page.locator('.page').count())) {
    const col = (await page.locator('.page').first().boundingBox())!;
    const left = col.x - (nav.x + nav.width);
    const right = vw.width - (col.x + col.width);
    expect.soft(left >= 0 && Math.abs(left - right) <= 2, `page column centred beside the rail: ${Math.round(left)}px left, ${Math.round(right)}px right (${where})`).toBe(true);
  }
  // And what is on the page centred in it, not left with the room at the right (decision 26, UIB-06: 1100 px empty at 2560).
  if (vw.width >= 900) {
    const off = await page.evaluate(() => {
      const p = document.querySelector<HTMLElement>('.page');
      const c = p && [...p.children].find((e) => !e.matches('.topbar, .full-bleed, [role=tablist], .tabs') && (e as HTMLElement).checkVisibility() && getComputedStyle(e).position !== 'fixed');
      if (!p || !c) return null;
      const cs = getComputedStyle(p);
      const pr = p.getBoundingClientRect();
      const r = c.getBoundingClientRect();
      const inner = { left: pr.left + parseFloat(cs.paddingLeft), right: pr.right - parseFloat(cs.paddingRight) };
      return inner.right - inner.left - r.width > 8 ? { left: Math.round(r.left - inner.left), right: Math.round(inner.right - r.right) } : null;
    });
    if (off) expect.soft(Math.abs(off.left - off.right) <= 2, `content centred on the page: ${off.left}px left, ${off.right}px right (${where})`).toBe(true);
  }
  // A computer has Esc, Ctrl and the arrows: no key bar for a finger there.
  // (A touch screen that wide is a tablet on its side: its keys are a finger's.)
  if (vw.width >= 900 && !(await page.evaluate(() => matchMedia('(pointer: coarse)').matches))) expect.soft(await page.locator('.keybar:visible, [data-testid=editor-keys]:visible').count(), `a key bar on a computer (${where})`).toBe(0);
  const pills = await page.locator('.topbar > .badge:visible, .topbar > .chip:visible').allTextContents();
  expect.soft(pills, `pills in the top bar; the page's context goes under its title (${where})`).toEqual([]);
}

/** Pills and badges are whole: never cut off by a title that ends in "...". */
export async function pillsWhole(page: Page, where: string) {
  const cut = await page.locator('.badge, .chip, .new, .host, .count, [class*="pill"]').evaluateAll((els) =>
    els
      .filter((e) => (e as HTMLElement).getClientRects().length)
      .filter((e) => {
        const r = e.getBoundingClientRect();
        for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (cs.overflowX !== 'hidden' && cs.overflowX !== 'clip') continue;
          const b = a.getBoundingClientRect();
          if (r.right > b.right + 1 || r.left < b.left - 1) return true;
        }
        return false;
      })
      .map((e) => e.textContent!.trim()),
  );
  expect.soft(cut, `pills or badges cut off (${where})`).toEqual([]);
}

/**
 * On a phone the page's own bars (tabs, search, status lines) leave the
 * content most of the screen: from under the top bar to the first list,
 * card or main area at most `max` of the screen's height.
 */
export async function chromeCompact(page: Page, where: string, max = 0.22) {
  const vw = page.viewportSize()!;
  if (vw.width > 500 || (await page.locator('dialog[open]').count())) return;
  const zone = await page.evaluate(() => {
    const top = document.querySelector('.topbar, header')?.getBoundingClientRect().bottom ?? 0;
    const first = [...document.querySelectorAll<HTMLElement>('.page .list, .page .card, .page .empty, [data-main], [data-content], .page .tile-wrap, .page table')].find((e) => e.getClientRects().length && e.getBoundingClientRect().height > 20);
    return first ? (first.getBoundingClientRect().top + window.scrollY - top) / window.innerHeight : 0;
  });
  expect.soft(zone, `bars above the content take ${Math.round(zone * 100)}% of the screen (${where})`).toBeLessThanOrEqual(max);
}

/** Buttons side by side: one line of text each, the same height. */
export async function rowButtonsEven(page: Page, where: string) {
  // Every row of buttons (a flex row with two or more), not only .row.
  const uneven = await page.evaluate(() =>
    [...new Set([...document.querySelectorAll('.btn')].map((b) => b.parentElement!))]
      .filter((r) => (r as HTMLElement).getClientRects().length && !r.closest('.jump, .keys, .keybar'))
      .filter((r) => {
        const cs = getComputedStyle(r);
        return cs.display.includes('flex') && cs.flexDirection === 'row';
      })
      .flatMap((r) => {
        const btns = [...r.children].filter((c) => c.classList.contains('btn') && (c as HTMLElement).getClientRects().length) as HTMLElement[];
        if (btns.length < 2) return [];
        // One of them on a line of its own: they did not fit side by side.
        const tops = new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top / 8)));
        // Unless each then fills its own line: a dialog's footer stacked on a small phone, as a column.
        const inner = r.clientWidth - parseFloat(getComputedStyle(r).paddingLeft) - parseFloat(getComputedStyle(r).paddingRight);
        const stacked = tops.size === btns.length && btns.every((b) => b.getBoundingClientRect().width >= inner - 2);
        if (tops.size > 1 && !stacked) return [`${btns.map((b) => b.textContent!.trim()).join(' | ')} (wrapped)`];
        if (stacked) return [];
        const hs = btns.map((b) => Math.round(b.getBoundingClientRect().height));
        // Lines of a label: the distinct tops of its text's boxes.
        const lines = (b: HTMLElement) => {
          const tops = new Set<number>();
          const walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            if (!n.textContent!.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(n);
            for (const x of range.getClientRects()) if (x.width > 1) tops.add(Math.round(x.top / 4));
          }
          return tops.size;
        };
        const wrapped = btns.filter((b) => lines(b) > 1);
        return Math.max(...hs) - Math.min(...hs) > 1 || wrapped.length ? [btns.map((b) => b.textContent!.trim()).join(' | ')] : [];
      }),
  );
  expect.soft(uneven, `buttons side by side of different heights, or a label on two lines (${where})`).toEqual([]);
}

/**
 * Rows of a list apart: a line between each and the next (report 4af102: a reset of the row's own
 * border took the line away in every list); an empty-state line with no more room around its words
 * than they take themselves, at most 48 px (reports 812166, 232696: half a phone's screen).
 */
export async function listsApart(page: Page, where: string) {
  const found = await page.evaluate(() => {
    const out: string[] = [];
    // Tiles (a folder as a grid) stand apart by the room between them, no line.
    for (const l of document.querySelectorAll<HTMLElement>('.list:not(.grid)')) {
      if (!l.getClientRects().length) continue;
      const rows = [...l.children].filter((c) => (c as HTMLElement).getClientRects().length && (c as HTMLElement).getBoundingClientRect().height > 20) as HTMLElement[];
      for (const r of rows.slice(1)) if (parseFloat(getComputedStyle(r).borderTopWidth) < 1 && r.previousElementSibling === rows[rows.indexOf(r) - 1]) out.push(`no line above: ${r.textContent!.trim().slice(0, 40)}`);
    }
    for (const e of document.querySelectorAll<HTMLElement>('.empty')) {
      if (!e.getClientRects().length || e.closest('dialog:not([open])')) continue;
      const range = document.createRange();
      range.selectNodeContents(e);
      const words = range.getBoundingClientRect().height;
      const room = e.getBoundingClientRect().height - words;
      if (words > 0 && room > Math.max(words, 48) + 1) out.push(`empty state with ${Math.round(room)} px around ${Math.round(words)} px of words: ${e.textContent!.trim().slice(0, 40)}`);
    }
    return out;
  });
  expect.soft(found, `lists without lines between rows, or empty states too tall (${where})`).toEqual([]);
}

/**
 * Records apart too where they are not a .list: a plain list (no bullets) of items of two lines or
 * more has a line between them (reports 5d1b13, 7e91ba: Burrow's own warnings and the AI usage ran
 * into one block of text).
 */
export async function recordsApart(page: Page, where: string) {
  const found = await page.evaluate(() => {
    const out: string[] = [];
    for (const l of document.querySelectorAll<HTMLElement>('ul, ol')) {
      // A listing in mono, or a list inside one item (an update's images, a process's files): parts of one record.
      if (!l.getClientRects().length || l.closest('dialog:not([open]), .list, .xterm, .cm-editor, .mono') || l.parentElement?.closest('li') || getComputedStyle(l).listStyleType !== 'none') continue;
      const items = [...l.children].filter((c) => c.tagName === 'LI' && (c as HTMLElement).getClientRects().length) as HTMLElement[];
      if (items.length < 2) continue;
      const line = parseFloat(getComputedStyle(items[0]!).lineHeight) || 20;
      if (!items.some((i) => i.getBoundingClientRect().height >= line * 1.8)) continue;
      const apart = (a: HTMLElement, b: HTMLElement) => parseFloat(getComputedStyle(b).borderTopWidth) >= 1 || parseFloat(getComputedStyle(a).borderBottomWidth) >= 1;
      for (let i = 1; i < items.length; i++) if (!apart(items[i - 1]!, items[i]!)) { out.push(`no line above: ${items[i]!.textContent!.trim().slice(0, 40)}`); break; }
    }
    return out;
  });
  expect.soft(found, `items of two lines or more without a line between them (${where})`).toEqual([]);
}

/**
 * A row's buttons beside its words, never on a line of their own under them (reports 3aa76b,
 * edfcf1, e6fc13: Test, edit and delete under a channel, a role, folders and delete under a user).
 * More than fits goes behind the row's menu (three dots).
 */
export async function rowActionsBeside(page: Page, where: string) {
  const found = await page.evaluate(() => {
    const out: string[] = [];
    const controls = 'button, select, a.btn';
    for (const r of document.querySelectorAll<HTMLElement>('.list > *')) {
      if (!r.getClientRects().length || r.closest('dialog:not([open])') || r.matches(controls)) continue;
      // A row that holds a form (fields to fill in) is a form, not a row.
      if (r.querySelector('input:not([type=checkbox]):not([type=radio]), textarea')) continue;
      // A button as wide as most of the row is its words to tap (an alert's last lines), not an action beside them.
      const own = [...r.querySelectorAll<HTMLElement>(controls)].filter((c) => c.getClientRects().length && c.getBoundingClientRect().width > 0 && c.getBoundingClientRect().width < r.clientWidth * 0.6);
      if (!own.length) continue;
      let bottom = 0;
      const walk = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!n.textContent!.trim() || n.parentElement!.closest(controls)) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const x of range.getClientRects()) if (x.width > 1) bottom = Math.max(bottom, x.bottom);
      }
      if (!bottom) continue;
      const top = Math.min(...own.map((c) => c.getBoundingClientRect().top));
      if (top >= bottom - 1) out.push(`${own.map((c) => c.textContent!.trim() || c.getAttribute('aria-label')).join(' | ')} under: ${r.textContent!.trim().slice(0, 40)}`);
    }
    return out;
  });
  expect.soft(found, `a row's buttons on a line of their own under its words (${where})`).toEqual([]);
}

/** A button's icon at its own size: squeezed by a long label it shrank to a dot (report cb6da8). */
export async function iconsWhole(page: Page, where: string) {
  const squeezed = await page.evaluate(() =>
    [...document.querySelectorAll<SVGSVGElement>('.btn svg[width], .icon-btn svg[width], .chip svg[width]')]
      .filter((s) => s.getClientRects().length && !s.closest('[hidden]'))
      // Squeezed: wider when it may not shrink (a size the CSS gives it on purpose stays as it is).
      .filter((s) => {
        const was = s.getBoundingClientRect().width;
        const before = s.style.flexShrink;
        s.style.flexShrink = '0';
        const whole = s.getBoundingClientRect().width;
        s.style.flexShrink = before;
        return whole - was > 1;
      })
      .map((s) => s.closest('.btn, .icon-btn, .chip')!.textContent!.trim() || s.closest('.btn, .icon-btn, .chip')!.getAttribute('aria-label') || '?'),
  );
  expect.soft(squeezed, `icons squeezed smaller in their button (${where})`).toEqual([]);
}

/**
 * Parts side by side read as one page: headings next to each other stand level (report dc0352: the
 * second column's stood 19 px higher, against the search), and the parts of a page laid out in
 * columns are each one column wide, a big one too (report 2018c4).
 */
export async function columnsEven(page: Page, where: string) {
  const found = await page.evaluate(() => {
    const out: string[] = [];
    const heads = [...document.querySelectorAll<HTMLElement>('main h2, .page h2')].filter((h) => h.getClientRects().length && !h.closest('dialog, [role=dialog]'));
    // Each heading with the top of its card: cards that start level have their titles level; cards
    // that start apart (one column ran on further) are not a row, however close their titles come.
    // Where a title's words are, not its box: a title in a taller row has them in the middle.
    const words = (h: HTMLElement) => {
      const r = document.createRange();
      r.selectNodeContents(h);
      return r.getBoundingClientRect();
    };
    const boxes = heads.map((h) => ({ h, r: words(h), card: h.closest('.card')?.getBoundingClientRect().top }));
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b || b.r.left <= a.r.right) continue;
        if (a.card !== undefined && b.card !== undefined && Math.abs(a.card - b.card) > 2) continue;
        const dy = Math.abs(a.r.top - b.r.top);
        if (dy > 1.5 && dy < 30) out.push(`${a.h.textContent!.trim()} | ${b.h.textContent!.trim()} (${Math.round(dy)} px apart)`);
      }
    }
    for (const cols of document.querySelectorAll<HTMLElement>('.page > .cols')) {
      if ((parseInt(getComputedStyle(cols).columnCount) || 1) < 2) continue;
      const parts = [...cols.children].filter((c) => (c as HTMLElement).getClientRects().length && c.getBoundingClientRect().height > 0) as HTMLElement[];
      const widths = parts.map((p) => Math.round(p.getBoundingClientRect().width));
      if (widths.length > 1 && Math.max(...widths) - Math.min(...widths) > 2) out.push(`parts of ${widths.join(', ')} px`);
    }
    return out;
  });
  expect.soft(found, `parts side by side not level, or not each one column (${where})`).toEqual([]);
}

/**
 * A card's title sits as far from the card's top as the others on the page: the Guests title sat
 * 20 px lower than the ones beside it, its row of buttons taller (2.3.0 gate, found by eye).
 * Titles that are a card's first part, alone or beside its buttons; the most common offset is the
 * page's.
 */
export async function cardTitlesLevel(page: Page, where: string) {
  const off = await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('.card')]
      .filter((c) => c.getClientRects().length && !c.closest('dialog, [role=dialog]'))
      .map((c) => {
        const first = c.firstElementChild as HTMLElement | null;
        const h = first?.matches('h2') ? first : first?.querySelector<HTMLElement>(':scope > h2');
        if (!h) return null;
        // Where its words are, not its box: a title in a taller row has them in the middle.
        const words = document.createRange();
        words.selectNodeContents(h);
        return { name: h.textContent!.trim().slice(0, 30), dy: Math.round(words.getBoundingClientRect().top - c.getBoundingClientRect().top) };
      })
      .filter((x) => x !== null);
    const count = new Map<number, number>();
    for (const r of rows) count.set(r.dy, (count.get(r.dy) ?? 0) + 1);
    const usual = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
    return rows.filter((r) => Math.abs(r.dy - usual) > 2).map((r) => `${r.name}: ${r.dy} px, not ${usual}`);
  });
  expect.soft(off, `card titles at another height in their card (${where})`).toEqual([]);
}

/**
 * What a file, a terminal or a log shows is marked private, so a problem report's picture covers it
 * unless the person ticks it (report 50a6f6: a whole .env readable in a report's picture).
 */
export async function privateMarked(page: Page, where: string) {
  const bare = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.cm-editor, .xterm, [role=log], .md-preview')]
      .filter((el) => el.getClientRects().length && !el.closest('[data-private]') && !el.closest('[data-bug-ui]'))
      .map((el) => el.className.split(' ')[0] || el.getAttribute('role') || el.tagName),
  );
  expect.soft(bare, `contents not covered in a report's picture (${where})`).toEqual([]);
}

/**
 * One scroll bar on a page that scrolls: a part that scrolls up and down on
 * its own beside it is a second one to find and aim at (report 9abc2b: the
 * settings' list cut at the window's height, scrolling inside). What shows a
 * file, a terminal or a log (marked private), a text box and a dialog's own
 * body keep theirs.
 */
export async function oneScroll(page: Page, where: string) {
  const inner = await page.evaluate(() => {
    const doc = document.scrollingElement!;
    if (doc.scrollHeight <= doc.clientHeight + 1 || document.querySelector('dialog[open]')) return [];
    return [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => {
        const cs = getComputedStyle(el);
        if (!/(auto|scroll)/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 1 || !el.getClientRects().length) return false;
        // The panel docked over the page is a pane of its own: what does not fit in it scrolls there (report ffef5f).
        return !el.closest('[data-private], textarea, select, [role=listbox], [role=log], pre, .xterm, [data-dock]') && !el.querySelector('[data-private]');
      })
      .map((el) => el.dataset.testid ?? (el.className.split(' ')[0] || el.tagName.toLowerCase()));
  });
  expect.soft(inner, `a second scroll beside the page's (${where})`).toEqual([]);
}

/** The terminal and logs panel under a workspace or a stack sits at the bottom of its column, with no room under it (2.3.1 tour). */
export async function panelAtBottom(page: Page, where: string) {
  const gap = await page.locator('[data-testid=panel]:visible').evaluateAll((ps) => ps.map((p) => Math.round(p.parentElement!.getBoundingClientRect().bottom - p.getBoundingClientRect().bottom)).filter((g) => g > 1));
  expect.soft(gap, `room under the panel (${where})`).toEqual([]);
}

/** A page's help tip sits by its title, not at the far end of the top bar. */
export async function topbarTipsBeside(page: Page, where: string) {
  const far = await page.locator('.topbar > .helptip').evaluateAll((els) => els.filter((e) => (e as HTMLElement).getClientRects().length).map((e) => e.closest('.topbar')!.querySelector('h1')?.textContent?.trim() ?? '?'));
  expect.soft(far, `help tips away from the page title (${where})`).toEqual([]);
}

/**
 * Text for people: dates one way (the month in words, 24 hours; never
 * 10/5/26 or 8:00 PM) and no internal names (@temperature).
 */
export async function wordsForPeople(page: Page, where: string) {
  const found = await page.evaluate(() => {
    const out: string[] = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!el || !el.getClientRects().length || el.closest('pre, code, .mono, .xterm, .cm-editor, [data-testid=log], textarea, input')) continue;
      const text = n.textContent ?? '';
      // And no internal keys ("auth.login", "terminal.open" in the audit log, UIA-07): a file name is not one.
      const m = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}:\d{2}(:\d{2})?\s?(AM|PM)\b|(^|\s)@(temperature|disk|smart)\b|(^|\s)(account|ai|alerts?|apps?|auth|backup|bugreport|burrow|channel|container|device|docker|file|git|group|history|hosts?|import|invite|key|known_host|logfile|push|pve|recording|report|session|settings|setup|snippet|stack|terminal|updates|user|workspace)\.(?!(ya?ml|json|conf|service|socket|timer|mount|md|txt|sh|log|env|toml|ini|py|js|ts|html|css|d|pdf|allow|deny|png|jpe?g|gif|zip|tar|gz|bak|old|orig|lock|pid|db|sqlite|cfg|xml|csv|bin)\b)[a-z]+(_[a-z]+)*(\s|$)/.exec(text);
      if (m) out.push(text.trim().slice(0, 80));
    }
    return out;
  });
  expect.soft(found, `dates in another style, or internal names (${where})`).toEqual([]);
}

/**
 * Parts of a line set apart by " | " have a space on both sides: "Debian
 * |verloren bij herstart" (report 0b970e, a space lost at an {#if}).
 * Logs, code and terminals keep their own text.
 */
export async function separatorsSpaced(page: Page, where: string) {
  const bad = await page.evaluate(() => {
    const out: string[] = [];
    const seen = new Set<Element>();
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.textContent?.includes('|')) continue;
      const el = n.parentElement;
      if (!el || el.closest('pre, code, .mono, .xterm, .cm-editor, [data-testid=log], .log, textarea, input, dialog:not([open])')) continue;
      const box = el.closest('.sub, .title, p, span, li, td, label, button, h1, h2, h3') ?? el;
      if (seen.has(box) || !box.getClientRects().length) continue;
      seen.add(box);
      const line = (box.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (/[^\s|]\|[^|]|[^|]\|[^\s|]/.test(line)) out.push(line.slice(0, 80));
      // Two parts side by side that start with the same word say it twice ("draait | draait 22u", report 97e99b).
      // A word, not a name's first part ("test-sshd | test-sshd2" are two hosts).
      const firsts = line.split(' | ').map((p) => (/^[\p{L}]{3,}(?![\w-])/u.exec(p.trim())?.[0] ?? '').toLowerCase());
      if (firsts.some((w, i) => w && w === firsts[i - 1])) out.push(`twice: ${line.slice(0, 80)}`);
    }
    return out;
  });
  expect.soft(bad, `" | " without a space on a side (${where})`).toEqual([]);
}

/**
 * No text runs off the side of the screen, cut by the screen's edge: the
 * volume-up hint above the terminal's keys was one line past the right
 * edge, its last parts unreadable, and nothing caught it, because a box
 * clipped it at the edge and the page itself did not get wider (UIA-12).
 * Text in a row that scrolls sideways on purpose, cut with an ellipsis,
 * or wholly out of sight (a closed drawer) is not this.
 */
async function textOnScreen(page: Page, where: string) {
  const bad = await page.evaluate(() => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && out.length < 10; n = walker.nextNode()) {
      if (!n.textContent?.trim()) continue;
      const el = n.parentElement!;
      // .sr-only: for a screen reader only, clipped to nothing wherever it sits.
      if (el.closest('.xterm, .cm-editor, svg, .sr-only, dialog:not([open]), [inert], [aria-hidden=true]') || !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
      if (!rects.length) continue;
      const left = Math.min(...rects.map((r) => r.left));
      const right = Math.max(...rects.map((r) => r.right));
      if (right <= vw + 1 || left >= vw - 1) continue;
      // Meant to go on sideways (a row that scrolls), or said to be cut (an ellipsis).
      let meant = false;
      for (let c: Element | null = el; c && c !== document.body; c = c.parentElement) {
        const cs = getComputedStyle(c);
        if (/auto|scroll/.test(cs.overflowX) || cs.textOverflow === 'ellipsis') {
          meant = true;
          break;
        }
      }
      if (!meant) out.push(`"${n.textContent.trim().slice(0, 40)}" ends ${Math.round(right - vw)}px past the screen's right edge`);
    }
    return out;
  });
  expect.soft(bad, `text off the side of the screen (${where})`).toEqual([]);
}

/**
 * A log line's level badge sits with the first line of a message that wraps,
 * not halfway down it (report 97e99b).
 */
export async function levelsTopped(page: Page, where: string) {
  const low = await page.locator('[data-testid=log-line]:has(.lvl)').evaluateAll((els) =>
    els
      .filter((l) => (l as HTMLElement).getClientRects().length)
      .flatMap((l) => {
        const lvl = l.querySelector('.lvl')!.getBoundingClientRect();
        const msg = l.querySelector('.msg')?.getBoundingClientRect();
        return msg && msg.height > lvl.height * 1.8 && lvl.top - msg.top > 6 ? [(l.textContent ?? '').trim().slice(0, 60)] : [];
      }),
  );
  expect.soft(low, `level badges in the middle of a wrapped line (${where})`).toEqual([]);
}

/**
 * A row that scrolls sideways without a scrollbar says there is more
 * (lib/scrollcue.ts: data-more, faded at that edge): filter chips cut off
 * with no sign of the rest were not found (a journal's source chip, eeff05).
 * The terminal itself (kept at its width) is not such a row.
 */
export async function rowsReachable(page: Page, where: string) {
  const hidden = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((e) => {
        // Cheap first: only what is wider inside than out.
        if (e.scrollWidth - e.clientWidth <= 1 || !e.getClientRects().length || e.closest('.xterm, .term-wrap, .cm-editor, dialog:not([open])')) return false;
        const cs = getComputedStyle(e);
        return (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && cs.scrollbarWidth === 'none' && e.scrollWidth - e.clientWidth > 1 && !e.dataset.more;
      })
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`),
  );
  expect.soft(hidden, `rows with more out of sight and no sign of it (${where})`).toEqual([]);
}

/**
 * A list page on a wide screen (1700 px and more) uses its width: its
 * lists, cards and tiles reach most of the way across, not one column with
 * half the screen empty beside it (report ac7481). For the pages that list
 * things, once they run longer than the screen; forms, the file table and
 * the editor keep a width that reads well.
 */
export async function widthUsed(page: Page, where: string, min = 0.8) {
  const share = await page.evaluate(() => {
    // Only a page longer than the screen: what fits on one screen gains nothing from being spread out.
    if (window.innerWidth < 1700 || document.querySelector('dialog[open]') || document.documentElement.scrollHeight < window.innerHeight * 1.2) return 1;
    const els = [...document.querySelectorAll<HTMLElement>('.page [data-content], .page .list, .page .card, .page .tile-wrap, .page section')].filter((e) => e.getClientRects().length && e.getBoundingClientRect().height > 20);
    if (!els.length) return 1;
    return Math.max(...els.map((e) => e.getBoundingClientRect().right)) / window.innerWidth;
  });
  expect.soft(share, `a list page using ${Math.round(share * 100)}% of a wide screen's width (${where})`).toBeGreaterThanOrEqual(min);
}

/**
 * A read that failed is said on the page itself (LoadFailed, an error line),
 * not only in a toast that is gone after six seconds: a page that then looks
 * empty says "nothing there" (A3-WEB-01: Containers, the audit log, Users).
 * And said in words, not as "http 502" (A3-WEB-05).
 */
export async function failureShown(page: Page, where: string) {
  const said = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('main [data-testid=load-failed], main .alert.error, main [role=alert]')].filter((e) => e.checkVisibility()).map((e) => e.innerText.trim()),
  );
  expect.soft(said.length, `a failed read said on the page, not only in a toast (${where})`).toBeGreaterThan(0);
  expect.soft(said.filter((x) => /\bhttp[ _]\d{3}\b/i.test(x)), `a failure said as a bare HTTP code (${where})`).toEqual([]);
}

/**
 * A dialog taller than the screen scrolls its body only: its title, its
 * close button and its footer's buttons stay in sight (UIA-01, UIB-01: the
 * whole dialog scrolled, Save below the screen, the title scrolled away).
 * And its main button sits in that footer, not at the end of the body
 * (UIA-02: the problem report's Send below its picture).
 */
export async function dialogEdgesVisible(page: Page, where: string) {
  const out = await page.evaluate(() => {
    const d = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].pop();
    if (!d || d.classList.contains('viewer')) return [];
    const bad: string[] = [];
    if (d.scrollHeight > d.clientHeight + 1) bad.push(`the dialog itself scrolls (${d.scrollHeight} > ${d.clientHeight})`);
    const inView = (e: Element) => {
      const r = e.getBoundingClientRect();
      return r.top >= -1 && r.bottom <= window.innerHeight + 1;
    };
    for (const e of d.querySelectorAll(':scope > header button, :scope > footer button')) if ((e as HTMLElement).checkVisibility() && !inView(e)) bad.push(`"${(e.getAttribute('aria-label') ?? e.textContent ?? '').trim().slice(0, 30)}" out of sight`);
    // A form's main button belongs in the footer: a body that scrolls takes it out of sight
    // (unless it is held at the body's foot, as the question box of the AI's conversation).
    const body = d.querySelector<HTMLElement>(':scope > .body');
    const scrolls = !!body && body.scrollHeight > body.clientHeight + 1;
    const held = (b: Element) => {
      for (let a = b.parentElement; a && a !== body; a = a.parentElement) if (getComputedStyle(a).position === 'sticky') return true;
      return false;
    };
    for (const b of d.querySelectorAll<HTMLButtonElement>(':scope > .body button.primary')) if (b.type === 'submit' && b.form && b.checkVisibility() && (scrolls || !inView(b)) && !held(b)) bad.push(`"${b.textContent!.trim().slice(0, 30)}" in the body, not the footer`);
    // A form's footer has a way out beside its main button, as every other form dialog (UIA-20: New folder had only Save).
    const foot = [...d.querySelectorAll<HTMLButtonElement>(':scope > footer button')].filter((b) => b.checkVisibility());
    if (foot.length === 1 && foot[0]!.type === 'submit' && foot[0]!.form) bad.push(`"${foot[0]!.textContent!.trim().slice(0, 30)}" alone in the footer, no Cancel`);
    // Its title whole: two lines rather than cut (UIA-08: "Importeren uit ~/.ssh/co...").
    const h = d.querySelector<HTMLElement>(':scope > header h2');
    if (h && (h.scrollWidth > h.clientWidth + 1 || h.scrollHeight > h.clientHeight + 1)) bad.push(`title cut: "${h.textContent!.trim().slice(0, 40)}"`);
    return bad;
  });
  expect.soft(out, `a dialog keeps its title and buttons in sight (${where})`).toEqual([]);
}

/**
 * Text in a dialog ends inside it: the shortcuts' descriptions ran past
 * the dialog's right edge at 343 px and were clipped ("Dit overzich", UIA-03).
 * A box that scrolls or cuts on purpose (code, a log, "...") is its own.
 */
export async function dialogTextInside(page: Page, where: string) {
  const out = await page.evaluate(() => {
    const d = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].pop();
    const body = d?.querySelector<HTMLElement>(':scope > .body');
    if (!d || !body) return [];
    const edge = body.getBoundingClientRect().left + body.clientWidth;
    const found: string[] = [];
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.textContent!.trim() || !el.checkVisibility()) continue;
      let own = false;
      for (let a: HTMLElement | null = el; a && a !== body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis' || a.matches('pre, code, .xterm, .cm-editor, input, textarea, select')) own = true;
      }
      if (own) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      if ([...r.getClientRects()].some((x) => x.width > 0 && x.right > edge + 1)) found.push(n.textContent!.trim().slice(0, 30));
    }
    return [...new Set(found)].slice(0, 8);
  });
  expect.soft(out, `text past the dialog's edge (${where})`).toEqual([]);
}

/**
 * Nothing that floats (a toast, a pill, a panel, a round button) lies over a
 * button: a toast hid the selection bar's Copy, Cut and Delete and an empty
 * list's Add (UIA-04), the add button sat on a row's menu, the busy panel on
 * the title bar's back button (UIA-06), a toast on a dialog's Send and on a
 * recording's Download (UIB-09). Measured where a tap would land.
 */
export async function floatersOffButtons(page: Page, where: string) {
  const out = await page.evaluate(() => {
    const scope: ParentNode = [...document.querySelectorAll('dialog[open]')].pop() ?? document;
    const floating = (e: Element | null): Element | null => {
      for (let a = e; a && a !== document.body; a = a.parentElement) {
        // The navigation, a dialog, and a panel docked at the foot (the bottom panel: with the keyboard up it takes the screen on purpose).
        if (a.matches('nav.bottomnav, dialog, [data-dock]')) return null;
        if (getComputedStyle(a).position === 'fixed' || a.matches(':popover-open')) return a;
      }
      return null;
    };
    const found: string[] = [];
    for (const b of scope.querySelectorAll<HTMLElement>('button, a.btn, [role=button]')) {
      if (!b.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (r.width < 4 || x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit || b.contains(hit) || hit.contains(b)) continue;
      const f = floating(hit);
      if (!f || f.contains(b)) continue;
      // A list's whole row is still there to tap beside what lies on part of it; its action buttons are not.
      if (r.width >= window.innerWidth * 0.6) continue;
      // A bar or panel docked across the screen (a selection bar, the bottom panel, the busy list) is
      // scrolled under like the tab bar; it may not cover the title bar's buttons (the busy list did).
      if (f.getBoundingClientRect().width >= window.innerWidth * 0.9 && !f.matches(':popover-open') && !b.closest('.topbar, header')) continue;
      found.push(`"${(f.textContent ?? '').trim().slice(0, 24)}" over "${(b.getAttribute('aria-label') ?? b.textContent ?? '').trim().slice(0, 24)}"`);
    }
    return [...new Set(found)].slice(0, 8);
  });
  expect.soft(out, `something floating over a button (${where})`).toEqual([]);
}

/**
 * A toast leaves a form's fields and its messages free, and an open
 * dialog's buttons however wide: on a phone it lay over a dialog's name
 * field and the refusal under it ("Folder Kept made." on the phone's
 * Rename), and over Rename in a file's menu (2.18.0). By boxes:
 * floatersOffButtons' hit test does not see a toast over a modal dialog.
 */
export async function toastsOffFields(page: Page, where: string) {
  const out = await page.evaluate(() => {
    // By their boxes: a point under an open modal dialog does not hit a toast (outside the dialog it is inert to hit tests).
    const shown = [...document.querySelectorAll<HTMLElement>('[data-testid=toasts] .toast')].filter((t) => t.checkVisibility({ visibilityProperty: true, opacityProperty: true }));
    if (!shown.length) return [];
    const scope: ParentNode = [...document.querySelectorAll('dialog[open]')].pop() ?? document;
    const found: string[] = [];
    const what = `input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, select, .alert${scope === document ? '' : ', button, a.btn, [role=button]'}`;
    for (const f of scope.querySelectorAll<HTMLElement>(what)) {
      if (!f.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || f.closest('[data-testid=toasts]')) continue;
      const r = f.getBoundingClientRect();
      const y = r.top + r.height / 2;
      if (r.width < 4 || y < 0 || y > window.innerHeight) continue;
      for (const t of shown) {
        const b = t.getBoundingClientRect();
        if (b.left < r.right - 4 && r.left < b.right - 4 && y > b.top && y < b.bottom) found.push(`"${(t.textContent ?? '').trim().slice(0, 24)}" over ${f.tagName.toLowerCase()}${f.className ? '.' + String(f.className).split(' ')[0] : ''}`);
      }
    }
    return [...new Set(found)];
  });
  expect.soft(out, `a toast over a field or a message (${where})`).toEqual([]);
}

/**
 * A field's help "?" sits beside its label's words, not over them ("voorstell(?)n",
 * UIA-05); helpTipsBeside covers the tips beside headings.
 */
export async function fieldTipsBeside(page: Page, where: string) {
  const out = await page.evaluate(() => {
    const found: string[] = [];
    for (const tip of document.querySelectorAll<HTMLElement>('.field-help')) {
      if (!tip.checkVisibility()) continue;
      const t = tip.getBoundingClientRect();
      const wrap = tip.closest('.field-wrap') ?? tip.parentElement!;
      const walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (tip.contains(n) || !n.textContent!.trim() || n.parentElement?.closest('input, textarea, select, option')) continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        if ([...r.getClientRects()].some((x) => x.width > 0 && x.left < t.right - 1 && t.left < x.right - 1 && x.top < t.bottom - 1 && t.top < x.bottom - 1)) found.push(n.textContent!.trim().slice(0, 40));
      }
    }
    return found;
  });
  expect.soft(out, `a field's help tip over its label (${where})`).toEqual([]);
}

/**
 * The tab on screen is in sight in its strip: with many terminal sessions
 * the active one was off to the right, none highlighted (UIB-03).
 */
export async function activeTabVisible(page: Page, where: string) {
  const out = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[role=tablist]')]
      .filter((l) => l.checkVisibility() && !l.closest('dialog:not([open])'))
      .flatMap((l) => {
        const tab = l.querySelector<HTMLElement>('[role=tab][aria-selected=true]');
        if (!tab) return [];
        const a = l.getBoundingClientRect();
        const r = tab.getBoundingClientRect();
        return r.left < a.left - 1 || r.right > a.right + 1 ? [`"${tab.textContent!.trim().slice(0, 30)}" (${Math.round(r.left)}-${Math.round(r.right)} of ${Math.round(a.left)}-${Math.round(a.right)})`] : [];
      }),
  );
  expect.soft(out, `the active tab out of sight in its strip (${where})`).toEqual([]);
}

/**
 * A row of like things (colour swatches) that wraps leaves none alone on its
 * last line: the sixth accent colour sat by itself under five (UIA-19).
 */
export async function noLoneInWrap(page: Page, where: string) {
  const out = await page.evaluate(() => {
    const found: string[] = [];
    for (const row of document.querySelectorAll<HTMLElement>('main *, dialog[open] *')) {
      const cs = getComputedStyle(row);
      if (!cs.display.includes('flex') || cs.flexWrap !== 'wrap' || cs.flexDirection.startsWith('column')) continue;
      const kids = [...row.children].filter((k) => (k as HTMLElement).checkVisibility()) as HTMLElement[];
      if (kids.length < 4) continue;
      const rs = kids.map((k) => k.getBoundingClientRect());
      // Alike: one size (swatches, keys), not chips of their own lengths.
      if (rs.some((r) => Math.abs(r.width - rs[0]!.width) > 1 || Math.abs(r.height - rs[0]!.height) > 1)) continue;
      const lines = [...new Set(rs.map((r) => Math.round(r.top)))];
      if (lines.length < 2) continue;
      const last = rs.filter((r) => Math.round(r.top) === lines[lines.length - 1]).length;
      if (last === 1) found.push(`${row.tagName.toLowerCase()}.${[...row.classList].slice(0, 2).join('.')}: ${kids.length} in ${lines.length} lines, the last alone`);
    }
    return found;
  });
  expect.soft(out, `one alone on the last line of a wrapped row of like things (${where})`).toEqual([]);
}

/**
 * Names joined by a hyphen stay whole on a line: a unit, a disk model, a
 * recovery code, a container name ("ST10000DM006-" / "3GD", "VVDQ-R73H-" /
 * "RKGH-3DYE", "burrowtest-" / "worker"; UIA-09, UIA-10, UIB-07). Long
 * paths may break where they must; these are short.
 */
export async function namesWhole(page: Page, where: string) {
  const out = await page.evaluate(() => {
    const found: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || !el.getClientRects().length || el.closest('.xterm, .cm-editor, pre, code, .mono, [data-testid=log], .log, [aria-hidden=true], dialog:not([open]), textarea')) continue;
      const whole = (n.textContent ?? '').trim();
      for (const m of (n.textContent ?? '').matchAll(/[\w.@]{2,}(?:-[\w.@]+)+/g)) {
        // A name standing alone (a title, a cell, a model, a code); in running text a name may break at its hyphen.
        if (m[0].length > 28 || whole !== m[0]) continue;
        const r = document.createRange();
        r.setStart(n, m.index);
        r.setEnd(n, m.index + m[0].length);
        const tops = new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)));
        if (tops.size > 1) found.push(m[0]);
      }
    }
    return [...new Set(found)].slice(0, 10);
  });
  expect.soft(out, `a hyphenated name broken over two lines (${where})`).toEqual([]);
}

/**
 * The editor's find and replace is made for a finger on a phone: rows a
 * finger can hit, not CodeMirror's 16 px tick boxes and small labels (UIA-18).
 */
export async function editorPanelsTouch(page: Page, where: string) {
  if ((page.viewportSize()?.width ?? 1280) >= 600) return;
  const out = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.cm-panels button, .cm-panels input:not([type=checkbox]), .cm-panels label')]
      .filter((e) => e.checkVisibility())
      .filter((e) => e.getBoundingClientRect().height < 36)
      .map((e) => `${e.tagName.toLowerCase()} "${(e.getAttribute('name') ?? e.textContent ?? '').trim().slice(0, 20)}" ${Math.round(e.getBoundingClientRect().height)} px`),
  );
  expect.soft(out, `the editor's panel too small for a finger (${where})`).toEqual([]);
}

/**
 * Every check on what is on screen now (a page, or a dialog over it), then a
 * screenshot as test-results/tour/<name>.png for a person to look at.
 * `tips`: also open and close every help tip (slow; once per screen is enough).
 */
/**
 * The tour's other passes, for a screen another spec makes: a screen seen only
 * in light English (64 at 1280 px, 55 on a phone) was never seen dark, in Dutch
 * or on a tablet (UIA-23, UIB-02). Switched in place (the size, and the
 * language and theme as another tab would change them), so what the spec
 * opened stays open; then back as it was.
 */
const PASSES = {
  phone: [{ width: 390, height: 844 }, 'en', false],
  'phone-nl': [{ width: 343, height: 711 }, 'nl', false],
  'phone-dark': [{ width: 390, height: 844 }, 'en', true],
  'tablet-nl': [{ width: 820, height: 1180 }, 'nl', false],
  'desktop-dark-nl': [{ width: 1440, height: 900 }, 'nl', true],
} as const;
type Pass = keyof typeof PASSES;
/**
 * The passes of a screen that exists only on a wide screen (terminals side by side: one pane
 * below 900 px): dark Dutch on a computer. seen.spec.ts takes these as complete.
 */
export const WIDE_ONLY: Pass[] = ['desktop-dark-nl'];
export const WIDE_ONLY_SCREENS = ['term-split', 'term-broadcast', 'term-layout', 'term-split-3', 'term-zoomed'];
/** Screens looked at in some of the passes only, and why. seen.spec.ts takes these as complete. */
export const SOME_PASSES: Record<string, { passes: Pass[]; why: string }> = {
  'container-update-done': { passes: ['phone', 'phone-dark', 'tablet-nl', 'desktop-dark-nl'], why: "a finished update's line, once, over a log file's chips: at 343 px the log has 59% of the screen; the moment passes" },
  'settings-shortcuts': { passes: ['desktop-dark-nl'], why: "the keyboard shortcuts' table is for a computer's keyboard: a phone or tablet (touch, under 900 px) has key bars and no Shortcuts section in Settings" },
  'log-asked': { passes: ['phone', 'phone-dark', 'tablet-nl', 'desktop-dark-nl'], why: "the filters a question to the model set, said in a line over the log: at 343 px the log has 61% of the screen; Undo or a new filter ends it" },
};

/** The passes still to see for a screen by its name: a desktop one all five, a phone one its Dutch and dark. */
export function otherPasses(name: string): Pass[] {
  if (/^desktop-(?!dark-nl-)/.test(name)) return ['phone', 'phone-nl', 'phone-dark', 'tablet-nl', 'desktop-dark-nl'];
  if (/^phone-(?!nl-|dark-|343-)/.test(name)) return ['phone-nl', 'phone-dark'];
  return [];
}
async function setLook(page: Page, look: { locale: string | null; appearance: string | null }) {
  await page.evaluate((l) => {
    for (const [key, value] of [
      ['burrow.locale', l.locale],
      ['burrow.appearance', l.appearance],
    ] as const) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }));
    }
  }, look);
  await expect(page.locator('html')).toHaveAttribute('lang', look.locale ?? 'en');
  await page.waitForTimeout(200);
}
async function lookInPasses(page: Page, name: string, passes: Pass[], opts: { tips?: boolean }) {
  if (!passes.length || page.isClosed()) return;
  // Each pass takes its time: the test's own limit grows with them.
  test.info().setTimeout(test.info().timeout + passes.length * 15_000);
  const size = page.viewportSize();
  const before = await page.evaluate(() => ({ locale: localStorage.getItem('burrow.locale'), appearance: localStorage.getItem('burrow.appearance') }));
  const rest = name.replace(/^(desktop|phone)-/, '');
  try {
    for (const pass of passes) {
      const [vp, lang, dark] = PASSES[pass];
      await page.setViewportSize(vp);
      const appearance = JSON.stringify({ ...JSON.parse(before.appearance ?? '{}'), mode: dark ? 'dark' : 'light' });
      await setLook(page, { locale: lang, appearance });
      await lookAt(page, `${pass}-${rest}`, { tips: opts.tips && pass === 'phone-nl', axe: pass === 'desktop-dark-nl' || pass === 'phone-dark', passes: [] });
    }
  } finally {
    if (size) await page.setViewportSize(size);
    await setLook(page, before);
  }
}

export async function lookAt(page: Page, name: string, opts: { tips?: boolean; axe?: boolean; passes?: Pass[] } = {}) {
  await lookOnce(page, name, opts);
  await lookInPasses(page, name, opts.passes ?? otherPasses(name), opts);
}

async function lookOnce(page: Page, name: string, opts: { tips?: boolean; axe?: boolean }) {
  // What is still on its way (the shimmering shape of a list): looked at once it is there.
  await page.getByTestId('skeleton').first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});
  await listsReadable(page, name);
  await titlesRoomy(page, name);
  await selectsRoomy(page, name);
  await helpTipsBeside(page, name);
  await headingTipsBeside(page, name);
  await fieldsAligned(page, name);
  await controlsInCards(page, name);
  await selectsFit(page, name);
  await namesRoomy(page, name);
  await togglesSmall(page, name);
  await iconsConsistent(page, name);
  await pillsSpaced(page, name);
  await textLinksUnderlined(page, name);
  await topbarTipsBeside(page, name);
  await wordsForPeople(page, name);
  await rowButtonsEven(page, name);
  await iconsWhole(page, name);
  await listsApart(page, name);
  await recordsApart(page, name);
  await rowActionsBeside(page, name);
  await mainRoomy(page, name);
  await mainReachable(page, name);
  await buttonsInSight(page, name);
  await termBarKept(page, name);
  await termRowsInside(page, name);
  await stillWhenAsked(page, name);
  await pillsWhole(page, name);
  await layoutForScreen(page, name);
  await toastsOnce(page, name);
  await textNotSqueezed(page, name);
  await placeholdersWhole(page, name);
  await chromeCompact(page, name);
  await noKeysOnTouch(page, name);
  await controlsEven(page, name);
  await cardsApart(page, name);
  await rowButtonOneLine(page, name);
  await buttonLabelsOneLine(page, name);
  await rowButtonsSameWidth(page, name);
  await logLinesWhole(page, name);
  await tablesFromTablet(page, name);
  await buttonsInside(page, name);
  await dotsSolid(page, name);
  await floatersClear(page, name);
  await footBarsFree(page, name);
  await buttonsLegible(page, name);
  await chosenVisible(page, name);
  await segmentsFit(page, name);
  await segmentsEven(page, name);
  await loneControlsFill(page, name);
  await rowsFill(page, name);
  await actionRowsOneLine(page, name);
  await textBesideButton(page, name);
  await besideFieldSameHeight(page, name);
  await clampedTextInside(page, name);
  await contentUnderBar(page, name);
  await nothingOutOfReach(page, name);
  await wordsWhole(page, name);
  await rowsReachable(page, name);
  await separatorsSpaced(page, name);
  await levelsTopped(page, name);
  await centredTogether(page, name);
  await boxesApart(page, name);
  await buttonsOffLines(page, name);
  await textApart(page, name);
  await controlsOffEdges(page, name);
  await textInsideBorders(page, name);
  await textOnScreen(page, name);
  await widthsEven(page, name);
  await gapsEven(page, name);
  await barsEdgeToEdge(page, name);
  await floatersOneLine(page, name);
  await rowsBalanced(page, name);
  await dialogEdgesVisible(page, name);
  await dialogTextInside(page, name);
  await floatersOffButtons(page, name);
  await toastsOffFields(page, name);
  await fieldTipsBeside(page, name);
  await activeTabVisible(page, name);
  await noLoneInWrap(page, name);
  await namesWhole(page, name);
  await editorPanelsTouch(page, name);
  await columnsEven(page, name);
  await privateMarked(page, name);
  await oneScroll(page, name);
  await panelAtBottom(page, name);
  await cardTitlesLevel(page, name);
  // Tabs tell themselves apart (two sessions on one host were both "test-sshd").
  const tabs = await page.locator('[role=tablist] [role=tab]:visible').allTextContents();
  const same = tabs.map((x) => x.trim()).filter((x, i, all) => x && all.indexOf(x) !== i);
  expect.soft(same, `tabs with the same name (${name})`).toEqual([]);
  // Nothing makes the page wider than the screen.
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `sideways scroll (${name})`).toBeLessThanOrEqual(0);
  // A dialog fits the screen: its buttons are reachable.
  const dlg = page.locator('dialog[open]');
  // One dialog at a time: a second over the first is a maze to get out of.
  // The one exception is the app's "are you sure?", answered in one tap.
  expect.soft(await page.locator('dialog[open]:not([data-tour=confirm])').count(), `dialogs open at once (${name})`).toBeLessThanOrEqual(1);
  if (await dlg.count()) {
    const box = (await dlg.first().boundingBox())!;
    const vw = page.viewportSize()!;
    expect.soft(box.x >= -1 && box.x + box.width <= vw.width + 1, `dialog within the screen's width (${name})`).toBe(true);
    // And its height: a taller one scrolls inside, its buttons never below the screen.
    expect.soft(box.y >= -1 && box.y + box.height <= vw.height + 1, `dialog within the screen's height (${name}: ${Math.round(box.y)}+${Math.round(box.height)} of ${vw.height})`).toBe(true);
  }
  if (opts.tips) await helpTipsWork(page, name);
  mkdirSync(TOUR, { recursive: true });
  // What was looked at: the tour checks at its end that nothing was left out.
  const seen = await page.evaluate(() => ({
    dialogs: [...document.querySelectorAll('dialog[open][data-tour]')].map((d) => d.getAttribute('data-tour')!),
    hash: location.hash,
    signedIn: !!document.querySelector('nav.bottomnav'),
    setup: !!document.querySelector('[data-page=setup]'),
  }));
  appendFileSync(SEEN, [...seen.dialogs.map((d) => `dialog:${d}`), `page:${seen.setup ? 'setup' : pageOf(seen.hash, seen.signedIn)}`].join('\n') + '\n');
  // A whole page from its top: scrolled, the sticky title bar and the rail were painted half way down (UIB-17).
  const whole = !(await dlg.count());
  if (whole) await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(TOUR, `${name}.png`), fullPage: whole });
  if (opts.axe !== false) await accessible(page, name);
  // The controls shown here: each must be pressed by some test (scripts/controls-check.mjs).
  await page.evaluate(CONTROL_ID);
  const controls = await page.evaluate(() => {
    const id = (window as unknown as { __controlId: (el: Element) => string | null }).__controlId;
    // In the open dialog when there is one: the page behind it cannot be reached.
    const root = document.querySelector('dialog[open]') ?? document;
    return [...root.querySelectorAll('button, [role=button], a[href], [role=tab], [role=option], input[type=checkbox], input[type=radio], select, summary')]
      .filter((c) => (c as HTMLElement).getClientRects().length > 0 && !(c as HTMLButtonElement).disabled)
      .map((c) => id(c))
      .filter((x): x is string => !!x);
  });
  await flushCoverage();
  mkdirSync(join(TOUR, '..', 'controls-seen'), { recursive: true });
  appendFileSync(join(TOUR, '..', 'controls-seen', 'seen.txt'), controls.map((c) => `${c}\t${name}`).join('\n') + '\n');
}
