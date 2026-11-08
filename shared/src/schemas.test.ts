import { describe, expect, it } from 'vitest';
import { connectionDefaults, groupInput, hostInput, hostname, password, totpCode, username } from './schemas.js';

// What the server accepts in a request: each schema here guards a way in
// (names, passwords, codes) or what reaches an SSH connection (addresses,
// ports).

const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => s.safeParse(v).success;

describe('sign-in fields', () => {
  it('a username is letters, digits, dot, dash and underscore, trimmed, 2 to 64 long', () => {
    expect(username.parse('  alice.b-c_1 ')).toBe('alice.b-c_1');
    for (const bad of ['a', 'x'.repeat(65), 'alice smith', 'alice/..', "alice'--", 'alice\tb', 'älice']) expect(ok(username, bad)).toBe(false);
  });

  it('a password is at least 12 long (length over rules) and at most 256', () => {
    expect(ok(password, 'short-pass1')).toBe(false);
    expect(ok(password, 'twelve chars')).toBe(true);
    expect(ok(password, 'x'.repeat(257))).toBe(false);
  });

  it('a TOTP code is six digits, spaces around allowed', () => {
    expect(totpCode.parse(' 123456 ')).toBe('123456');
    for (const bad of ['12345', '1234567', '12a456', '123 456']) expect(ok(totpCode, bad)).toBe(false);
  });
});

describe('hosts and groups', () => {
  it('an address is a host name or an IP address, nothing a shell or ssh option could make more of', () => {
    for (const good of ['nas.lan', '192.168.1.20', '[2001:db8::1]', 'fe80::1', 'my_host-2']) expect(ok(hostname, good)).toBe(true);
    for (const bad of ['', 'nas lan', 'nas;reboot', 'host$(id)', 'a/b', '-oProxyCommand=sh', 'x'.repeat(254)]) expect(ok(hostname, bad)).toBe(false);
  });

  it('a port is 1 to 65535; a colour is #rrggbb; tags are trimmed and at most 20', () => {
    expect(ok(connectionDefaults, { port: 0 })).toBe(false);
    expect(ok(connectionDefaults, { port: 65536 })).toBe(false);
    expect(ok(connectionDefaults, { port: 22.5 })).toBe(false);
    expect(connectionDefaults.parse({ port: null, username: ' root ' })).toEqual({ port: null, username: 'root' });
    expect(ok(hostInput, { name: 'nas', address: 'nas.lan', color: 'red' })).toBe(false);
    expect(hostInput.parse({ name: 'nas', address: 'nas.lan', color: '#A0b1C2', tags: [' media '] })).toMatchObject({ color: '#A0b1C2', tags: ['media'] });
    expect(ok(hostInput, { name: 'nas', address: 'nas.lan', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).toBe(false);
    expect(ok(hostInput, { name: ' ', address: 'nas.lan' })).toBe(false);
  });

  it('a group hands down nothing unless told: its defaults start empty', () => {
    expect(groupInput.parse({ name: 'Servers' })).toEqual({ name: 'Servers', defaults: {} });
    expect(ok(groupInput, { name: 'Servers', parentId: 0 })).toBe(false);
  });
});
