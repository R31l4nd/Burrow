import { describe, expect, it } from 'vitest';
import { issueUrl, PROJECT_URL, projectPublished, type BugReportDetail } from './bugreport.js';

const report = (o: Partial<BugReportDetail> = {}): BugReportDetail => ({
  id: '2026-10-04-12-00-00-abcdef',
  at: '2026-10-04T12:00:00.000Z',
  role: 'admin',
  serverVersion: '1.8.0',
  text: 'The terminal shows nothing\nafter I paste a long log.',
  context: {
    page: '#/term/abc',
    dialog: null,
    appVersion: '1.8.0',
    androidApp: '1.8.0',
    userAgent: 'Mozilla/5.0 (Linux; Android 15)',
    viewport: { width: 412, height: 915, dpr: 2.6 },
    locale: 'nl',
    theme: 'dark',
    android: true,
    online: true,
    errors: ['TypeError: x is undefined'],
    failedCalls: [{ method: 'POST', path: '/api/terminal/sessions', status: 502, code: 'ssh_failed', at: '12:00:00' }],
  },
  pictures: ['screenshot.png'],
  recording: { entries: 40, withText: true },
  ...o,
});

describe('the public repository', () => {
  it('is known once the export filled in its owner, not while the placeholder is there (W-FUNC-15)', () => {
    expect(projectPublished('https://github.com/someone/burrow')).toBe(true);
    // In parts, as in the code: the export fills in every whole placeholder.
    expect(projectPublished(`https://github.com/${['OWNER', 'burrow'].join('/')}`)).toBe(false);
    expect(projectPublished()).toBe(!PROJECT_URL.includes(['OWNER', 'burrow'].join('/')));
  });
});

describe('a problem report as a GitHub issue', () => {
  it("fills in the form's fields, the first line as the title", () => {
    const u = new URL(issueUrl(report(), 'https://github.com/someone/burrow'));
    expect(u.origin + u.pathname).toBe('https://github.com/someone/burrow/issues/new');
    const q = u.searchParams;
    expect(q.get('template')).toBe('bug_report.yml');
    expect(q.get('title')).toBe('Problem: The terminal shows nothing');
    expect(q.get('what')).toBe('The terminal shows nothing\nafter I paste a long log.');
    expect(q.get('where')).toContain('Burrow 1.8.0 (web app 1.8.0), Android app 1.8.0');
    expect(q.get('where')).toContain('Screen 412x915 at 2.6x, nl, theme dark');
    expect(q.get('details')).toContain('- POST /api/terminal/sessions -> 502 ssh_failed');
    expect(q.get('details')).toContain('- TypeError: x is undefined');
  });

  it('leaves the pictures and the recording out, and stays within an address GitHub takes', () => {
    const u = issueUrl(report({ text: 'x'.repeat(10_000) }));
    expect(u.startsWith(`${PROJECT_URL}/issues/new?`)).toBe(true);
    expect(u).not.toContain('screenshot');
    expect(u).not.toContain('recording');
    expect(u.length).toBeLessThan(8000);
    expect(new URL(u).searchParams.get('what')).toContain('[... cut short]');
  });

  it('an emoji at the cut, or text that grows when encoded, never breaks or overruns the address (AUDIT2 AI-08, AI-14)', () => {
    // Odd lengths of emoji: a cut by code units fell between the two halves, and encodeURIComponent threw.
    for (const n of [1999, 2000, 2981, 2990]) {
      expect(() => issueUrl(report({ text: '\u{1F600}'.repeat(n) }))).not.toThrow();
    }
    const u = issueUrl(report({ text: '\u{1F600}'.repeat(4000) }));
    expect(u.length).toBeLessThan(8000);
    // Punctuation that is three times as long encoded.
    expect(issueUrl(report({ text: '%&#'.repeat(3000) })).length).toBeLessThan(8000);
    expect(() => issueUrl(report({ text: `${'a'.repeat(79)}\u{1F600} title` }))).not.toThrow();
  });
});
