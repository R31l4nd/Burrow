import { z } from 'zod';

// Persistent terminal sessions: REST for the list, one WebSocket per open
// terminal view. The server owns the session; clients attach and detach.

export type TerminalMode = 'tmux' | 'memory';

export interface TerminalViewer {
  // Stable per browser tab for the life of the socket.
  id: string;
  device: string;
  // The viewer whose window size the session currently uses.
  owner: boolean;
  connectedAt: string;
  /** Someone it is shared with, watching: sees it, cannot type (F3). Absent before 1.26.0. */
  watching?: string | null;
}

export interface TerminalSessionInfo {
  id: string;
  hostId: number;
  hostName: string;
  mode: TerminalMode;
  title: string | null;
  createdAt: string;
  lastActivityAt: string;
  // False for a tmux session after a Burrow restart until someone opens it.
  attached: boolean;
  cols: number;
  rows: number;
  viewers: TerminalViewer[];
  /** Users who may watch it, read-only (F3). */
  sharedWith: number[];
  /** Its output is being recorded (F3), kept 30 days. */
  recording: boolean;
}

/** A session someone shared with you, to watch (F3). */
export interface SharedSession {
  id: string;
  hostName: string;
  title: string | null;
  owner: string;
  recording: boolean;
}

export const shareSessionInput = z.object({ userIds: z.array(z.number().int().positive()).max(50) });
export const recordSessionInput = z.object({ on: z.boolean() });

/** A recorded terminal session (asciicast v2), kept 30 days (F3). */
export interface Recording {
  id: number;
  sessionId: string;
  hostName: string;
  title: string | null;
  user: string | null;
  startedAt: string;
  endedAt: string | null;
  bytes: number;
  /** Cut off at the size limit. */
  truncated: boolean;
}

export const createSessionInput = z.object({
  hostId: z.number().int().positive(),
  // Initial size, so the first screen is drawn at the right width.
  cols: z.number().int().min(10).max(500).default(80),
  rows: z.number().int().min(4).max(200).default(24),
  // Start in this directory ("Terminal here" from the file manager). It is
  // typed into the shell (cd -- '...'): no control characters, which act as
  // keys there before any quoting counts (AUDIT2 FS-04).
  cwd: z
    .string()
    .min(1)
    .max(4096)
    // eslint-disable-next-line no-control-regex -- control characters are what it refuses
    .refine((s) => !/[\x00-\x1f\x7f]/.test(s), 'A folder name with control characters cannot be typed into a shell.')
    .optional(),
  // Unlike the host's setting, this once: with tmux (kept) or without (in memory).
  tmux: z.enum(['always', 'never']).optional(),
});

// A session's own name ("build", "logs"); null: the host's name again.
export const renameSessionInput = z.object({
  title: z
    .string()
    .trim()
    .max(40)
    .nullable()
    .transform((v) => v || null),
});

/** What a session is called: its own name, or its host's ("test-sshd 2" for the second opened on a host). */
export function sessionLabel(s: TerminalSessionInfo, all: TerminalSessionInfo[]): string {
  if (s.title) return s.title;
  // Numbered by age: the first session on a host keeps the host's name when a second opens.
  const same = all.filter((x) => x.hostName === s.hostName && !x.title).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const nth = same.findIndex((x) => x.id === s.id) + 1;
  return nth > 1 ? `${s.hostName} ${nth}` : s.hostName;
}

// ---- WebSocket messages (JSON text frames)

export type ClientMessage =
  | { t: 'input'; d: string }
  // Sent on open, on window resize and when this device becomes active: the
  // device that last typed or focused decides the size (tmux "latest").
  | { t: 'resize'; cols: number; rows: number; active?: boolean }
  | { t: 'ping' }
  // A finger's scroll in a session in Burrow's tmux: that tmux's own history
  // (fast output never reached the viewer's scrollback). Up is positive.
  | { t: 'scroll'; lines: number }
  // The session's history at once, for the viewer's history layer (scrolled on the device itself, 2.19.0).
  // `mouse`: a program took the mouse; only a tmux of the person's own has a history to show then.
  | { t: 'history'; mouse?: boolean }
  // The screen drawn again whole (reports d1113b, 92eaa5): a tab come back replays what was kept, a fit here
  // moves what xterm shows, and a program draws only what changed since, over what may differ. Burrow's tmux
  // draws it again; without it, this viewer gets a snapshot of the server's copy of the screen.
  | { t: 'redraw' }
  // Type the host's stored password into the session (for sudo prompts).
  // The server does it; the password never reaches the browser.
  | { t: 'password' };

