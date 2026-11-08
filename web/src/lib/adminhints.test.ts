import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' } } });
});
const { hints, hintsToFix, loadHints } = await import('./hints.svelte.js');
const { alertState, loadAlertCount } = await import('./alerts.svelte.js');
const { followTheme, termTheme } = await import('./termtheme.js');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

// What an admin should fix (decision 12, OPS-W-02): told only for a proxy
// TRUST_PROXY does not name or a full disk, not for open reports alone.
describe('admin hints', () => {
  it('a proxy not named or a full disk is something to fix; open reports alone are not', async () => {
    expect(hintsToFix()).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => json({ trustProxy: null, diskFull: false, openReports: 3 })));
    await loadHints();
    expect(hints.h?.openReports).toBe(3);
    expect(hintsToFix()).toBe(false);
    vi.stubGlobal('fetch', vi.fn(async () => json({ trustProxy: { proxies: ['172.18.0.4'], current: '172.18.0.9', suggest: '172.18.0.0/16' }, diskFull: false, openReports: 0 })));
    await loadHints();
    expect(hintsToFix()).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => json({ trustProxy: null, diskFull: true, openReports: 0 })));
    await loadHints();
    expect(hintsToFix()).toBe(true);
  });
});

describe('unread alerts', () => {
  it('counts what the server says, and keeps the last count when it cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ n: 4 })));
    await loadAlertCount();
    expect(alertState.unread).toBe(4);
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'internal', message: 'boom' }, 500)));
    await loadAlertCount();
    expect(alertState.unread).toBe(4);
  });
});

describe("the terminal's colours", () => {
  it('come from the page theme, the ANSI ones included, the selection see-through', () => {
    const vars: Record<string, string> = { '--bg-sunken': '#101010', '--text': '#eeeeee', '--accent': '#1a7f37', '--ansi-1': '#cc0000', '--ansi-9': '#ff5555' };
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (n: string) => ` ${vars[n] ?? ''} ` }));
    const th = termTheme() as Record<string, string>;
    expect(th).toMatchObject({ background: '#101010', foreground: '#eeeeee', cursor: '#1a7f37', red: '#cc0000', brightRed: '#ff5555' });
    expect(th.selectionBackground).toBe('#1a7f3766');
    // A colour that is not "#rrggbb" stays as it is.
    vars['--accent'] = 'rgb(1, 2, 3)';
    expect((termTheme() as Record<string, string>).selectionBackground).toBe('rgb(1, 2, 3)');
  });
});

describe("a terminal's colours follow the theme", () => {
  it('a new theme or a change of the system scheme gives new colours; the stop lets go of both', () => {
    let observed: (() => void) | null = null;
    let disconnected = false;
    const scheme: Record<string, () => void> = {};
    vi.stubGlobal('document', { documentElement: { lang: 'en' } });
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor(cb: () => void) {
          observed = cb;
        }
        observe() {}
        disconnect() {
          disconnected = true;
        }
      },
    );
    vi.stubGlobal('matchMedia', () => ({ addEventListener: (_: string, f: () => void) => (scheme.change = f), removeEventListener: (_: string, f: () => void) => scheme.change === f && delete scheme.change }));
    const vars: Record<string, string> = { '--bg-sunken': '#ffffff' };
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (n: string) => vars[n] ?? '' }));
    const term = { options: {} as { theme?: unknown } };
    const stop = followTheme(term);
    vars['--bg-sunken'] = '#101010';
    observed!();
    expect((term.options.theme as { background: string }).background).toBe('#101010');
    vars['--bg-sunken'] = '#202020';
    scheme.change!();
    expect((term.options.theme as { background: string }).background).toBe('#202020');
    stop();
    expect(disconnected).toBe(true);
    expect(scheme.change).toBeUndefined();
  });
});
