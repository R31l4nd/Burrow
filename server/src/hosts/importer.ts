import SSHConfig from 'ssh-config';
import type { ImportCandidate } from '@burrow/shared';
import { hostDefaults } from './defaults.js';
import type { Ctx } from '../context.js';
import { listKeys } from '../keys/vault.js';
import { groupMap, listHosts } from './service.js';
import { effectiveConnection } from '@burrow/shared';

// Import from an OpenSSH client config. Only concrete aliases become hosts;
// wildcard sections contribute their defaults through compute(). Private
// keys are not read from IdentityFile paths (the file is on the user's
// machine, not here): the path is only used to suggest a vault key with a
// matching name.

const isPattern = (alias: string) => /[*?!]/.test(alias);

const basename = (p: string) =>
  p
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .replace(/\.(pem|key)$/i, '');

function first(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return (Array.isArray(v) ? v[0] : v) ?? null;
}

export function parseSshConfig(text: string): Omit<ImportCandidate, 'matchedKeyId' | 'duplicateOf'>[] {
  const config = SSHConfig.parse(text);
  const aliases: string[] = [];
  for (const line of config) {
    if (line.type !== SSHConfig.DIRECTIVE || line.param.toLowerCase() !== 'host') continue;
    const values = Array.isArray(line.value) ? line.value.map((v) => (typeof v === 'string' ? v : v.val)) : String(line.value).split(/\s+/);
    for (const a of values) if (a && !isPattern(a) && !aliases.includes(a)) aliases.push(a);
  }
  return aliases.map((alias) => {
    // matchExec: false - `Match exec` would run a shell command from the
    // pasted text on this server.
    const c = config.compute(alias, { ignoreCase: true, matchExec: false }) as Record<string, string | string[]>;
    const port = first(c.port);
    const identity = first(c.identityfile);
    return {
      alias,
      address: first(c.hostname) ?? alias,
      port: port && /^\d+$/.test(port) ? Number(port) : null,
      username: first(c.user),
      identityFile: identity,
    };
  });
}

export function previewImport(ctx: Ctx, text: string): ImportCandidate[] {
  const keys = listKeys(ctx);
  const groups = groupMap(ctx);
  const all = hostDefaults(ctx);
  const existing = listHosts(ctx).map((h) => ({ h, eff: effectiveConnection(h, groups, all) }));
  return parseSshConfig(text).map((c) => {
    const keyName = c.identityFile ? basename(c.identityFile).toLowerCase() : null;
    const matched = keyName ? keys.find((k) => k.name.toLowerCase() === keyName) : undefined;
    const dup = existing.find(
      ({ h, eff }) =>
        h.address.toLowerCase() === c.address.toLowerCase() &&
        eff.port === (c.port ?? 22) &&
        (c.username === null || eff.username === c.username),
    );
    return { ...c, matchedKeyId: matched?.id ?? null, duplicateOf: dup?.h.id ?? null };
  });
}
