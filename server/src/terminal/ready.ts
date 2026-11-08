/** What the shell's channel needs to be typed into once the shell is ready. */
interface Typable {
  on(event: 'data', listener: (d: Buffer) => void): unknown;
  off(event: 'data', listener: (d: Buffer) => void): unknown;
  write(text: string): unknown;
}

/**
 * Typed into a new shell once it is ready: after its first output (the
 * message of the day, the prompt) and a quiet moment, or at the latest after
 * `maxMs`, or at once when a viewer types first (the function returned). Typed at once, the terminal echoed the line before the shell took
 * the keyboard, and the shell showed it again after its prompt: `cd -- '/data'`
 * twice in a workspace's terminal (report 597e6b).
 */
export function typeWhenReady(channel: Typable, text: string, quietMs = 300, maxMs = 4000): () => void {
  let quiet: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const type = () => {
    if (done) return;
    done = true;
    clearTimeout(quiet);
    clearTimeout(latest);
    channel.off('data', onData);
    channel.write(text);
  };
  const onData = () => {
    clearTimeout(quiet);
    quiet = setTimeout(type, quietMs);
  };
  const latest = setTimeout(type, maxMs);
  channel.on('data', onData);
  // Typed now, before what a viewer types first: after it, the person's command ran in the wrong folder.
  return type;
}
