import { describe, expect, it } from 'vitest';
import { contentDisposition } from '../../src/http.js';

// A download's name reaches every client: browsers read `filename*`, but
// Android's URLUtil.guessFileName reads only `filename` and else names the
// file after the address ("raw.bin", report 1fb877).
describe('a download name (report 1fb877)', () => {
  it('names a download in ASCII for clients that cannot read filename*, then exactly (RFC 6266)', () => {
    expect(contentDisposition('attachment', 'report.pdf')).toBe('attachment; filename="report.pdf"');
    expect(contentDisposition('inline', 'photo 1.jpg')).toBe('inline; filename="photo 1.jpg"');
    expect(contentDisposition('attachment', 'r\u00e9sum\u00e9.txt')).toBe(`attachment; filename="r_sum_.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9.txt`);
    // Quotes, backslashes, percent signs and control characters never reach the quoted name.
    expect(contentDisposition('attachment', 'a"b\\c%d\u0007e\u007f.log')).toBe(`attachment; filename="a_b_c_d_e_.log"; filename*=UTF-8''a%22b%5Cc%25d%07e%7F.log`);
    // RFC 5987 attr-chars only: what encodeURIComponent leaves (' ( ) *) is encoded too.
    expect(contentDisposition('attachment', "it's (1)*.txt")).toBe(`attachment; filename="it's (1)*.txt"`);
    expect(contentDisposition('attachment', "\u00e9'(1)*")).toBe(`attachment; filename="_'(1)*"; filename*=UTF-8''%C3%A9%27%281%29%2A`);
  });
});
