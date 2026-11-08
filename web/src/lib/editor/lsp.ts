import type { Transport } from '@codemirror/lsp-client';

// A WebSocket to Burrow's language-server bridge. Each editor has its own id,
// so a reconnect finds the same server process again.

/** The bridge's refusal, read from its close (4404, with "Close an editor first." at the limit per person); none for a connection that went. */
export type Refusal = 'too_many' | 'refused';
const refusal = (e: { code?: number; reason?: string } | undefined): Refusal | undefined =>
  e?.code === 4404 || e?.code === 4400 ? (/close an editor/i.test(e.reason ?? '') ? 'too_many' : 'refused') : undefined;

/** No answer from the bridge in this time: given up on. */
const OPEN_TIMEOUT_MS = 15_000;

/**
 * Settles once: open, or failed (an error, closed before it opened, too
 * slow, or `signal` aborted because the editor went). Whatever does not
 * become the editor's is closed here, so nothing stays connected without
 * an owner (audit WL-09).
 */
export function lspTransport(lang: string, editorId: string, onState: (s: 'open' | 'closed', why?: Refusal) => void, signal?: AbortSignal): Promise<Transport & { close(): void }> {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/lsp/${lang}/ws?editor=${editorId}`);
  let handlers: ((value: string) => void)[] = [];
  ws.onmessage = (e) => {
    for (const h of handlers) h(String(e.data));
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (why: string) => {
      ws.onclose = null;
      ws.close();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(new Error(why));
    };
    const aborted = () => fail('the editor closed');
    const timer = setTimeout(() => fail('language server too slow'), OPEN_TIMEOUT_MS);
    if (signal?.aborted) return aborted();
    signal?.addEventListener('abort', aborted);
    ws.onerror = () => fail('language server unavailable');
    // Refused by the bridge (4404): its reason, "too_many" for the limit per person.
    ws.onclose = (e) => fail(refusal(e) ?? 'language server closed');
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      // Open now: an error later is followed by its close, which is told.
      // The opening's fail() took the close handler away, and the editor
      // never heard the server went (AUDIT2 TERM-13).
      ws.onerror = null;
      // The bridge accepts the socket and then refuses (its limit per person, no such server):
      // told with why, so the editor does not try again and again (report 76bcda).
      ws.onclose = (e) => onState('closed', refusal(e));
      onState('open');
      resolve({
        send: (message: string) => ws.readyState === WebSocket.OPEN && ws.send(message),
        subscribe: (h) => void handlers.push(h),
        unsubscribe: (h) => void (handlers = handlers.filter((x) => x !== h)),
        close: () => ws.close(),
      });
    };
  });
}
