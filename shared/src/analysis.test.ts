import { describe, expect, it } from 'vitest';
import { alertRuleInput, alertTitle, groupLines, maskText, renderGroups, subjectLabel } from './analysis.js';

describe('masking addresses for a model outside the network', () => {
  it('IPv6 in its short forms too, never a time of day', () => {
    const line = 'from 2001:db8::1234 and fe80::1 and ::1 and 2001:0db8:0000:0000:0000:ff00:0042:8329 at 12:30:45 via 10.0.0.7';
    const masked = maskText(line, { ips: true });
    expect(masked).toBe('from <ip> and <ip> and <ip> and <ip> at 12:30:45 via <ip>');
    expect(maskText(line, { ips: false })).toBe(line);
  });

  it('a login at an address is no e-mail address: user@10.0.0.20 keeps its user, the address masked as one', () => {
    expect(maskText('ssh debian@192.168.1.20:22 failed: unreachable', { ips: false })).toBe('ssh debian@192.168.1.20:22 failed: unreachable');
    expect(maskText('ssh debian@192.168.1.20:22 failed: unreachable', { ips: true })).toBe('ssh debian@<ip>:22 failed: unreachable');
    expect(maskText('mail to alex@example.com bounced', { ips: false })).toBe('mail to <email> bounced');
  });
});

describe('grouping JSON log lines', () => {
  const at = (text: string) => ({ source: 'web', ts: null, text });
  it('an error never joins a group of info lines', () => {
    const { groups } = groupLines([at('{"level":30,"msg":"ready"}'), at('{"level":50,"msg":"disk destroyed"}')], { ips: false, budget: 10_000 });
    expect(groups.map((g) => [g.level, g.count, g.sample])).toEqual([
      ['error', 1, '{"level":50,"msg":"disk destroyed"}'],
      ['info', 1, '{"level":30,"msg":"ready"}'],
    ]);
  });
  it('lines that say different things stay apart; the same thing with other values is one group', () => {
    const { groups } = groupLines(
      [at('{"level":"info","msg":"cache warmed in 12 ms"}'), at('{"level":"info","msg":"user signed out"}'), at('{"level":"info","msg":"cache warmed in 40 ms"}')],
      { ips: false, budget: 10_000 },
    );
    expect(groups.map((g) => [g.template, g.count])).toEqual([
      ['cache warmed in <n> ms', 2],
      ['user signed out', 1],
    ]);
  });
});

describe('muting', () => {
  it('a log file can be muted, and a muted container silences its own files (audit BE-25)', async () => {
    const { isAlertSubject, muteCovers } = await import('./analysis.js');
    for (const s of ['web', '@disk /data', 'web:%2Fapp%2Fa.log', ':%2Fvar%2Flog%2Fsyslog']) expect(isAlertSubject(s), s).toBe(true);
    for (const s of ['', 'web:%2Fapp%2F..%2Fetc', 'web:notapath', ':%E0%A4%A', 'a b']) expect(isAlertSubject(s), s).toBe(false);
    expect(muteCovers('web:%2Fapp%2Fa.log', 'web:%2Fapp%2Fa.log')).toBe(true);
    expect(muteCovers('web', 'web:%2Fapp%2Fa.log')).toBe(true);
    expect(muteCovers('web', 'webapp:%2Fapp%2Fa.log')).toBe(false);
    expect(muteCovers('web:%2Fapp%2Fa.log', 'web')).toBe(false);
    expect(muteCovers('', ':%2Fvar%2Flog%2Fsyslog')).toBe(false);
  });
});

