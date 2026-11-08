import type { TerminalSessionInfo } from '@burrow/shared';
import { ApiFailure, del, get, post, put } from './api.js';
import { ask } from './confirm.svelte.js';
import { t } from './i18n/index.svelte.js';
import { go } from './router.svelte.js';

// Open terminal sessions, from every device. Refreshed when pages need it.

export const terms = $state<{ list: TerminalSessionInfo[] }>({ list: [] });

// The newest read wins: an older answer that comes after it does not put back what it said (AUDIT2 WEB-11).
let sessionsAsked = 0;
export async function loadSessions(): Promise<TerminalSessionInfo[]> {
  const mine = ++sessionsAsked;
  const list = await get<TerminalSessionInfo[]>('/api/terminal/sessions');
  if (mine === sessionsAsked) terms.list = list;
  return list;
}

/** The list read again after a change that did happen: a failing read does not turn that change into a failure (AUDIT2 WEB-12). */
const reread = () => void loadSessions().catch(() => {});

/**
 * One tap on a host: back to its open session if there is one, else a new
 * session (which may ask for a step-up).
 */
export async function connectHost(hostId: number, fresh = false, cwd?: string, tmux?: 'always' | 'never'): Promise<void> {
  if (!fresh && !cwd && !tmux) {
    // The one used last on this host (the list is in the order opened).
    const existing = (await loadSessions()).filter((s) => s.hostId === hostId).sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
    if (existing) return go(`/term/${existing.id}`);
  }
  const s = await newSession(hostId, cwd, tmux);
  go(`/term/${s.id}`);
}

/** A new session on the host (in that folder), the list read again. */
export async function newSession(hostId: number, cwd?: string, tmux?: 'always' | 'never'): Promise<TerminalSessionInfo> {
  const size = estimateSize();
  const s = await post<TerminalSessionInfo>('/api/terminal/sessions', { hostId, ...size, ...(cwd ? { cwd } : {}), ...(tmux ? { tmux } : {}) });
  // Made: in the list at once, the list read again behind it.
  if (!terms.list.some((x) => x.id === s.id)) terms.list = [...terms.list, s];
  reread();
  return s;
}

/** Name a session (empty: its host's name again). */
export async function renameSession(id: string, title: string): Promise<void> {
  await put(`/api/terminal/sessions/${id}/title`, { title });
  terms.list = terms.list.map((x) => (x.id === id ? { ...x, title: title || null } : x));
  reread();
}

/** Who may watch a session, read-only (F3). */
export async function shareSession(id: string, userIds: number[]): Promise<void> {
  const s = await put<TerminalSessionInfo>(`/api/terminal/sessions/${id}/share`, { userIds });
  terms.list = terms.list.map((x) => (x.id === id ? { ...x, sharedWith: s.sharedWith } : x));
  reread();
}

/** Record a session's output from now on, or stop (F3). */
export async function recordSession(id: string, on: boolean): Promise<void> {
  await put(`/api/terminal/sessions/${id}/recording`, { on });
  terms.list = terms.list.map((x) => (x.id === id ? { ...x, recording: on } : x));
  reread();
}

/**
 * Close a session. Its tmux session on a host that cannot be reached (or that
 * did not end) stays open there: asked first whether to forget it anyway
 * (AUDIT2 FS-14). No is a quiet stop, not an error.
 */
export async function closeSession(id: string): Promise<void> {
  try {
    await del(`/api/terminal/sessions/${id}`);
  } catch (err) {
    if (!(err instanceof ApiFailure) || (err.code !== 'host_unreachable' && err.code !== 'not_ended')) throw err;
    if (!(await ask({ text: `${err.message} ${t('term.forgetAsk')}`, confirm: t('term.forget'), danger: true }))) throw new ApiFailure(0, 'step_up_cancelled', '');
    await del(`/api/terminal/sessions/${id}?force=1`);
  }
  terms.list = terms.list.filter((x) => x.id !== id);
  reread();
}

/** A first guess at the terminal size, so the shell starts at about the right width. */
function estimateSize(): { cols: number; rows: number } {
  const fs = prefs.fontSize;
  return {
    cols: Math.max(20, Math.min(300, Math.floor(window.innerWidth / (fs * 0.6)))),
    rows: Math.max(8, Math.min(120, Math.floor((window.innerHeight - 160) / (fs * 1.2)))),
  };
}

// ---- terminal preferences (per device)

const PREFS_KEY = 'burrow.terminal';

// compose: type in a normal text box (autocorrect, voice input) and send the
// whole line at once, instead of typing straight into the terminal.
// historyMin: a command from history is suggested once used this often (or
// within the hour); one use filled the suggestions (report 94c9eb).
function readPrefs(): { fontSize: number; keyBar: string | null; compose: boolean; historyMin: number } {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { fontSize?: number; keyBar?: string; compose?: boolean; historyMin?: number };
    return {
      fontSize: typeof v.fontSize === 'number' && v.fontSize >= 8 && v.fontSize <= 32 ? v.fontSize : 14,
      keyBar: typeof v.keyBar === 'string' ? v.keyBar : null,
      compose: v.compose === true,
      historyMin: typeof v.historyMin === 'number' && v.historyMin >= 1 && v.historyMin <= 10 ? v.historyMin : 2,
    };
  } catch {
    return { fontSize: 14, keyBar: null, compose: false, historyMin: 2 };
  }
}

export const prefs = $state(readPrefs());

export function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Kept for this page only.
  }
}
