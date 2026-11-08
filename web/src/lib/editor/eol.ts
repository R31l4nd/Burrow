// The editor holds every line end as "\n" (CodeMirror splits on \r\n, \r and
// \n alike); a file written on Windows is saved with its own "\r\n" again,
// not rewritten line by line.

/** The line end a text uses most: "\r\n" for a file written on Windows, else "\n". */
export function lineEnd(text: string): '\n' | '\r\n' {
  const crlf = text.split('\r\n').length - 1;
  const lf = text.split('\n').length - 1 - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** A text as the editor holds it: every line end "\n". */
export const asEditor = (text: string): string => text.replace(/\r\n?/g, '\n');

/** The editor's text with the file's own line ends. */
export const withLineEnd = (text: string, eol: '\n' | '\r\n'): string => (eol === '\n' ? text : text.replace(/\n/g, eol));
