// JSON-RPC over stdio as language servers speak it: each message is a
// "Content-Length: N" header, a blank line and N bytes of UTF-8 JSON.

export function encode(json: string): Buffer {
  const body = Buffer.from(json, 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/** The largest message passed on; a header longer than this many bytes is no header (AUDIT2 FS-20). */
export const MAX_MESSAGE = 32 << 20;
const MAX_HEADER = 64 << 10;

/** Incremental decoder: feed chunks, get whole messages. Throws past the limits; the bridge then stops the server. */
export class Decoder {
  #buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out: string[] = [];
    for (;;) {
      const end = this.#buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (this.#buf.length > MAX_HEADER) throw new Error('language server header without an end');
        break;
      }
      const header = this.#buf.subarray(0, end).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Not a header we understand: drop it and resynchronise.
        this.#buf = this.#buf.subarray(end + 4);
        continue;
      }
      const len = Number(m[1]);
      if (len > MAX_MESSAGE) throw new Error(`language server message too large (${len} bytes)`);
      if (this.#buf.length < end + 4 + len) break;
      out.push(this.#buf.subarray(end + 4, end + 4 + len).toString('utf8'));
      this.#buf = this.#buf.subarray(end + 4 + len);
    }
    return out;
  }
}
