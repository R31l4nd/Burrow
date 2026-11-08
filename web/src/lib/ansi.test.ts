import { describe, expect, it } from 'vitest';
import { ansiLines, ansiToHtml, softBreaks, stripAnsi } from './ansi.js';

describe('ansi', () => {
  it('turns colours into spans and escapes the text', () => {
    expect(ansiToHtml('\x1b[31mred\x1b[0m <b>')).toBe('<span style="color:var(--ansi-1)">red</span> &lt;b&gt;');
    expect(ansiToHtml('\x1b[1;38;5;196mX')).toBe('<span style="color:rgb(255,0,0);font-weight:700">X</span>');
  });

  it('never lets a line become markup', () => {
    expect(ansiToHtml('<img src=x onerror=alert(1)>')).not.toContain('<img');
    expect(ansiToHtml('\x1b[31m"><script>')).not.toContain('<script');
  });

  it('strips codes for search', () => {
    expect(stripAnsi('\x1b[32mINFO\x1b[0m ok')).toBe('INFO ok');
  });

  it('a hyperlink, a title and other escapes show nothing, terminated or not (AUDIT2 TERM-19)', () => {
    const link = '\x1b]8;;https://example.com\x1b\\docs\x1b]8;;\x1b\\';
    expect(stripAnsi(`see ${link} now`)).toBe('see docs now');
    expect(ansiToHtml(`\x1b]0;my title\x07\x1b[31mred\x1b[0m`)).toBe('<span style="color:var(--ansi-1)">red</span>');
    expect(stripAnsi('\x1b[?25l\x1b[2 qok\x1b(B\x1b=')).toBe('ok');
    expect(stripAnsi('cut \x1b]0;never ends')).toBe('cut ');
  });

  it("a long dotted or slashed name may wrap after its dots and slashes, not between two letters (the live Burrow's Jellyfin logs)", () => {
    expect(softBreaks('IntroSkipper.ScheduledTasks.BaseItemAnalyzerTask: ok')).toBe('IntroSkipper.<wbr>ScheduledTasks.<wbr>BaseItemAnalyzerTask: ok');
    expect(softBreaks('/srv/media/Series/x_y')).toBe('/srv/<wbr>media/<wbr>Series/<wbr>x_<wbr>y');
    // Never inside a tag or an entity, and a full stop at the end of a sentence stays as it is.
    expect(softBreaks('<span style="color:#f00">a.b</span> &amp;c. Done.')).toBe('<span style="color:#f00">a.<wbr>b</span> &amp;c. Done.');
  });

  it("carries a colour from one line of a terminal's history to the next, escaped, reversed and struck too", () => {
    // tmux's capture-pane -e sets a colour once for a run of lines.
    expect(ansiLines('\x1b[32mone\ntwo\x1b[0m\nthree <i>')).toEqual(['<span style="color:var(--ansi-2)">one</span>', '<span style="color:var(--ansi-2)">two</span>', 'three &lt;i&gt;']);
    expect(ansiLines('\x1b[7mbar\x1b[27m')).toEqual(['<span style="color:var(--bg-sunken);background:var(--text)">bar</span>']);
    expect(ansiLines('\x1b[4;9mx')).toEqual(['<span style="text-decoration:underline line-through">x</span>']);
    expect(ansiLines('a\n\nb')).toEqual(['a', '', 'b']);
  });
});