describe('masking what leaves for a model (AUDIT2 AI-01, AI-02)', () => {
  const mask = (t: string) => maskText(t, { ips: false });
  it('a quoted secret with spaces, a short one, an escaped JSON key and composite headers: all of the value', () => {
    expect(mask('password: "correct horse battery"')).not.toMatch(/horse|battery/);
    expect(mask('pwd=ab')).not.toContain('ab');
    expect(mask('{\\"password\\":\\"hunter2\\"}')).not.toContain('hunter2');
    expect(mask('Authorization: Digest username="admin", realm="x", response="6629fae49393a05397450978507c4ef1"')).not.toMatch(/admin|6629fae/);
    expect(mask('Cookie: theme=dark; session=abc123def; csrf=zz9')).not.toMatch(/abc123def|zz9/);
    expect(mask('Set-Cookie: sid=s3cr3tvalue; Path=/; HttpOnly')).not.toContain('s3cr3tvalue');
    // Ordinary words stay.
    expect(mask('the password was changed by admin')).toContain('the password was changed');
  });

  it('a private key over several lines, one source interleaved with another: none of its lines', () => {
    // Made of parts: a key's header written out whole is what scripts/check-public.sh refuses in a commit.
    const pk = ['PRIVATE', 'KEY'].join(' ');
    const key = [`-----BEGIN OPENSSH ${pk}-----`, 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW', 'QyNTUxOQAAACBhc2Rm', `-----END OPENSSH ${pk}-----`];
    const lines = [
      { source: 'a', text: key[0]!, ts: null },
      { source: 'b', text: 'GET /health 200', ts: null },
      { source: 'a', text: key[1]!, ts: null },
      { source: 'a', text: key[2]!, ts: null },
      { source: 'a', text: key[3]!, ts: null },
      { source: 'a', text: 'after the key', ts: null },
    ];
    const out = renderGroups(groupLines(lines, { ips: false, budget: 10_000 }).groups);
    expect(out).not.toContain('QyNTUxOQAAACBhc2Rm');
    expect(out).not.toContain('b3BlbnNzaC1rZXktdjE');
    expect(out).toContain('GET /health 200');
    expect(out).toContain('after the key');
  });
});

describe('masking the secret shapes of a homelab (A3-SRV-05)', () => {
  const mask = (t: string) => maskText(t, { ips: true });
  // Made of parts, so no file in the tree holds a whole token of a real shape.
  const j = (...p: string[]) => p.join('');
  const cases: [string, string][] = [
    ['connecting to redis://:S3cretRedisPw@redis:6379/0', 'S3cretRedisPw'],
    ['passphrase=open sesame', 'open'],
    ['backup --password Sup3rS3cret! --verbose', 'Sup3rS3cret'],
    ['mysql -u root -pSup3rS3cret -h db', 'Sup3rS3cret'],
    ['mysqldump --user=root --password=Sup3rS3cret app', 'Sup3rS3cret'],
    [`stripe key ${j('sk_', 'live_', '51H8xYzAbCdEfGhIjKlMnOpQr')}`, 'AbCdEfGhIjKlMnOpQr'],
    [`token ${j('github_', 'pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123')}`, 'abcdefghijklmnop'],
    [`GITLAB_TOKEN ${j('glpat', '-', 'xYz1234567890AbCdEfGh')}`, 'xYz1234567890'],
    [`//registry.npmjs.org/:_authToken=${j('npm_', 'abcdefghijklmnopqrstuvwxyz0123456789')}`, 'abcdefghijklmnopqrstuvwxyz'],
    [`maps ${j('AIza', 'SyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW')}`, 'SyA1b2C3d4E5f6G7h8I9j0'],
    [`sending to bot ${j('123456789', ':', 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw')}`, 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'],
    [`ntfy ${j('tk_', 'abcdefghijklmnopqrstuvwxyz012')}`, 'abcdefghijklmnopqrstuvwxyz012'],
    ['GET https://acct.blob.core.windows.net/c/x.tar?sv=2022-11-02&sig=AbCd%2BEfGh%3D&se=2026', 'AbCd%2BEfGh'],
    ['smtp login user@example.com:MailPw123 failed', 'MailPw123'],
    [`POST https://discord.com/api/webhooks/1234567890123456/${j('AbCdEfGhIjKlMnOp', 'QrStUvWxYz-0123456789_AbCdEfGhIjKlMnOpQrStUvWxYz012345')}`, 'QrStUvWxYz'],
    [`POST https://discord.com/api/webhooks/1234567890123456/${j('AbCdEfGhIjKlMnOp', 'QrStUvWxYz-0123456789_AbCdEfGhIjKlMnOpQrStUvWxYz012345')}`, 'AbCdEfGhIjKlMnOp'],
    [`apprise ${j('Xk9fQ2mL7pR4vT8w', 'B1nC6yZ3hJ5gD0sA')}`, 'B1nC6yZ3hJ5gD0sA'],
  ];
  it('none of these leave as they are', () => {
    for (const [line, secret] of cases) expect(mask(line), line).not.toContain(secret);
  });

  it('what is no secret stays readable', () => {
    for (const line of [
      'scp user@host.lan:/srv/x .',
      'ssh admin@nas.home.lan:22 refused',
      'container 3f1e7c1a-6b2d-4c8e-9f0a-1b2c3d4e5f60 started',
      'paperless-ngx-webserver-consumer-worker-12 restarted',
      'the password was changed by admin',
      'listening on port 8080 with --password-file /run/secrets/db',
    ]) {
      const out = mask(line);
      expect(out, line).not.toContain('<secret>');
    }
  });
});

describe('grouping many lines within bounds', () => {
  // Words without digits or hex letters: the template keeps them as they are.
  const word = (n: number) => {
    let s = '';
    do {
      s += 'ghijklmnopqrstuvwxyz'[n % 20];
      n = Math.floor(n / 20);
    } while (n);
    return s;
  };

  it('20,000 lines all of their own kind: grouped in bounded time (AUDIT2 AI-05)', () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => ({ source: 'web', ts: null, text: `worker ${word(i)} took ${word(i * 7 + 3)} slot` }));
    const t0 = performance.now();
    const { total } = groupLines(lines, { ips: false, budget: 10_000 });
    // Every group against every other took minutes here; bounded, about a second.
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(total).toBe(20_000);
    // Vitest's own 5 s cut it off on a loaded machine before the 10 s bound above was reached.
  }, 30_000);

  it('similar lines still merge however many groups came before', () => {
    const lines = [
      ...Array.from({ length: 500 }, (_, i) => ({ source: 'web', ts: null, text: `worker ${word(i)} took ${word(i * 7 + 3)} slot` })),
      { source: 'web', ts: null, text: 'user alice logged in now' },
      { source: 'web', ts: null, text: 'user bob logged in now' },
    ];
    const { groups } = groupLines(lines, { ips: false, budget: 1_000_000 });
    expect(groups.find((g) => g.template === 'user <*> logged in now')?.count).toBe(2);
  });

  it('the text the model reads stays within the budget, the first group and long names too (AUDIT2 AI-07)', () => {
    const source = `${'very-long-container-name-'.repeat(8)}@host`;
    const lines = [
      { source, ts: '2026-10-04T10:00:00.123456789Z', text: `ERROR ${'x'.repeat(7000)} failed` },
      { source, ts: '2026-10-04T10:05:00.123456789Z', text: `ERROR ${'x'.repeat(7000)} failed` },
      ...Array.from({ length: 50 }, (_, i) => ({ source, ts: '2026-10-04T10:00:00Z', text: `WARN slow ${word(i)} request ${word(i + 99)}` })),
    ];
    for (const budget of [400, 1000, 4000]) {
      const { groups, omitted } = groupLines(lines, { ips: false, budget });
      expect(groups.length).toBeGreaterThan(0);
      expect(renderGroups(groups).length, `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(omitted).toBe(51 - groups.length);
    }
  });
});

describe('one group larger than the whole budget', () => {
  const lines = [{ source: 'web', ts: null, text: `ERROR ${'the disk is full '.repeat(200)}` }];

  it('is cut to fit rather than left out: its heading whole, its sample shortened', () => {
    const { groups, omitted } = groupLines(lines, { ips: false, budget: 120 });
    expect(groups).toHaveLength(1);
    expect(omitted).toBe(0);
    const text = renderGroups(groups);
    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).toMatch(/^\[web\] 1x error/);
    expect(groups[0]!.sample).toMatch(/^ERROR the disk is full/);
    expect(groups[0]!.sample.length).toBeLessThan(120);
  });

  it('is left out when not even its heading fits', () => {
    expect(groupLines(lines, { ips: false, budget: 5 })).toEqual({ groups: [], total: 1, omitted: 1 });
  });
});

describe('alert rules', () => {
  const rule = { name: 'r', hostId: null, container: null, project: null };

  it('an event rule names an event, a pattern rule a regular expression that compiles, a rate rule a number and a window', () => {
    expect(alertRuleInput.safeParse({ ...rule, kind: 'event', events: [] }).success).toBe(false);
    expect(alertRuleInput.safeParse({ ...rule, kind: 'event', events: ['oom'] }).success).toBe(true);
    expect(alertRuleInput.safeParse({ ...rule, kind: 'pattern', pattern: '(unclosed' }).success).toBe(false);
    expect(alertRuleInput.safeParse({ ...rule, kind: 'pattern', pattern: '' }).success).toBe(false);
    expect(alertRuleInput.safeParse({ ...rule, kind: 'pattern' }).success).toBe(false);
    expect(alertRuleInput.parse({ ...rule, kind: 'pattern', pattern: 'timeout|refused' })).toMatchObject({ enabled: true, events: [], threshold: null });
    expect(alertRuleInput.safeParse({ ...rule, kind: 'rate', threshold: 5 }).success).toBe(false);
    expect(alertRuleInput.safeParse({ ...rule, kind: 'rate', threshold: 5, windowMinutes: 1441 }).success).toBe(false);
    expect(alertRuleInput.safeParse({ ...rule, kind: 'rate', threshold: 5, windowMinutes: 10 }).success).toBe(true);
  });
});

describe('alert titles in Dutch', () => {
  it('says every kind of alert in Dutch, a count of one in the singular; an unknown title stays as it is', () => {
    const cases: [string, string][] = [
      ['killed: out of memory', 'gestopt: geheugen op'],
      ['turned unhealthy', 'unhealthy geworden'],
      ['1 error in 5 min', '1 fout in 5 min'],
      ['disk 93% full', 'schijf 93% vol'],
      ['SMART says the disk is failing', 'SMART meldt dat de schijf faalt'],
      ['3 pending sectors (was 1)', '3 wachtende sectoren (was 1)'],
      ['1 media error (was 0)', '1 mediafout (was 0)'],
      ['2 uncorrectable errors (was 0)', '2 onherstelbare fouten (was 0)'],
      ['1 unreadable sector (was 0)', '1 onleesbare sector (was 0)'],
      ['the disk reports a critical warning', 'de schijf meldt een kritieke waarschuwing'],
      ['the disk is judged failing', 'de schijf wordt als stervend beoordeeld'],
      ['getting worse: 8 reallocated sectors (was 2)', 'slechter: 8 verplaatste sectoren (was 2)'],
      ['getting worse: 3 crc errors (was 1)', 'slechter: 3 crc errors (was 1)'],
      ['worn out: 100% used', 'versleten: 100% gebruikt, aan vervanging toe'],
      ['worn: 90% used', 'versleten: 90% gebruikt'],
      ['disk at 61 C', 'schijf op 61 C'],
      ['CPU at 95% for 10 minutes', 'CPU op 95% gedurende 10 minuten'],
      ['memory 97% full for 5 minutes', 'geheugen 97% vol gedurende 5 minuten'],
      ['2 security updates waiting: bash, tar', '2 beveiligingsupdates klaar: bash, tar'],
      ['1 security update waiting: openssl', '1 beveiligingsupdate klaar: openssl'],
      ['"nightly backup" failed with exit code 2', '"nightly backup" mislukt met exitcode 2'],
      ['"nightly backup" timed out after 10 min', '"nightly backup" afgebroken na 10 min'],
      ['"nightly backup" could not run: connect ECONNREFUSED', '"nightly backup" kon niet draaien: connect ECONNREFUSED'],
      ['Package id 0 at 92 C', 'Package id 0 op 92 C'],
      ['not reachable: connect ECONNREFUSED 10.0.0.9:22', 'niet bereikbaar: connect ECONNREFUSED 10.0.0.9:22'],
      ['reachable again after 15 minutes', 'weer bereikbaar na 15 minuten'],
      ['something only English knows', 'something only English knows'],
    ];
    for (const [en, nl] of cases) expect(alertTitle(en, 'nl')).toBe(nl);
  });

  it('a host that stops answering is about the host being reachable, in both languages', () => {
    expect([subjectLabel('@reachable'), subjectLabel('@reachable', 'nl')]).toEqual(['Reachable', 'Bereikbaar']);
  });
});

describe('masking what the audit of 2026-11 found leaving for a model', () => {
  const mask = (t: string) => maskText(t, { ips: false });
  // Made of parts, so no file in the tree holds a whole token of a real shape or a key's header.
  const j = (...p: string[]) => p.join('');
  it('keys whose names end in KEY, and psk and pw: their values', () => {
    const cases: [string, string][] = [
      ['SECRET_KEY=django-insecure-q8x7v', 'django-insecure'],
      ["PAPERLESS_SECRET_KEY: 'my long passphrase here'", 'long passphrase'],
      ['ENCRYPTION_KEY=Zx81kQ2mP0aa', 'Zx81kQ2mP0aa'],
      [`TS_AUTHKEY=${j('tskey', '-auth-k12345')}`, 'k12345'],
      ['JWT_SIGNING_KEY="abc def"', 'abc def'],
      ['client_key: c1i3ntK3y', 'c1i3ntK3y'],
      ['LICENSE_KEY=LIC-1234-ABCD', 'LIC-1234'],
      ['APP_KEY=base64:QmFzZTY0S2V5', 'QmFzZTY0S2V5'],
      ['wpa_psk=wifiS3cret', 'wifiS3cret'],
      ['DB_PW=hunter2', 'hunter2'],
    ];
    for (const [line, secret] of cases) expect(mask(line), line).not.toContain(secret);
  });

  it('credentials on a command line: curl -u, sshpass -p, docker and podman login -p, htpasswd -b, --http-password', () => {
    const cases: [string, string][] = [
      ['curl -u admin:hunter2 https://x.example', 'hunter2'],
      ['curl --user=admin:hunter2 https://x.example', 'hunter2'],
      ['sshpass -p hunter2 ssh root@box', 'hunter2'],
      ['docker login -u me -p hunter2 registry.example', 'hunter2'],
      ['podman login --username me -p hunter2 quay.io', 'hunter2'],
      ['htpasswd -b /etc/nginx/.htpasswd admin hunter2', 'hunter2'],
      ['htpasswd -nbB admin hunter2', 'hunter2'],
      ['wget --http-password=hunter2 https://x.example/f', 'hunter2'],
    ];
    for (const [line, secret] of cases) expect(mask(line), line).not.toContain(secret);
    // The user and what follows stay readable.
    expect(mask('curl -u admin:hunter2 https://x.example')).toContain('admin:');
    expect(mask('sshpass -p hunter2 ssh root@box')).toContain('ssh root@box');
  });

  it('a PGP private key block, in one line and over several', () => {
    const begin = j('-----BEGIN PGP ', 'PRIVATE KEY BLOCK-----');
    const end = j('-----END PGP ', 'PRIVATE KEY BLOCK-----');
    expect(mask(`${begin}\nlQOYBGXyz0123abcd\n${end}`)).not.toContain('lQOYBGXyz0123abcd');
    const lines = [begin, 'lQOYBGXyz0123abcd', 'xyzzy', end, 'after the key'].map((text) => ({ source: 'a', text, ts: null }));
    const out = renderGroups(groupLines(lines, { ips: false, budget: 10_000 }).groups);
    expect(out).not.toContain('lQOYBGXyz0123abcd');
    expect(out).not.toContain('xyzzy');
    expect(out).toContain('after the key');
  });

  it('a password in a URL with a / or an @ in it: all of it, the host kept', () => {
    expect(mask('GET https://user:pa/ss@host.example/x')).not.toContain('ss@');
    expect(mask('GET https://user:pa/ss@host.example/x')).toContain('@host.example/x');
    expect(mask('connecting to mongodb://admin:p@ss@mongo:27017')).not.toContain('ss@');
    expect(mask('connecting to mongodb://admin:p@ss@mongo:27017')).toContain('@mongo:27017');
    // An address in the query is not where the password ends; a port before a path is no password.
    expect(mask('GET https://u:pw@host.example/x?to=a@b.example')).toContain('@host.example/x');
    expect(mask('GET https://registry.example:443/@types/node')).toBe('GET https://registry.example:443/@types/node');
  });

  it('AWS keys of every kind and Slack app tokens', () => {
    for (const p of ['AKIA', 'ASIA', 'AGPA', 'AIDA', 'AROA']) {
      const k = j(p, 'Q2W3E4R5T6Y7U8I9');
      expect(mask(`key ${k} used`), k).not.toContain('Q2W3E4R5T6Y7U8I9');
    }
    expect(mask(`slack ${j('xapp', '-1-A0123456789-0123456789012-abcdef')}`)).not.toContain('A0123456789');
  });

  it('ordinary words with key, pw or psk in them stay', () => {
    for (const line of ['monkey=1 hotkey=F5 keyboard: us', 'stepwise: 3 steps', 'the app key was rotated', 'curl -u admin https://x.example', 'docker login registry.example']) {
      expect(mask(line), line).not.toContain('<secret>');
    }
  });
});
