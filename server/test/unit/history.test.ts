import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandHistory, commandPairs } from '../../src/db/schema.js';
import { deleteCommand, frecency, importHistory, listHistory, parseHistoryFile, recordCommand } from '../../src/history/service.js';
import { skipReason } from '@burrow/shared';
import { makeApp, setupAdmin, type TestApp } from '../helpers.js';

// A fixture of commands that carry secrets. Every one of them must be kept
// out of the history.
const SECRETS = [
  'mysql -u root -pHunter2 app',
  'export DB_PASSWORD=hunter2',
  'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'API_KEY=abc123 ./run.sh',
  'curl -H "Authorization: Bearer abc.def.ghi" https://api.example.com',
  'curl -u admin:secret https://example.com',
  'git clone https://user:pa55word@git.example.com/repo.git',
  'docker login -p s3cr3t registry.example.com',
  'restic --password=abc backup /data',
  'echo hunter2 | sudo -S apt update',
  'sshpass -p hunter2 ssh pi@nas',
  'htpasswd -bc .htpasswd admin hunter2',
  'wg set wg0 private-key ZmFrZWtleWZha2VrZXlmYWtla2V5ZmFrZWtleWZha2U=',
  'aws configure set aws_access_key_id AKIAABCDEFGHIJKLMNOP',
  'claude --api-key sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
  'echo 3f786850e387550fdab836ed7e6dc881de23001b3f786850e387550fdab836ed',
  'token: xoxb-1234567890-abcdefghij',
];

describe('skipReason', () => {
  it('keeps ordinary commands', () => {
    for (const c of ['ls -la /data', 'docker logs -f radarr', 'sudo systemctl restart nginx', 'git commit -m "fix token parsing"', 'grep -r password config/']) {
      expect(skipReason(c), c).toBeNull();
    }
  });

  it('skips every command in the secrets fixture', () => {
    for (const c of SECRETS) expect(skipReason(c), c).toBe('secret');
  });

  it('skips commands that start with a space, like HISTCONTROL=ignorespace', () => {
    expect(skipReason(' cat ~/.secret')).toBe('leading_space');
    expect(skipReason('   ')).toBe('empty');
  });
});

describe('history store', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
    await setupAdmin(t);
    await t.json('POST', '/api/hosts', { name: 'h', address: 'h.lan' });
  });
  afterEach(async () => {
    await t.close();
  });

  it('a history imported twice counts once, and an older use does not hide a newer one (AUDIT2 FS-29)', () => {
    const day = 86_400_000;
    const at = (d: number) => Math.floor((t.clock.now - d * day) / 1000);
    // zsh's extended history: ": <epoch>:0;<command>".
    const zsh = `: ${at(2)}:0;git status\n: ${at(1)}:0;git status\n`;
    const bash = 'ls -la\nls -la\n';
    expect(importHistory(t.ctx, 1, [bash, zsh], t.clock.now - 30 * day)).toEqual({ imported: 4, skipped: 0 });
    expect(importHistory(t.ctx, 1, [bash, zsh], t.clock.now - 30 * day)).toEqual({ imported: 0, skipped: 4 });
    const counts = Object.fromEntries(listHistory(t.ctx, 1, 10).map((e) => [e.command, e.count]));
    expect(counts).toEqual({ 'git status': 2, 'ls -la': 2 });
    // Used just now, then an import brings an old use of it: the time stays now.
    recordCommand(t.ctx, 1, 'uptime', t.clock.now);
    importHistory(t.ctx, 1, [`: ${at(20)}:0;uptime\n`], t.clock.now - 30 * day);
    expect(listHistory(t.ctx, 1, 10).find((e) => e.command === 'uptime')!.lastAt).toBe(new Date(t.clock.now).toISOString());
  });

  it('counts repeats, encrypts the text and ranks by frecency', () => {
    const day = 86_400_000;
    recordCommand(t.ctx, 1, 'ls', t.clock.now - 60 * day);
    recordCommand(t.ctx, 1, 'ls', t.clock.now - 59 * day);
    recordCommand(t.ctx, 1, 'ls', t.clock.now - 58 * day);
    recordCommand(t.ctx, 1, 'docker ps', t.clock.now);
    expect(recordCommand(t.ctx, 1, ' secret thing')).toBe(false);
    expect(recordCommand(t.ctx, 1, SECRETS[0]!)).toBe(false);

    const rows = t.ctx.db.select().from(commandHistory).all();
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('docker ps');

    const list = listHistory(t.ctx, 1, 10);
    // Used once today beats used three times two months ago.
    expect(list.map((e) => e.command)).toEqual(['docker ps', 'ls']);
    expect(list[1]?.count).toBe(3);
  });

  it('a command used once and not again in 30 days is forgotten; used more often, it stays (report 94c9eb)', () => {
    const day = 86_400_000;
    recordCommand(t.ctx, 1, 'once long ago', t.clock.now - 31 * day);
    recordCommand(t.ctx, 1, 'once lately', t.clock.now - 29 * day);
    recordCommand(t.ctx, 1, 'twice long ago', t.clock.now - 41 * day);
    recordCommand(t.ctx, 1, 'twice long ago', t.clock.now - 40 * day);
    recordCommand(t.ctx, 1, 'now', t.clock.now);
    expect(listHistory(t.ctx, 1, 10).map((e) => e.command).sort()).toEqual(['now', 'once lately', 'twice long ago']);
  });

  it('learns which command follows which, and forgets it with either', () => {
    const run = (...cmds: string[]) => cmds.reduce<string | null>((prev, c) => (recordCommand(t.ctx, 1, c, t.clock.now, prev), c), null);
    run('cd /srv/app', 'docker compose logs -f');
    run('cd /srv/app', 'docker compose logs -f');
    run('cd /srv/app', 'git pull');
    // A secret is never learnt as next, nor as before.
    run('cd /srv/app', ' export TOKEN=abc');
    const next = (c: string) => listHistory(t.ctx, 1, 50).find((e) => e.command === c)?.next;
    expect(next('cd /srv/app')).toEqual(['docker compose logs -f', 'git pull']);
    expect(next('git pull')).toEqual([]);
    expect(JSON.stringify(t.ctx.db.select().from(commandPairs).all())).not.toContain('docker');
    // Forgetting the follower takes it out of the suggestions.
    deleteCommand(t.ctx, 1, 'docker compose logs -f');
    expect(next('cd /srv/app')).toEqual(['git pull']);
  });

  it('serves, deletes and clears history through the API', async () => {
    recordCommand(t.ctx, 1, 'uptime');
    recordCommand(t.ctx, 1, 'df -h');
    expect(await t.json<{ command: string }[]>('GET', '/api/hosts/1/history')).toHaveLength(2);
    await t.json('POST', '/api/hosts/1/history/forget', { command: 'uptime' });
    expect((await t.json<{ command: string }[]>('GET', '/api/hosts/1/history')).map((e) => e.command)).toEqual(['df -h']);
    await t.json('DELETE', '/api/hosts/1/history');
    expect(await t.json('GET', '/api/hosts/1/history')).toEqual([]);
  });
});

