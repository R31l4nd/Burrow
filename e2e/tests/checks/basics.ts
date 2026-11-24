import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

// Basics: accessibility, lists and titles, tips, fields, the main content's room. Part of checks.ts (lookAt).

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
 * Titles and subtitles in lists never run together ("Debian10.0.0.20"):
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
        // Inside a list row, a tab bar, a heading or a table's column names (pressed for their order,
        // the one in use with its arrow: report faf150) the look says enough.
        const structural = e.closest('.list-item, [role=tablist], nav, h1, h2, h3, .segmented, .chips, .crumbs, [aria-label=Path], .chead');
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
  // A row laid out side by side (tabs, chips, keys) that scrolls sideways scrolls up and down too
  // unless told not to (CSS makes the other direction auto): the tabs atop a terminal moved up
  // under a swipe, cut off at the top (report e020bc). A column that scrolls is a list, not this.
  const sliver = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((e) => {
        const s = getComputedStyle(e);
        const row = s.display.endsWith('flex') && s.flexDirection.startsWith('row') && s.flexWrap === 'nowrap';
        const sideways = s.overflowX === 'auto' || s.overflowX === 'scroll';
        const upDown = s.overflowY === 'auto' || s.overflowY === 'scroll';
        return row && sideways && upDown && e.scrollHeight - e.clientHeight > 1 && e.getClientRects().length && !e.closest('.xterm, .cm-editor');
      })
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} (${e.scrollHeight - e.clientHeight} px)`),
  );
  expect.soft(sliver, `rows that scroll sideways and up and down too (${where})`).toEqual([]);
  // A row of buttons that scrolls sideways, squeezed by its neighbours to less than one of them:
  // the sessions' names in a workspace's panel went to 0 px on a 343 px phone (report 6cbc81).
  const squeezed = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((e) => {
        const s = getComputedStyle(e);
        const sideways = s.overflowX === 'auto' || s.overflowX === 'scroll';
        const buttons = [...e.querySelectorAll<HTMLElement>('button, a[href]')].filter((b) => b.getClientRects().length);
        if (!sideways || !buttons.length || !e.getClientRects().length || e.closest('dialog:not([open]), [aria-hidden=true], .xterm, .cm-editor')) return false;
        return e.scrollWidth > e.clientWidth + 1 && e.clientWidth < Math.min(40, ...buttons.map((b) => b.offsetWidth));
      })
      .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} (${e.clientWidth} px)`),
  );
  expect.soft(squeezed, `rows of buttons squeezed to less than one button (${where})`).toEqual([]);
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
