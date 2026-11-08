import { z } from 'zod';

// Settings that were only in the .env file (Settings -> System). Each one left empty (null) is the
// .env's value, so an install keeps what it has until someone changes it here.

/** "name=address" pairs, comma separated: a registry's name and where Burrow reaches it. */
export function parseRegistryEndpoints(s: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const part of s.split(',').map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i <= 0) return null;
    const name = part.slice(0, i).trim();
    const url = part.slice(i + 1).trim();
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(name) || !/^https?:\/\/[^\s/]+(:\d{1,5})?\/?$/i.test(url)) return null;
    out[name] = url.replace(/\/$/, '');
  }
  return out;
}

function validRegex(s: string): boolean {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}

export const systemSettingsInput = z.object({
  terminalMaxSessions: z.number().int().min(1).max(500).nullable(),
  terminalIdleMinutes: z.number().int().min(0).max(10080).nullable(),
  // 0 turns the check off; otherwise at least every 10 seconds, at most once a day.
  statusIntervalSeconds: z
    .number()
    .int()
    .refine((n) => n === 0 || (n >= 10 && n <= 86400), 'between 10 and 86400 seconds, or 0 for off')
    .nullable(),
  updateCheckExclude: z.string().trim().max(500).refine(validRegex, 'not a valid regular expression').nullable(),
  registryEndpoints: z
    .string()
    .trim()
    .max(2000)
    .refine((s) => parseRegistryEndpoints(s) !== null, 'name=http(s)://address, comma separated')
    .nullable(),
  appsBaseDomain: z
    .string()
    .trim()
    .max(253)
    .regex(/^[a-z0-9.-]*$/i, 'a domain name such as example.com')
    .nullable(),
});
export type SystemSettingsInput = z.infer<typeof systemSettingsInput>;

export interface SystemValues {
  terminalMaxSessions: number;
  terminalIdleMinutes: number;
  statusIntervalSeconds: number;
  updateCheckExclude: string;
  registryEndpoints: string;
  appsBaseDomain: string;
}

/** What is set here (null: the .env's), the .env's own values, and what applies now. */
export interface SystemSettings {
  saved: SystemSettingsInput;
  env: SystemValues;
  effective: SystemValues;
}
