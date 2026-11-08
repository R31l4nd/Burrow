// Split a shell input line into words, the way a shell would for completion
// purposes: quotes group, backslash escapes, and only the last simple
// command (after |, &&, ||, ;) matters.

export interface ParsedLine {
  // Finished words of the current command, unquoted.
  tokens: string[];
  // The word being typed (possibly empty), unquoted.
  partial: string;
  // Offset in the line where the current command starts.
  commandStart: number;
  // The quote the word being typed is still open in: a completion goes on in it.
  quote: '"' | "'" | null;
}

const SEPARATORS = ['&&', '||', '|', ';', '&', '(', '$('];

export function parseLine(line: string): ParsedLine {
  let tokens: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  let commandStart = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i];
      inWord = true;
      continue;
    }
    const sep = SEPARATORS.find((s) => line.startsWith(s, i));
    if (sep) {
      tokens = [];
      cur = '';
      inWord = false;
      i += sep.length - 1;
      commandStart = i + 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inWord) tokens.push(cur);
      cur = '';
      inWord = false;
      continue;
    }
    cur += ch;
    inWord = true;
  }
  // Leading environment assignments (FOO=1 cmd) are not the command.
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) tokens.shift();
  return { tokens, partial: inWord ? cur : '', commandStart, quote: inWord ? quote : null };
}
