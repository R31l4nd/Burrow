// ntfy: Burrow posts to a topic on an ntfy server (ntfy.sh or your own), the
// ntfy app on the phone shows it; a tap opens Burrow at the page.

export interface PushMessage {
  title: string;
  body: string;
  /** 1 (min) ... 5 (max); ntfy's default is 3. */
  priority: number;
  tags: string[];
  /** Opened on a tap. */
  click: string;
  actions: { label: string; url: string }[];
}

/** The HTTP request for a message: headers as ntfy documents them. */
export function ntfyRequest(s: { url: string; topic: string; token: string | null }, m: PushMessage): { url: string; init: RequestInit } {
  const headers: Record<string, string> = {
    // Header values must be Latin-1; ntfy decodes RFC 2047 for the rest.
    title: encodeHeader(m.title),
    priority: String(m.priority),
    tags: m.tags.join(','),
    click: m.click,
    'content-type': 'text/plain; charset=utf-8',
  };
  if (m.actions.length) headers.actions = m.actions.map((a) => `view, ${a.label.replace(/[,;]/g, ' ')}, ${a.url}`).join('; ');
  if (s.token) headers.authorization = `Bearer ${s.token}`;
  return { url: `${s.url.replace(/\/+$/, '')}/${encodeURIComponent(s.topic)}`, init: { method: 'POST', headers, body: m.body } };
}

function encodeHeader(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

/** A page of Burrow as a link: burrow:// for the Android app, or the page in the browser. */
export function pageLink(origin: string, page: string, openIn: 'app' | 'browser'): string {
  return openIn === 'app' ? `burrow://open?to=${encodeURIComponent(page)}` : `${origin}/#${page}`;
}
