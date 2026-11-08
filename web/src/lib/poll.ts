// A page's numbers read now and every so often while it is open (a host's statistics). A read that
// takes longer than the interval is not joined by a second one (they piled up on a slow host), and
// no answer comes after the stop (the page left, or reading anew): a late one never replaces a
// newer one (audit 2026-11-05).

/** Starts reading; returns the stop. */
export function pollEvery<T>(read: () => Promise<T>, everyMs: number, onAnswer: (v: T) => void, onError: (err: unknown) => void): () => void {
  let busy = false;
  let stopped = false;
  const go = () => {
    busy = true;
    read()
      .then(
        (v) => !stopped && onAnswer(v),
        (err: unknown) => !stopped && onError(err),
      )
      .finally(() => (busy = false));
  };
  const timer = setInterval(() => !busy && go(), everyMs);
  go();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
