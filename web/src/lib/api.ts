import { t } from './i18n/index.svelte.js';
import { en, type MessageKey } from './i18n/en.js';
import type { ApiError } from '@burrow/shared';

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

// Set by the app shell: shows the step-up dialog and resolves true when the
// user confirmed. The failed request is then retried once.
let stepUpHandler: (() => Promise<boolean>) | null = null;
export function onStepUpRequired(fn: () => Promise<boolean>): void {
  stepUpHandler = fn;
}

// Set by the app shell: the session is gone (expired or revoked elsewhere).
let unauthenticatedHandler: (() => void) | null = null;
export function onUnauthenticated(fn: () => void): void {
  unauthenticatedHandler = fn;
}

/**
 * The last API calls that failed, for a problem report: method, path (not
 * the query: it can hold paths the person browses), status, error code.
 */
export const recentFailures: { method: string; path: string; status: number; code: string; at: string; handled?: boolean }[] = [];
function noteFailure(method: string, url: string, status: number, code: string, handled = false): void {
  recentFailures.push({ method, path: url.split('?')[0]!.slice(0, 300), status, code: code.slice(0, 80), at: new Date().toISOString(), ...(handled ? { handled } : {}) });
  if (recentFailures.length > 30) recentFailures.shift();
}

// A read that never answers (a proxy holding the connection) gives up after this long: retries and
// "try again" waited on it for ever (AUDIT2 WEB-06). Changes may take long on purpose (an update
// window, a large upload) and are not cut off.
const READ_TIMEOUT_MS = 120_000;

