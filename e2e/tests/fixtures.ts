import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base } from '@playwright/test';
import { CoverageReport } from 'monocart-coverage-reports';
import { COVERAGE_OPTIONS } from './coverage-options.js';

export * from '@playwright/test';

// Every test, by itself: how much of the web app's code it ran (V8 coverage
// in Chromium, added up over the run: scripts/web-coverage.mjs), and which
// controls it pressed (scripts/controls-check.mjs: every control the tour
// sees is pressed by some test). Specs import `test` from here.

const RESULTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-results');

/**
 * A control's name, the same wherever it is seen or pressed: its test id,
 * else its English label with the page it is on. Defined in the page as
 * window.__controlId (here, and by lookAt for pages opened elsewhere).
 */
export const CONTROL_ID = `window.__controlId = (el) => {
  const c = el.closest('button, [role=button], a[href], [role=tab], [role=option], input[type=checkbox], input[type=radio], select, summary');
  if (!c) return null;
  const id = c.getAttribute('data-testid');
  // A test id with a number in it ("direct-host-2") is one control per thing shown: one name.
  if (id) return 'testid:' + id.replace(/\\d+/g, '#');
  if (document.documentElement.lang !== 'en') return null;
  const label = (c.getAttribute('aria-label') || c.getAttribute('title') || c.textContent || (c.labels && c.labels[0] && c.labels[0].textContent) || '').replace(/\\d+/g, '#').replace(/\\s+/g, ' ').trim().slice(0, 60);
  if (!label) return null;
  // The same everywhere (the navigation, a section's tabs, a dialog's own
  // close button): once, not per page or dialog.
  // Where a link goes: its text can carry a count ("3 Containers").
  if (c.closest('nav')) return 'nav:' + (c.getAttribute('href') || label);
  if (c.closest('[role=tablist]')) return 'tabs:' + label;
  if (c.closest('dialog header, .dialog-head')) return 'dialog:' + label;
  const dialog = c.closest('dialog[data-tour]');
  const where = dialog ? 'dialog-' + dialog.getAttribute('data-tour') : (location.hash.replace(/^#\\/?/, '').split(/[/?]/)[0] || 'hosts');
  // A row that is data (an alert, a container, a time): one of them pressed is the row pressed.
  if (label.length > 40 || c.closest('.list-item') === c) return where + ':row:' + ((c.className || '').toString().split(' ').filter((x) => x && !x.startsWith('svelte-')).join('.') || c.tagName.toLowerCase());
  return where + ':' + c.tagName.toLowerCase() + ':' + label;
};`;

interface Fn {
  functionName: string;
  isBlockCoverage: boolean;
  ranges: { startOffset: number; endOffset: number; count: number }[];
}
/** The page's coverage taken so far: per bundle, per function (by where it is), ran or not. */
let current: { cdp: import('@playwright/test').CDPSession; taken: Map<string, Map<string, Fn>> } | null = null;

/**
 * Take what ran so far and start counting again: V8 keeps every function of
 * every page it counts alive until then, and the tour reloads hundreds of
 * times (it ran seven minutes slower without this). lookAt calls it.
 */
export async function flushCoverage(): Promise<void> {
  if (!current) return;
  const { cdp, taken } = current;
  await takeFrom(cdp, taken);
  await cdp.send('Profiler.stopPreciseCoverage').catch(() => {});
  await cdp.send('Profiler.startPreciseCoverage', { callCount: false, detailed: false }).catch(() => {});
}

