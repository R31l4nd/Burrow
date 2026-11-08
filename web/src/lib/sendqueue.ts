/**
 * What a terminal sends, in order: a part may wait a moment (an Enter a
 * moment after its text), and whatever comes meanwhile waits behind it.
 * Each with a timer of its own, two quick sends ("ls" Enter, "pwd" Enter)
 * could interleave into another command (AUDIT2 TERM-05).
 */
export function sendQueue(send: (data: string) => void) {
  const waiting: { data: string; delay: number }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const drain = () => {
    while (waiting.length) {
      const next = waiting[0]!;
      if (next.delay > 0) {
        timer = setTimeout(() => {
          timer = null;
          next.delay = 0;
          drain();
        }, next.delay);
        return;
      }
      waiting.shift();
      send(next.data);
    }
  };
  return {
    /** Now, unless something still waits: then after it. */
    now(data: string) {
      if (waiting.length) waiting.push({ data, delay: 0 });
      else send(data);
    },
    /** `delay` ms after what was sent or queued last. */
    after(data: string, delay: number) {
      waiting.push({ data, delay });
      if (!timer) drain();
    },
    /** The view goes (the session stays): what waits goes out now, it was sent by the person. */
    flush() {
      if (timer) clearTimeout(timer);
      timer = null;
      for (const w of waiting.splice(0)) send(w.data);
    },
  };
}
