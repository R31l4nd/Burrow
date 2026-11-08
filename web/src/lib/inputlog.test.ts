import { describe, expect, it } from 'vitest';
import { note, noteEvent, noteTouch, recordedCount, recording } from './inputlog.js';
import { noteKey, termDebug } from './termdebug.js';

// A report's recording of the input: the text only when the person allows it.
describe('the input recording', () => {
  it('leaves the typed text out unless allowed, keeping how long it was', () => {
    note({ e: 'beforeinput', inputType: 'insertText', text: 'hunter2', len: 7, value: 'hunter2' });
    note({ e: 'sent', text: 'sudo\r' });
    note({ e: 'suggestions', n: 3 });
    const without = recording(false);
    expect(JSON.stringify(without)).not.toContain('hunter2');
    expect(JSON.stringify(without)).not.toContain('sudo');
    expect(without.entries.find((x) => x.e === 'beforeinput')).toMatchObject({ inputType: 'insertText', textLength: 7, len: 7 });
    expect(without.entries.find((x) => x.e === 'suggestions')).toMatchObject({ n: 3 });
    const withText = recording(true);
    expect(withText.entries.find((x) => x.e === 'beforeinput')).toMatchObject({ text: 'hunter2', value: 'hunter2' });
  });

  it('without the text, no key codes of letters or digits either (a typed "p" was keyCode 80)', () => {
    note({ e: 'keydown', keyCode: 80, text: 'p' });
    note({ e: 'keydown', keyCode: 49, text: '1' });
    note({ e: 'keydown', keyCode: 13, key: 'Enter' });
    note({ e: 'keydown', keyCode: 229 });
    const keys = recording(false).entries.filter((x) => x.e === 'keydown');
    expect(keys.slice(-4)).toEqual([
      expect.not.objectContaining({ keyCode: expect.anything() }),
      expect.not.objectContaining({ keyCode: expect.anything() }),
      expect.objectContaining({ keyCode: 13, key: 'Enter' }),
      // An IME's "229": says nothing about the key, kept (the replay needs it).
      expect.objectContaining({ keyCode: 229 }),
    ]);
    expect(recording(true).entries.filter((x) => x.e === 'keydown').slice(-4)[0]).toMatchObject({ keyCode: 80, text: 'p' });
  });

  it('real key events, an emoji among them: nothing typed stays without consent, in the recording or the key list of a report (AUDIT2 TERM-01)', () => {
    const key = (k: string, keyCode: number) => Object.assign(new Event('keydown'), { key: k, keyCode, isComposing: false });
    termDebug.keys = [];
    for (const [k, code] of [['s', 83], ['3', 51], ['\u{1F600}', 0], ['Enter', 13]] as const) {
      const e = key(k, code);
      noteEvent(e, null);
      noteKey(e);
    }
    const without = JSON.stringify(recording(false).entries.slice(-4));
    expect(without).not.toContain('\u{1F600}');
    expect(without).not.toMatch(/"key":"[s3]"|"keyCode":(83|51)/);
    expect(without).toContain('"key":"Enter"');
    // The report's own list of key kinds: no letter's or digit's code either.
    expect(termDebug.keys).toEqual(['keydown', 'keydown', 'keydown', 'keydown Enter']);
  });
});

describe('touches on the terminal', () => {
  const area = { getBoundingClientRect: () => ({ left: 100, top: 50, width: 400, height: 200 }) } as unknown as Element;
  const touch = (type: string, pts: [number, number][]) => ({ type, touches: pts.map(([clientX, clientY]) => ({ clientX, clientY })), changedTouches: [{ clientX: 500, clientY: 250 }] }) as unknown as TouchEvent;

  it('kept relative to the terminal (a replay on another screen size puts them in the same place); the end where the finger left', () => {
    const before = recordedCount();
    noteTouch(touch('touchstart', [[200, 100], [300, 150]]), area);
    noteTouch(touch('touchend', []), area);
    const rec = recording(false).entries.filter((x) => x.e === 'touchstart' || x.e === 'touchend').slice(-2);
    expect(rec.map((x) => [x.e, x.points])).toEqual([
      ['touchstart', [[0.25, 0.25], [0.5, 0.5]]],
      ['touchend', [[1, 1]]],
    ]);
    expect(recordedCount()).toBe(before + 2);
  });

  it('nothing kept without a terminal of some size to be relative to', () => {
    const before = recordedCount();
    noteTouch(touch('touchstart', [[1, 1]]), null);
    noteTouch(touch('touchstart', [[1, 1]]), { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) } as unknown as Element);
    expect(recordedCount()).toBe(before);
  });
});
