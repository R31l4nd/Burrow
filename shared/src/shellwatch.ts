import type { ShellState } from './terminal.js';

// The shell integration's escape sequences (server/assets/shell-integration.sh),
// read from a terminal's output: OSC 133 (prompt and command marks), OSC 7
// (working directory) and OSC 6973 (P: the prompt line, E: a finished
// command). Used by the server's headless terminal and by the Android app's
// direct route, which has no server to read them.

export interface OscParser {
  registerOscHandler(ident: number, callback: (data: string) => boolean | Promise<boolean>): unknown;
}

export interface ShellWatch {
  patch(p: Partial<ShellState>): void;
  command?(command: string): void;
  /**
   * A command starts (OSC 133;C): whether the command report right after it may count. Any output
   * can carry these sequences (a file shown with cat, a log line, the motd), and a forged report
   * put any command into the history and its suggestions (A3-SRV-13). The server answers yes once
   * per Enter typed; without it, every report counts.
   */
  commandStart?(): boolean;
}

export function watchShell(parser: OscParser, decodeBase64: (b64: string) => string | null, on: ShellWatch): void {
  // bash reports its history number; the same number again means the command
  // was not added (ignorespace) and `history 1` repeated the previous one.
  let lastHistNum: string | null = null;
  // Whether a command report may count now: after a command start the gate let through, once.
  const gated = !!on.commandStart;
  let armed = !gated;
  parser.registerOscHandler(133, (data) => {
    const kind = data[0];
    if (kind === 'A') on.patch({ integration: true, atPrompt: false });
    else if (kind === 'B') on.patch({ integration: true, atPrompt: true });
    else if (kind === 'C' || kind === 'D') on.patch({ integration: true, atPrompt: false });
    if (gated && kind === 'C') armed = on.commandStart!();
    else if (gated && kind === 'D') armed = false;
    return true;
  });
  parser.registerOscHandler(7, (data) => {
    const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
    if (m) {
      let path = m[1]!;
      try {
        path = decodeURIComponent(path);
      } catch {
        // Keep as reported.
      }
      on.patch({ cwd: path });
    }
    return true;
  });
  parser.registerOscHandler(6973, (data) => {
    const [kind, a, b] = data.split(';');
    if (kind === 'P' && a !== undefined) on.patch({ integration: true, prompt: decodeBase64(a) });
    if (kind === 'E' && a !== undefined && b !== undefined) {
      if (!armed) return true;
      if (gated) armed = false;
      if (a !== '0' && a === lastHistNum) return true;
      if (a !== '0') lastHistNum = a;
      const cmd = decodeBase64(b);
      if (cmd) on.command?.(cmd);
    }
    return true;
  });
}