describe('suggested snippets', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
    await setupAdmin(t);
    await t.json('POST', '/api/hosts', { name: 'h', address: 'h.lan' });
    await t.json('POST', '/api/hosts', { name: 'i', address: 'i.lan' });
  });
  afterEach(async () => {
    await t.close();
  });

  it('offers commands typed often on all hosts together, not the quick ones, not a snippet yet, not hidden', async () => {
    const times = (host: number, c: string, n: number) => {
      for (let i = 0; i < n; i++) recordCommand(t.ctx, host, c, t.clock.now - i * 1000);
    };
    times(1, 'docker compose -f /srv/media/compose.yaml logs -f sonarr', 2);
    times(2, 'docker compose -f /srv/media/compose.yaml logs -f sonarr', 2);
    times(1, 'sudo apt update && sudo apt upgrade -y', 5);
    times(1, 'journalctl -u nginx -n 100', 2);
    times(1, 'ls -la', 9);
    times(1, 'cd /srv/media', 9);
    times(1, 'htop', 9);
    times(1, 'systemctl status wg-quick@wg0', 3);
    const got = (await t.json('GET', '/api/snippets/suggestions')) as { command: string; count: number; hostIds: number[] }[];
    expect(got.map((s) => [s.command, s.count, s.hostIds])).toEqual([
      ['sudo apt update && sudo apt upgrade -y', 5, [1]],
      ['docker compose -f /srv/media/compose.yaml logs -f sonarr', 4, [1, 2]],
      ['systemctl status wg-quick@wg0', 3, [1]],
    ]);
    // Saved as a snippet: no longer offered. Hidden: neither, also after more typing.
    await t.json('POST', '/api/snippets', { name: 'upgrade', command: 'sudo apt update && sudo apt upgrade -y' });
    const hide = await t.request('POST', '/api/snippets/suggestions/dismiss', { command: 'systemctl status wg-quick@wg0' });
    expect(hide.statusCode).toBe(204);
    times(1, 'systemctl status wg-quick@wg0', 3);
    const after = (await t.json('GET', '/api/snippets/suggestions')) as { command: string }[];
    expect(after.map((s) => s.command)).toEqual(['docker compose -f /srv/media/compose.yaml logs -f sonarr']);
    // Still in the history: completion keeps offering it.
    expect(listHistory(t.ctx, 1, 50).some((e) => e.command === 'systemctl status wg-quick@wg0')).toBe(true);
  });
});

describe('frecency', () => {
  it('rises with use and falls with age', () => {
    const now = Date.now();
    expect(frecency(10, now, now)).toBeGreaterThan(frecency(1, now, now));
    expect(frecency(5, now, now)).toBeGreaterThan(frecency(5, now - 40 * 86_400_000, now));
  });
});

describe('parseHistoryFile', () => {
  it('reads plain bash, timestamped bash and extended zsh history', () => {
    const bash = 'ls\n#1700000000\ncd /data\necho a \\\n  b\n\n';
    expect(parseHistoryFile(bash)).toEqual([
      { command: 'ls', at: null },
      { command: 'cd /data', at: 1_700_000_000_000 },
      { command: 'echo a \n  b', at: null },
    ]);
    const zsh = ': 1700000000:0;git status\n: 1700000100:3;make test\n';
    expect(parseHistoryFile(zsh)).toEqual([
      { command: 'git status', at: 1_700_000_000_000 },
      { command: 'make test', at: 1_700_000_100_000 },
    ]);
  });
});
