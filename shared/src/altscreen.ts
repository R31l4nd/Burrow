// Without tmux on the host (a session "lost on restart"), programs that
// switch to the alternate screen (a tmux or vim of your own) hid everything
// before them: the alternate screen has no scrollback, so there was nothing
// to scroll back to. Burrow's own tmux turns the alternate screen off for the
// same reason (smcup@/rmcup@, server/src/terminal/manager.ts); here the switches are taken out
// of the stream, so both kinds of session scroll the same way.

// DEC private modes 47, 1047 and 1049, set or reset, also in a list with
// others ("?25;1049h"): taken out of it, the others kept (AUDIT2 AI-16).
// eslint-disable-next-line no-control-regex
const PRIVATE = /\x1b\[\?([0-9;]*)([hl])/g;
const ALT = new Set(['47', '1047', '1049']);
// A private-mode sequence cut at the end of a chunk (short: a longer one is not one).
// eslint-disable-next-line no-control-regex
const PARTIAL = /\x1b(?:\[(?:\?[0-9;]{0,24})?)?$/;

export class AltScreenFilter {
  #carry = '';
  /** A program is on its alternate screen now (less, vim): a scroll goes to it as arrow keys. */
  on = false;

  /** The chunk without the switches; a sequence cut at the end waits for the next chunk. */
  write(chunk: string): string {
    let text = this.#carry + chunk;
    this.#carry = '';
    const cut = PARTIAL.exec(text);
    if (cut) {
      this.#carry = cut[0];
      text = text.slice(0, cut.index);
    }
    return text.replace(PRIVATE, (all, list: string, end: string) => {
      const modes = list.split(';');
      if (!modes.some((m) => ALT.has(m))) return all;
      this.on = end === 'h';
      const rest = modes.filter((m) => !ALT.has(m));
      return rest.length ? `\x1b[?${rest.join(';')}${end}` : '';
    });
  }
}
