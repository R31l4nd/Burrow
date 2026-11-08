import { z } from 'zod';

// App tabs: web apps (Radarr, Sonarr, ...) opened next to the terminal. In a
// browser in a frame when the app allows it, else in a new tab; in the
// Android app as a native tab with its own cookie store.

// http(s), a host, no user:password@ (it would end up in page links).
export const appUrl = z
  .string()
  .trim()
  .max(2000)
  .regex(/^https?:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/i, 'an http(s) URL without credentials')
  .refine(parsesAsUrl, 'a URL a browser can open (host and port as they should be)');

// The WHATWG URL parser, in browsers and Node alike (shared builds without the DOM or Node types).
declare const URL: new (s: string) => { protocol: string; hostname: string; username: string; password: string };

/** What the regex lets through but a browser would not open: a bad port, IPv6 address or percent escape in the host. */
function parsesAsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

export const appInput = z.object({
  name: z.string().trim().min(1).max(60),
  url: appUrl,
  group: z.string().trim().max(40).nullable().optional(),
  pinned: z.boolean().default(true),
  hostId: z.number().int().positive().nullable().optional(),
  container: z.string().trim().max(128).nullable().optional(),
  /** Checked every minute; a message when it goes down and comes back. */
  monitor: z.boolean().default(true),
  /** Always in a tab of its own, even when it may be shown in Burrow (report c2fde7). */
  newTab: z.boolean().default(false),
});
export type AppInput = z.infer<typeof appInput>;

export type Embeddable = 'yes' | 'no' | 'unknown';

export interface AppTab {
  id: number;
  name: string;
  url: string;
  group: string | null;
  pinned: boolean;
  embeddable: Embeddable;
  hasIcon: boolean;
  hostId: number | null;
  container: string | null;
  monitor: boolean;
  newTab: boolean;
  /** null: not checked (yet), or not watched. */
  up: boolean | null;
  checkedAt: string | null;
  latencyMs: number | null;
  downSince: string | null;
  /** Share of the last day's checks that found it up (0-1), null without checks. */
  uptime: number | null;
  /** When its TLS certificate runs out (https, watched apps), null when not known. */
  certExpiresAt: string | null;
}

/** Where a discovered URL came from. */
export type AppSource = 'homepage' | 'swag' | 'traefik' | 'caddy' | 'npm';

export interface DiscoveredApp {
  name: string;
  url: string;
  group: string | null;
  source: AppSource;
  hostId: number;
  hostName: string;
  container: string;
  /** An app with this URL exists already. */
  added: boolean;
}

export interface DiscoveryResult {
  apps: DiscoveredApp[];
  errors: { hostId: number; hostName: string; message: string }[];
}

export interface DeviceInfo {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  current: boolean;
  /** The app has reported its key for the direct SSH route. */
  hasSshKey: boolean;
}
