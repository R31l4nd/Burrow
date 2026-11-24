import { expect, type Page } from '@playwright/test';

// Spacing and the rest: gaps, floating bars, pills, dialogs, names, tabs. Part of checks.ts (lookAt).

/**
 * Cards and lists stacked in one column are evenly spaced: the host
 * statistics had 12 px between some cards and 24 px between others.
 */
export async function gapsEven(page: Page, where: string) {
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
export async function barsEdgeToEdge(page: Page, where: string) {
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
export async function floatersOneLine(page: Page, where: string) {
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
export async function rowsBalanced(page: Page, where: string) {
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
export async function controlsEven(page: Page, where: string) {
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
export async function dotsSolid(page: Page, where: string) {
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
export async function floatersClear(page: Page, where: string) {
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
export async function footBarsFree(page: Page, where: string) {
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
export async function buttonsLegible(page: Page, where: string) {
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
export async function chosenVisible(page: Page, where: string) {
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
export async function noKeysOnTouch(page: Page, where: string) {
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
export async function textOnScreen(page: Page, where: string) {
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
