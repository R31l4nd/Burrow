import { describe, expect, it } from 'vitest';
import { parseRegistryEndpoints, systemSettingsInput } from './system.js';

const none = { terminalMaxSessions: null, terminalIdleMinutes: null, statusIntervalSeconds: null, updateCheckExclude: null, registryEndpoints: null, appsBaseDomain: null, heartbeatUrl: null };

describe('Settings -> System', () => {
  it('registries: name=address pairs, comma separated; anything else is not one', () => {
    expect(parseRegistryEndpoints('')).toEqual({});
    expect(parseRegistryEndpoints(' localhost:5000=http://172.17.0.1:5000/ , reg.lan=https://10.0.0.5 ')).toEqual({ 'localhost:5000': 'http://172.17.0.1:5000', 'reg.lan': 'https://10.0.0.5' });
    for (const bad of ['no-equals', '=http://x', 'reg.lan=ftp://x', 'reg lan=http://x', 'reg.lan=http://x/path']) expect(parseRegistryEndpoints(bad), bad).toBeNull();
  });

  it('each value empty (null) or within its bounds', () => {
    expect(systemSettingsInput.safeParse(none).success).toBe(true);
    expect(systemSettingsInput.safeParse({ ...none, terminalMaxSessions: 20, terminalIdleMinutes: 0, statusIntervalSeconds: 0, updateCheckExclude: '^registry\\.lan/', registryEndpoints: 'r=http://x:1', appsBaseDomain: 'example.com' }).success).toBe(true);
    expect(systemSettingsInput.safeParse({ ...none, statusIntervalSeconds: 10 }).success).toBe(true);
    for (const bad of [{ statusIntervalSeconds: 9 }, { statusIntervalSeconds: 86401 }, { terminalMaxSessions: 501 }, { terminalIdleMinutes: -1 }, { updateCheckExclude: '[' }, { registryEndpoints: 'x' }, { appsBaseDomain: 'a b' }]) {
      expect(systemSettingsInput.safeParse({ ...none, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});