/** What ran in one page so far, added to `taken`. */
async function takeFrom(cdp: import('@playwright/test').CDPSession, taken: Map<string, Map<string, Fn>>): Promise<void> {
  const { result } = await cdp.send('Profiler.takePreciseCoverage').catch(() => ({ result: [] as { url: string; functions: Fn[] }[] }));
  for (const r of result) {
    if (!/\/assets\/[^/]+\.js$/.test(r.url.split('?')[0]!)) continue;
    const fns = taken.get(r.url) ?? new Map<string, Fn>();
    taken.set(r.url, fns);
    // Ran once is ran: the counts of the same function added up.
    for (const f of r.functions as Fn[]) {
      const key = `${f.ranges[0]!.startOffset}-${f.ranges[0]!.endOffset}`;
      const had = fns.get(key);
      fns.set(key, had ? { ...had, ranges: had.ranges.map((x, i) => ({ ...x, count: x.count + (f.ranges[i]?.count ?? 0) })) } : f);
    }
  }
}

export const test = base.extend<{ cover: boolean; watch: void }>({
  /**
   * Coverage on (the default). The tour turns it off: it reloads hundreds of
   * pages, and V8 counting (or handing over) every function each time made
   * it run past its twenty minutes; what it shows, the other tests run.
   */
  cover: [true, { option: true }],
  watch: [
    async ({ page, browser, browserName, cover }, use, info) => {
      // Which functions ran (V8's best-effort coverage: per function, cheap;
      // per block slowed the page down enough to upset the tour's timing).
      const cdp = browserName === 'chromium' && cover ? await page.context().newCDPSession(page) : null;
      if (cdp) {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.startPreciseCoverage', { callCount: false, detailed: false });
        current = { cdp, taken: new Map() };
        // A page loaded anew (a reload, another address) drops what its last
        // document ran: taken first. Before, everything a test did before its
        // next reload went uncounted unless a lookAt came in between (the
        // folder picker's "copy here" read as never run).
        const keep = async () => {
          if (current?.cdp === cdp) await takeFrom(cdp, current.taken);
        };
        const reload = page.reload.bind(page);
        page.reload = async (o) => (await keep(), reload(o));
        const goto = page.goto.bind(page);
        page.goto = async (url, o) => {
          const doc = (u: string) => u.split('#')[0];
          // Only the part after # changed: the same document, nothing lost.
          if (/^https?:/.test(page.url()) && doc(new URL(url, page.url()).href) !== doc(page.url())) await keep();
          return goto(url, o);
        };
      }
      // Pressed: a change of a box or a list, or a click that did something
      // within two seconds (AUDIT2 TEST-06: a handler that does nothing must
      // not count): the page changed, a request or a socket message went
      // out, the address, focus or clipboard changed, a window, dialog or
      // file chooser opened. A link to another page or a file goes there.
      // In this page and in any other browser a test opens (someone invited).
      const pressed = new Set<string>();
      const watch = async (c: import('@playwright/test').BrowserContext) => {
        await c.exposeBinding('__pressed', (_src, id: string) => void pressed.add(id));
        await c.addInitScript(`${CONTROL_ID}
          {
            const pending = [];
            const effective = (window.__effective = []);
            const done = (id) => { effective.push(id); window.__pressed(id); };
            // A click that reloads the page (Reload on a newer server): told
            // on the next page, the binding may not get out of one that unloads.
            const CARRY = '__pressedCarry';
            try { for (const id of JSON.parse(sessionStorage.getItem(CARRY) ?? '[]')) done(id); sessionStorage.removeItem(CARRY); } catch {}
            const bump = () => {
              const now = Date.now();
              while (pending.length) { const p = pending.shift(); if (now - p.at <= 2000) done(p.id); }
            };
            addEventListener('click', (e) => {
              const id = window.__controlId(e.target);
              if (!id) return;
              const href = e.target.closest('a[href]')?.getAttribute('href');
              if (href && !href.startsWith('#')) return done(id);
              pending.push({ id, at: Date.now() });
            }, { capture: true });
            addEventListener('change', (e) => { const id = window.__controlId(e.target); if (id) done(id); }, { capture: true });
            new MutationObserver(bump).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
            for (const type of ['hashchange', 'popstate', 'submit', 'focusin']) addEventListener(type, bump, { capture: true });
            addEventListener('pagehide', () => {
              const now = Date.now();
              const ids = pending.splice(0).filter((p) => now - p.at <= 2000).map((p) => p.id);
              try { if (ids.length) sessionStorage.setItem(CARRY, JSON.stringify(ids)); } catch {}
              for (const id of ids) done(id);
            }, { capture: true });
            // A test's stand-in for the Android app: a call to it is an effect too.
            addEventListener('burrow-test-effect', bump);
            const wrap = (o, k) => {
              const f = o && o[k];
              if (typeof f === 'function') o[k] = function (...a) { bump(); return f.apply(this, a); };
            };
            wrap(window, 'fetch'); wrap(window, 'open'); wrap(history, 'pushState'); wrap(history, 'replaceState'); wrap(document, 'execCommand');
            wrap(XMLHttpRequest.prototype, 'send'); wrap(WebSocket.prototype, 'send'); wrap(HTMLDialogElement.prototype, 'showModal');
            wrap(HTMLInputElement.prototype, 'click'); wrap(HTMLInputElement.prototype, 'showPicker'); wrap(HTMLAnchorElement.prototype, 'click');
            if (navigator.clipboard) { wrap(navigator.clipboard, 'writeText'); wrap(navigator.clipboard, 'write'); }
          }`);
      };
      await watch(page.context());
      // Pages a test opens besides its own (an invited person's browser, a
      // phone beside the laptop): their coverage counted too. It is taken
      // before such a page or its browser closes (the Invite and the
      // authenticator setup read 0% while tests used them in other contexts).
      const others: { p: import('@playwright/test').Page; s: import('@playwright/test').CDPSession }[] = [];
      const coverPage = async (p: import('@playwright/test').Page) => {
        if (!cdp || p === page) return;
        const s = await p.context().newCDPSession(p).catch(() => null);
        if (!s) return;
        await s.send('Profiler.enable').catch(() => {});
        await s.send('Profiler.startPreciseCoverage', { callCount: false, detailed: false }).catch(() => {});
        others.push({ p, s });
        const close = p.close.bind(p);
        p.close = async (o) => {
          if (current) await takeFrom(s, current.taken);
          return close(o);
        };
      };
      const coverContext = (c: import('@playwright/test').BrowserContext) => {
        if (!cdp) return;
        c.on('page', (p) => void coverPage(p));
        const close = c.close.bind(c);
        c.close = async (o) => {
          if (current) for (const x of others.filter((x) => x.p.context() === c && !x.p.isClosed())) await takeFrom(x.s, current.taken);
          return close(o);
        };
      };
      coverContext(page.context());
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (o) => {
        // Without motion unless asked for, as the config's own contexts.
        const c = await newContext({ reducedMotion: 'reduce', ...o });
        await watch(c);
        coverContext(c);
        return c;
      };
      await use();
      browser.newContext = newContext;
      const name = info.testId;
      mkdirSync(join(RESULTS, 'pressed'), { recursive: true });
      writeFileSync(join(RESULTS, 'pressed', `${name}.json`), JSON.stringify([...pressed]));
      if (cdp && current) {
        for (const x of others) if (!x.p.isClosed()) await takeFrom(x.s, current.taken);
        await flushCoverage();
        const { taken } = current;
        current = null;
        await cdp.detach().catch(() => {});
        // Each bundle once, with its source as served.
        const entries = [];
        for (const [url, fns] of taken) {
          const res = await page.request.get(url).catch(() => null);
          if (res?.ok()) entries.push({ url, source: await res.text(), functions: [...fns.values()].sort((a, b) => a.ranges[0]!.startOffset - b.ranges[0]!.startOffset || b.ranges[0]!.endOffset - a.ranges[0]!.endOffset) });
        }
        if (entries.length) await new CoverageReport(COVERAGE_OPTIONS).add(entries as never);
      }
    },
    { auto: true },
  ],
});