// What the shell integration (or, without it, a best guess) says about the
// shell in a session. Drives auto-complete in the client.
export interface ShellState {
  // The shell integration is reporting in this session.
  integration: boolean;
  // Waiting at a prompt (not running a command or a full-screen program).
  atPrompt: boolean;
  cwd: string | null;
  // The prompt's last line as printed, so the client can find the input.
  prompt: string | null;
  // The command run last in this session: what usually follows it is offered.
  lastCommand?: string | null;
}

export type ServerMessage =
  // Full current screen and scrollback, sent once after attaching.
  // `redraw`: the screen drawn again on this viewer's asking (ClientMessage redraw), not a new attach.
  | { t: 'snapshot'; data: string; cols: number; rows: number; mode: TerminalMode; shell: ShellState; alt?: boolean; redraw?: true }
  // Without tmux: a program on its alternate screen or off it again (less, vim); a scroll then goes to it as arrow keys.
  | { t: 'alt'; on: boolean }
  | { t: 'shell'; shell: ShellState }
  | { t: 'output'; d: string }
  | { t: 'size'; cols: number; rows: number; owner: boolean }
  | { t: 'viewers'; viewers: TerminalViewer[] }
  | { t: 'exit'; reason: 'closed' | 'ended' | 'error' | 'lost'; message?: string }
  | { t: 'notice'; code: 'no_password' | 'password_sent' | 'password_refused' }
  // Recording started or stopped (F3): every viewer shows it.
  | { t: 'recording'; on: boolean }
  // The answer to 'history': its lines with their colours; `alt`: a program on tmux's alternate screen
  // (less, man), scrolled as before; `failed`: it could not be read (not the same as none).
  | { t: 'history'; data: string; alt?: boolean; failed?: boolean }
  | { t: 'pong' };

export const clientMessage: z.ZodType<ClientMessage> = z.discriminatedUnion('t', [
  z.object({ t: z.literal('input'), d: z.string().max(65536) }),
  z.object({
    t: z.literal('resize'),
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(4).max(200),
    active: z.boolean().optional(),
  }),
  z.object({ t: z.literal('ping') }),
  z.object({ t: z.literal('scroll'), lines: z.number().int().min(-1000).max(1000) }),
  z.object({ t: z.literal('password') }),
  z.object({ t: z.literal('history'), mouse: z.boolean().optional() }),
  z.object({ t: z.literal('redraw') }),
]);

// ---- Snippets

export const snippetInput = z.object({
  name: z.string().trim().min(1).max(80),
  command: z.string().min(1).max(8000),
  description: z.string().trim().max(300).nullable().optional(),
  hostId: z.number().int().positive().nullable().optional(),
  groupId: z.number().int().positive().nullable().optional(),
});
export type SnippetInput = z.infer<typeof snippetInput>;

export interface Snippet {
  id: number;
  name: string;
  command: string;
  description: string | null;
  hostId: number | null;
  groupId: number | null;
}

/** A command typed often, offered as a snippet (shared/src/snippets.ts). */
export interface SnippetSuggestion {
  command: string;
  /** How often, on all hosts together. */
  count: number;
  /** The hosts it was typed on. */
  hostIds: number[];
  lastAt: string;
}

export const completionRunInput = z.object({
  // An argument list (quoted one by one) or a shell command string, from a
  // completion spec's generator.
  script: z.union([z.array(z.string().max(2000)).min(1).max(100), z.string().min(1).max(4000)]),
  cwd: z.string().max(4096).nullable().optional(),
});

export interface PathEntry {
  name: string;
  dir: boolean;
  link: boolean;
}

export const runSnippetInput = z.object({
  command: z.string().min(1).max(8000),
  hostIds: z.array(z.number().int().positive()).min(1).max(50),
});

export interface RunResult {
  hostId: number;
  hostName: string;
  status: 'ok' | 'failed' | 'error';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export { fillSnippet, snippetDefaults, snippetReady, snippetVariables, type SnippetVariable } from './snippets.js';

/**
 * What a terminal sends by itself, answering a program's question: its
 * attributes (DA), the cursor's place (CPR), its status, its colours (OSC
 * 4/10/11), focus in and out, a mode's state (DECRQM), its version. Not
 * someone typing: a second viewer's answers reached vim as keys, and its
 * focus change took the session's size (review 2026-10-24).
 */
export function isTermReply(d: string): boolean {
  // eslint-disable-next-line no-control-regex -- escape sequences are what it reads
  return /^\x1b(\[[?>]?[\d;]*c|\[\d+;\d+R|\[\d*n|\][14]\d?;[^\x07\x1b]*(\x07|\x1b\\)|\[[IO]|\[\??[\d;]*\$y|P[>!]\|)/.test(d);
}
