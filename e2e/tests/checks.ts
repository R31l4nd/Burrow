import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { CONTROL_ID, flushCoverage } from './fixtures.js';
import { pageOf } from './pages.js';
import { accessible, listsReadable, titlesRoomy, selectsRoomy, namesRoomy, selectsFit, togglesSmall, iconsConsistent, pillsSpaced, controlsInCards, helpTipsBeside, textLinksUnderlined, helpTipsWork, fieldsAligned, headingTipsBeside, stillWhenAsked, buttonsInSight, mainReachable, mainRoomy } from './checks/basics.js';
import { termBarKept, termRowsInside, placeholdersWhole, textNotSqueezed, rowButtonOneLine, buttonLabelsOneLine, rowButtonsSameWidth, tablesFromTablet, logLinesWhole, buttonsInside, loneControlsFill, besideFieldSameHeight, clampedTextInside, actionRowsOneLine, rowsFill, textBesideButton, contentUnderBar, nothingOutOfReach } from './checks/rows.js';
import { nothingCutSideways, spacerInARow, textInsideItsBorder, segmentsFit, segmentsEven, wordsWhole, centredTogether, cardsApart, buttonsOffLines, boxesApart, textApart, controlsOffEdges, textInsideBorders, widthsEven } from './checks/edges.js';
import { gapsEven, barsEdgeToEdge, floatersOneLine, rowsBalanced, controlsEven, dotsSolid, floatersClear, footBarsFree, buttonsLegible, chosenVisible, noKeysOnTouch, toastsOnce, layoutForScreen, pillsWhole, chromeCompact, rowButtonsEven, listsApart, recordsApart, rowActionsBeside, iconsWhole, columnsEven, cardTitlesLevel, privateMarked, oneScroll, panelAtBottom, topbarTipsBeside, wordsForPeople, separatorsSpaced, textOnScreen, levelsTopped, rowsReachable, dialogEdgesVisible, dialogTextInside, floatersOffButtons, toastsOffFields, fieldTipsBeside, activeTabVisible, noLoneInWrap, namesWhole, editorPanelsTouch } from './checks/spacing.js';

// Checks for the slips people notice first, shared by the specs that look
// at pages and dialogs. lookAt() runs them all and keeps a screenshot.

// TOUR_DIR: a look at another Burrow (the live one, by hand) keeps its pictures apart from the gate's.
const TOUR = process.env.TOUR_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'test-results', 'tour');
/** Every page and dialog lookAt saw, one per line ("page:hosts", "dialog:host-sheet"). */
export const SEEN = join(TOUR, 'seen.txt');

export { accessible, listsReadable, titlesRoomy, selectsRoomy, namesRoomy, selectsFit, togglesSmall, iconsConsistent, pillsSpaced, controlsInCards, helpTipsBeside, textLinksUnderlined, helpTipsWork, fieldsAligned, headingTipsBeside, stillWhenAsked, buttonsInSight, mainReachable, mainRoomy } from './checks/basics.js';
export { placeholdersWhole, textNotSqueezed, loneControlsFill, contentUnderBar, nothingOutOfReach } from './checks/rows.js';
export { toastsOnce, layoutForScreen, pillsWhole, chromeCompact, rowButtonsEven, listsApart, recordsApart, rowActionsBeside, iconsWhole, columnsEven, cardTitlesLevel, privateMarked, oneScroll, panelAtBottom, topbarTipsBeside, wordsForPeople, separatorsSpaced, levelsTopped, rowsReachable, widthUsed, failureShown, dialogEdgesVisible, dialogTextInside, floatersOffButtons, toastsOffFields, fieldTipsBeside, activeTabVisible, noLoneInWrap, namesWhole, editorPanelsTouch } from './checks/spacing.js';

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


/**
 * What runs past an edge, cheap enough for every width of a sweep (workspace-sweep.spec.ts): the
 * reports came from sizes between the tour's (a phone turned at 698 px, report 95ce1f; a screen
 * just over 1700 px, report 5a729b), so these run at forty widths a page, not eleven.
 */
export async function sweepLook(page: Page, name: string) {
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `sideways scroll (${name})`).toBeLessThanOrEqual(0);
  await nothingCutSideways(page, name);
  await textInsideItsBorder(page, name);
  await textInsideBorders(page, name);
  await buttonsInside(page, name);
  await textOnScreen(page, name);
  await wordsWhole(page, name);
  await namesWhole(page, name);
  await buttonLabelsOneLine(page, name);
  await pillsWhole(page, name);
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
  await nothingCutSideways(page, name);
  await textInsideItsBorder(page, name);
  await spacerInARow(page, name);
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
