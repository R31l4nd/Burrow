/** Quote one argument for a POSIX shell. */
export const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Quote an argument list; `--` should precede paths so none reads as an option. */
export const shellArgs = (args: string[]): string => args.map(shellQuote).join(' ');