async function raw(method: string, url: string, body?: unknown): Promise<Response> {
  const stop = new AbortController();
  const timer = method === 'GET' ? setTimeout(() => stop.abort(new DOMException('no answer in time', 'TimeoutError')), READ_TIMEOUT_MS) : null;
  try {
    return await fetchOnce(url, method, body, stop.signal);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fetchOnce(url: string, method: string, body: unknown, signal: AbortSignal): Promise<Response> {
  return fetch(url, {
    method,
    signal,
    credentials: 'same-origin',
    // Never from the HTTP cache: a proxy's own page, served once while Burrow
    // restarted, was cached by the app's WebView for this URL and answered
    // every later request (the Terminal tab stayed broken).
    cache: 'no-store',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// A setting saved as it changes (a checkbox, a time) can change twice
// before the first save is answered; sent side by side, the two could reach
// the server the wrong way round and leave the first one saved. Saves to
// one address go one after the other.
const putQueues = new Map<string, Promise<unknown>>();

// Which account the requests are made for: bumped when another one signs in, or none. A save still
// waiting its turn went out with the next account's cookie (AUDIT2 WEB-02).
let account = 0;
export function newAccount(): void {
  account++;
}
/** Throws when another account signed in since `asked` was taken (account()). */
export const currentAccount = (): number => account;
export function sameAccount(asked: number): void {
  if (asked !== account) throw new ApiFailure(0, 'signed_out', t('common.signedOutMeanwhile'));
}

export function api<T = void>(method: string, url: string, body?: unknown, handled: readonly string[] = []): Promise<T> {
  if (method !== 'PUT') return send<T>(method, url, body, handled);
  const asked = account;
  const next = (putQueues.get(url) ?? Promise.resolve())
    .catch(() => {})
    .then(() => {
      sameAccount(asked);
      return send<T>(method, url, body);
    });
  putQueues.set(url, next);
  void next.finally(() => putQueues.get(url) === next && putQueues.delete(url)).catch(() => {});
  return next;
}

async function send<T>(method: string, url: string, body?: unknown, handled: readonly string[] = []): Promise<T> {
  let res: Response;
  try {
    res = await raw(method, url, body);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') throw new ApiFailure(0, 'timeout', t('common.noAnswer'));
    throw err;
  }
  // Too many requests: a read waits as told and asks again (twice at most),
  // rather than a page failing on a burst. Changes are not repeated.
  for (let n = 0; res.status === 429 && method === 'GET' && n < 2; n++) {
    const wait = Math.min(10, Number(res.headers.get('retry-after')) || 2);
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await raw(method, url, body);
  }
  if (res.status === 403 && stepUpHandler) {
    const err = (await res.clone().json().catch(() => null)) as ApiError | null;
    if (err?.error === 'step_up_required') {
      if (await stepUpHandler()) res = await raw(method, url, body);
      // Closed on purpose: nothing went wrong to tell (report 1d2fd4), and no
      // page takes it for a failure to show; errorMessage says nothing.
      else throw new ApiFailure(403, 'step_up_cancelled', '');
    }
  }
  if (res.status === 204) return undefined as T;
  // A body that broke off is no answer: not an empty one, and a change not seen to be saved (AUDIT2 WEB-03).
  let text: string;
  try {
    text = await res.text();
  } catch {
    noteFailure(method, url, res.status, 'read_failed');
    throw new ApiFailure(0, 'read_failed', t('common.noAnswer'));
  }
  // An empty 200 to a read is not Burrow's (it always says something); a change may answer with nothing.
  if (!text && res.ok && method === 'GET') {
    noteFailure(method, url, res.status, 'empty_answer');
    throw new ApiFailure(502, 'empty_answer', t('common.notBurrow'));
  }
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not Burrow's answer (a proxy's page while Burrow restarts): an error,
    // never data, so a page does not take it for an empty list.
    if (res.ok) {
      noteFailure(method, url, res.status, 'not_json');
      throw new ApiFailure(502, 'not_json', t('common.notBurrow'));
    }
  }
  if (!res.ok) {
    const err = (data ?? {}) as Partial<ApiError>;
    noteFailure(method, url, res.status, err.error ?? `http_${res.status}`, !!err.error && handled.includes(err.error));
    if (res.status === 401 && err.error === 'unauthenticated') unauthenticatedHandler?.();
    // Not Burrow's answer (a proxy's 502 while Burrow restarts): said in words, the status small in it (A3-WEB-05).
    if (!err.error) throw new ApiFailure(res.status, 'http_' + res.status, t('common.notAnswering', { status: res.status }));
    throw new ApiFailure(res.status, err.error, err.message);
  }
  return data as T;
}

/**
 * `handled`: error codes the page answers itself, with what to do next (a file only root may read:
 * "Open with sudo"). A problem report lists them as handled, not as something that broke
 * (report 9d710d: the editor's first read of a root-owned file read as a failure).
 */
export const get = <T>(url: string, handled?: readonly string[]) => api<T>('GET', url, undefined, handled);
export const post = <T = void>(url: string, body?: unknown) => api<T>('POST', url, body ?? {});
export const put = <T = void>(url: string, body?: unknown) => api<T>('PUT', url, body ?? {});
export const del = <T = void>(url: string) => api<T>('DELETE', url);

/** The parts of a message a template ("No access to {path} on this host.") was filled in with; null when it is not that template's. */
export function fromTemplate(template: string, message: string): Record<string, string> | null {
  const names: string[] = [];
  const pattern = template.split(/(\{\w+\})/).map((part) => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    names.push(m[1]!);
    return '([\\s\\S]+?)';
  });
  const found = new RegExp(`^${pattern.join('')}$`).exec(message);
  return found ? Object.fromEntries(names.map((n, i) => [n, found[i + 1]!])) : null;
}

/**
 * A library's or the network's own words, said in Burrow's (W-FUNC-06: "connect ECONNREFUSED
 * 172.23.0.7:2525", "Timed out while waiting for handshake" reached the screen as they were).
 */
export function transportWords(message: string): string {
  return message
    .replace(/\b(?:connect )?ECONNREFUSED ([\w.:-]+?):(\d+)\b/g, (_, host: string, port: string) => t('error.net.refused', { host, port }))
    .replace(/\b(?:connect |getaddrinfo )?(?:ETIMEDOUT|ETIMEOUT)(?: ([\w.:-]+?):(\d+))?\b/g, (_, host?: string, port?: string) => (host ? t('error.net.timeout', { host, port: port ?? '' }) : t('error.net.timeoutAny')))
    .replace(/\bgetaddrinfo (?:ENOTFOUND|EAI_AGAIN) ([\w.-]+)/g, (_, host: string) => t('error.net.unknownName', { host }))
    // The whole name or address: a lazy match stopped at its first dot (report 8b783c).
    .replace(/\b(?:connect )?EHOSTUNREACH ([\w.-]+)(?::\d+)?/g, (_, host: string) => t('error.net.noRoute', { host }))
    .replace(/\bTimed out while waiting for handshake\b/g, t('error.net.handshake'))
    .replace(/\bAll configured authentication methods failed\b/g, t('error.net.authFailed'));
}

/**
 * Burrow's own words for an error, in the app's language (A3-WEB-13, W-FUNC-06): the catalogue
 * holds each code's sentences as the server writes them, the parts that vary as {placeholders}
 * (variants as error.<code>.<n>); words of the host's or a library's own are said within a
 * sentence of ours ("sudo did not work: {detail}").
 */
function serverWords(code: string, message: string): string | null {
  const base = `error.${code}`;
  const keys = [base, ...Object.keys(en).filter((k) => k.startsWith(`${base}.`))].filter((k): k is MessageKey => k in en);
  if (!keys.length) return null;
  if (message === code || !message) return keys[0] === base ? t(keys[0]) : null;
  for (const k of keys) {
    if (en[k] === message) return t(k);
    const parts = /\{\w+\}/.test(en[k]) ? fromTemplate(en[k], message) : null;
    if (parts) return t(k, Object.fromEntries(Object.entries(parts).map(([n, v]) => [n, transportWords(v)])));
  }
  const detail = keys.find((k) => /^[^{}]*\{detail\}[^{}]*$/.test(en[k]));
  return detail ? t(detail, { detail: transportWords(message) }) : null;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiFailure && err.code === 'step_up_cancelled') return '';
  if (err instanceof ApiFailure) {
    // A code without words of its own: the code as words.
    return serverWords(err.code, err.message) ?? (err.message !== err.code ? transportWords(err.message) : err.code.replace(/_/g, ' '));
  }
  // fetch's own words ("Failed to fetch", "Load failed", "NetworkError..."):
  // no answer at all, said the same way in every browser.
  if (err instanceof TypeError && /failed to fetch|load failed|networkerror|network error/i.test(err.message)) return t('common.noConnection');
  return err instanceof Error ? err.message : String(err);
}

/**
 * Words that say Burrow itself did not answer: no connection at all, or its proxy's 502-504
 * ("not answering"). The hosts may still be reached another way (the app's direct route).
 */
export function burrowAway(message: string): boolean {
  const notAnswering = t('common.notAnswering', { status: '\u0000' }).split('\u0000')[0]!;
  return message === t('common.noConnection') || (!!notAnswering && message.startsWith(notAnswering));
}

/** No answer at all (not an HTTP error): offline, or the app was in the background. */
export const noConnection = (err: unknown): boolean => !(err instanceof ApiFailure) && !(err instanceof DOMException && err.name === 'AbortError');

/** Resolves once the page is in sight again, and a moment later (the network wakes up too). */
export function backInSight(delayMs = 1000): Promise<void> {
  return new Promise((resolve) => {
    const go = () => setTimeout(resolve, delayMs);
    if (!document.hidden) return go();
    const on = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', on);
      go();
    };
    document.addEventListener('visibilitychange', on);
  });
}
