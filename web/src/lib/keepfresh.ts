// A list of what is on a host read again by itself: when the page is seen again (another tab, another
// window, the phone woken) and every so often while it is seen, so a file made in a terminal shows up
// without a reload (report 905455). Not while hidden, and not twice within a few seconds.

/** Calls read now and then as above; returns the stop. */
export function keepFresh(read: () => void, everyMs = 10_000): () => void {
  let last = Date.now();
  const go = () => {
    if (document.visibilityState !== 'visible' || Date.now() - last < 3000) return;
    last = Date.now();
    read();
  };
  const timer = setInterval(go, everyMs);
  document.addEventListener('visibilitychange', go);
  window.addEventListener('focus', go);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', go);
    window.removeEventListener('focus', go);
  };
}
