import { describe, expect, it } from 'vitest';
import { appUrl } from './apps.js';

describe('appUrl', () => {
  it('takes http(s) URLs with a host, keeps them as typed', () => {
    for (const ok of ['http://radarr.lan:7878', 'https://jellyfin.example.org/web/#/home', 'http://192.0.2.10:8080/', 'http://[2001:db8::1]:8096/'])
      expect(appUrl.parse(ok)).toBe(ok);
  });

  it('refuses what no browser can open, or what carries credentials (AUDIT2 AI-17)', () => {
    for (const bad of ['ftp://files.lan', 'http://', 'http://user:pw@radarr.lan', 'http://user@radarr.lan', 'http://radarr.lan:99999/', 'http://radarr.lan:port/', 'http://[::g]/', 'http://[2001:db8::1/', 'http://ra%zzdarr.lan/', 'http://radarr lan/'])
      expect(appUrl.safeParse(bad).success, bad).toBe(false);
  });
});
