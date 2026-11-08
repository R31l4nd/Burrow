import { describe, expect, it } from 'vitest';
import type { Client, SFTPWrapper } from 'ssh2';
import { EventEmitter } from 'node:events';
import { checksumMismatches, normalize, parseChecksums, writeText } from '../../src/files/service.js';
import { createHash } from 'node:crypto';

// An SFTP server in memory, without the posix-rename extension (as some
// servers are), whose plain rename can be made to fail.
function fakeSftp(files: Map<string, Buffer>, opts: { failRename?: (from: string, to: string) => boolean } = {}) {
  const enoent = () => Object.assign(new Error('No such file'), { code: 2 });
  const s = {
    stat: (path: string, cb: (e: Error | null, st?: unknown) => void) =>
      files.has(path) ? cb(null, { mode: 0o100640, size: files.get(path)!.length, mtime: 0, uid: 0, gid: 0, isDirectory: () => false }) : cb(enoent()),
    readFile: (path: string, cb: (e: Error | null, b?: Buffer) => void) => (files.has(path) ? cb(null, files.get(path)) : cb(enoent())),
    open: (path: string, _flags: string, cb: (e: Error | null, h?: Buffer) => void) => (files.has(path) || _flags !== 'r' ? cb(null, Buffer.from(path)) : cb(enoent())),
    read: (h: Buffer, buf: Buffer, off: number, len: number, pos: number, cb: (e: Error | null, n?: number) => void) => {
      const data = files.get(h.toString()) ?? Buffer.alloc(0);
      cb(null, data.copy(buf, off, pos, Math.min(data.length, pos + len)));
    },
    close: (_h: Buffer, cb: (e: Error | null) => void) => cb(null),
    writeFile: (path: string, body: Buffer, _o: unknown, cb: (e: Error | null) => void) => (files.set(path, Buffer.from(body)), cb(null)),
    chmod: (_p: string, _m: number, cb: (e: Error | null) => void) => cb(null),
    unlink: (path: string, cb: (e: Error | null) => void) => (files.delete(path) ? cb(null) : cb(enoent())),
    ext_openssh_rename: () => {
      throw new Error('Server does not support this extended request');
    },
    rename: (from: string, to: string, cb: (e: Error | null) => void) => {
      if (opts.failRename?.(from, to)) return cb(new Error('Permission denied'));
      if (files.has(to)) return cb(new Error('Failure'));
      if (!files.has(from)) return cb(enoent());
      files.set(to, files.get(from)!);
      files.delete(from);
      cb(null);
    },
  };
  return s as unknown as SFTPWrapper;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

describe('saving text without posix-rename', () => {
  it('another error than a missing extension is not a reason to work around it', async () => {
    const files = new Map([['/srv/a.conf', Buffer.from('old')]]);
    const sftp = fakeSftp(files) as unknown as { ext_openssh_rename: (a: string, b: string, cb: (e: Error) => void) => void };
    sftp.ext_openssh_rename = (_a, _b, cb) => cb(new Error('Permission denied'));
    await expect(writeText(sftp as unknown as SFTPWrapper, '/srv/a.conf', 'new', hash('old'))).rejects.toThrow();
    expect(files.get('/srv/a.conf')?.toString()).toBe('old');
    expect([...files.keys()]).toEqual(['/srv/a.conf']);
  });

  it('replaces the file, and leaves nothing beside it', async () => {
    const files = new Map([['/srv/a.conf', Buffer.from('old')]]);
    const r = await writeText(fakeSftp(files), '/srv/a.conf', 'new', hash('old'));
    expect(r.ok).toBe(true);
    expect(files.get('/srv/a.conf')?.toString()).toBe('new');
    expect([...files.keys()]).toEqual(['/srv/a.conf']);
  });

  it("another user's file whose owner cannot be kept: refused, not saved as this user's (AUDIT2 FS-09)", async () => {
    const files = new Map([['/srv/a.conf', Buffer.from('old')]]);
    const sftp = fakeSftp(files) as unknown as Record<string, unknown>;
    const stat0 = sftp.stat as (p: string, cb: (e: Error | null, st?: unknown) => void) => void;
    // The target belongs to uid 1000; what this user writes is theirs (uid 0 here), and chown is not allowed.
    sftp.stat = (p: string, cb: (e: Error | null, st?: { uid: number }) => void) => stat0(p, (e, st) => cb(e, st ? ({ ...(st as object), uid: p === '/srv/a.conf' ? 1000 : 0 } as never) : undefined));
    sftp.chown = (_p: string, _u: number, _g: number, cb: (e: Error | null) => void) => cb(Object.assign(new Error('Permission denied'), { code: 3 }));
    await expect(writeText(sftp as unknown as SFTPWrapper, '/srv/a.conf', 'new', hash('old'))).rejects.toMatchObject({ code: 'owner_would_change' });
    expect(files.get('/srv/a.conf')?.toString()).toBe('old');
    expect([...files.keys()]).toEqual(['/srv/a.conf']);
  });

  it('a rename that fails keeps the original: it was deleted first, and the new text with it', async () => {
    const files = new Map([['/srv/a.conf', Buffer.from('old')]]);
    // The new text cannot take the file's place (the old one back can).
    const fail = (from: string, to: string) => to === '/srv/a.conf' && from.includes('.burrow-') && !from.includes('.burrow-old-');
    await expect(writeText(fakeSftp(files, { failRename: fail }), '/srv/a.conf', 'new', hash('old'))).rejects.toThrow();
    expect(files.get('/srv/a.conf')?.toString()).toBe('old');
    expect([...files.keys()]).toEqual(['/srv/a.conf']);
  });
});

describe('reading text for the editor', () => {
  it('stops at the limit while it reads: a file that said 1 byte and had 6 MB was read whole', async () => {
    const { readText } = await import('../../src/files/service.js');
    const files = new Map([['/proc/odd', Buffer.alloc(6 * 1024 * 1024, 0x61)]]);
    const sftp = fakeSftp(files) as unknown as { stat: (p: string, cb: (e: null, st: unknown) => void) => void };
    sftp.stat = (_p, cb) => cb(null, { mode: 0o100644, size: 1, mtime: 0, uid: 0, gid: 0, isDirectory: () => false });
    await expect(readText(sftp as unknown as SFTPWrapper, '/proc/odd')).rejects.toMatchObject({ status: 413 });
    const small = new Map([['/a.txt', Buffer.from('hello')]]);
    expect(await readText(fakeSftp(small), '/a.txt')).toMatchObject({ content: 'hello', size: 5 });
  });

  it('a file that is not UTF-8 is refused, not opened with its bytes replaced; a byte order mark stays (AUDIT2 FS-30)', async () => {
    const { readText } = await import('../../src/files/service.js');
    const latin1 = new Map([['/old.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])]]);
    await expect(readText(fakeSftp(latin1), '/old.txt')).rejects.toMatchObject({ status: 415, code: 'not_utf8' });
    const bom = new Map([['/bom.txt', Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])]]);
    expect((await readText(fakeSftp(bom), '/bom.txt')).content).toBe('\ufeffhi');
  });
});

describe('a path that cannot be looked at (AUDIT2 FS-12)', () => {
  it('is an error, not "not there"; only a missing one is null', async () => {
    const { stat } = await import('../../src/files/service.js');
    const denied = { stat: (_p: string, cb: (e: Error) => void) => cb(Object.assign(new Error('Permission denied'), { code: 3 })) } as unknown as SFTPWrapper;
    await expect(stat(denied, '/root/x')).rejects.toMatchObject({ status: 403 });
    expect(await stat(fakeSftp(new Map()), '/gone')).toBeNull();
  });
});

describe('a copy between hosts, checked by sha256 (N8)', () => {
  const h = (c: string) => c.repeat(64);
  it("reads sha256sum's lines, binary mode and escaped names too", () => {
    const m = parseChecksums(`${h('a')}  ./photos/a.jpg\n${h('b')} *./b.bin\n\\${h('c')}  ./odd\\nname\nnot a line\n`);
    expect([...m]).toEqual([
      ['./photos/a.jpg', h('a')],
      ['./b.bin', h('b')],
      ['./odd\\nname', h('c')],
    ]);
  });
  it('strictly read: a line that is not a sum is an error, not a file left out (AUDIT2 FS-11)', () => {
    expect(() => parseChecksums(`${h('a')}  ./a\nsha256sum: ./b: Permission denied\n`, true)).toThrow(/unreadable line/);
    expect(parseChecksums(`${h('a')}  ./a\n\n`, true).size).toBe(1);
  });
  it('names the files that differ or are missing on the destination; extra ones there are not the copy', () => {
    const src = new Map([['./a', h('a')], ['./b', h('b')], ['./c', h('c')]]);
    const dst = new Map([['./a', h('a')], ['./b', h('d')], ['./old', h('e')]]);
    expect(checksumMismatches(src, dst)).toEqual(['./b', './c']);
    expect(checksumMismatches(src, new Map(src))).toEqual([]);
  });
});

describe('what a recursive change refuses', () => {
  it('the home and the root however they are written (AUDIT2 FS-24)', async () => {
    const { guardDestructive } = await import('../../src/files/service.js');
    for (const p of ['/', '//', '/.', '/home/me', '/home/me/', '//home//me', '/home/me/.', '/home/x/../me']) expect(() => guardDestructive(p, '/home/me'), p).toThrow(/will not/);
    expect(() => guardDestructive('/home/me/project', '/home/me')).not.toThrow();
  });
});

describe('a copy between hosts, its channels (AUDIT2 FS-10, FS-27)', () => {
  // A host whose exec answers with a stream set up by the test, or fails.
  type Fake = { client: Client; streams: ReturnType<typeof stream>[] };
  function stream() {
    const s = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      closed: false,
      written: 0,
      write: (d: Buffer) => ((s.written += d.length), true),
      end: () => {},
      pause: () => {},
      resume: () => {},
      close: () => {
        s.closed = true;
        s.emit('close', null);
      },
    });
    return s;
  }
  function host(fail = false, cmds: string[] = []): Fake {
    const streams: ReturnType<typeof stream>[] = [];
    const client = {
      exec: (cmd: string, _o: unknown, cb: (e: Error | null, ch?: unknown) => void) => {
        if (fail) return cb(new Error('refused'));
        cmds.push(cmd);
        const s = stream();
        streams.push(s);
        cb(null, s);
      },
    } as unknown as Client;
    return { client, streams };
  }

  it('the destination unpacks only what was asked for, as its own user, without set-user-id bits (audit 2026-11-05)', async () => {
    const { execFileSync } = await import('node:child_process');
    const { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { copyBetweenHosts } = await import('../../src/files/service.js');
    const root = mkdtempSync(join(tmpdir(), 'burrow-copy-'));
    try {
      // What a source that is not to be trusted sends: the folder asked for, and more beside it.
      for (const d of ['src/photos', 'src/.ssh']) mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, 'src/photos/a.jpg'), 'a');
      writeFileSync(join(root, 'src/photos/run'), 'b');
      chmodSync(join(root, 'src/photos/run'), 0o4755);
      writeFileSync(join(root, 'src/.ssh/authorized_keys'), 'ssh-ed25519 AAAA evil');
      writeFileSync(join(root, 'src/st*r'), 'c');
      writeFileSync(join(root, 'src/star'), 'd');
      const archive = execFileSync('tar', ['-C', join(root, 'src'), '-cf', '-', 'photos', '.ssh', 'st*r', 'star']);
      // A name is a name, not a pattern that takes others along.
      for (const [asked, got, notGot] of [['photos', ['photos/a.jpg', 'photos/run'], ['.ssh', 'star', 'st*r']], ['st*r', ['st*r'], ['.ssh', 'star', 'photos']]] as [string, string[], string[]][]) {
        const dst = join(root, 'dst');
        mkdirSync(dst);
        const cmds: string[] = [];
        const src = host();
        const to = host(false, cmds);
        const done = copyBetweenHosts(src.client, to.client, [`/x/${asked}`], dst, true);
        await new Promise((r) => setTimeout(r, 10));
        // The destination's command, run here on the archive the source sent.
        expect(cmds[0]).toContain('--no-same-owner');
        expect(cmds[0]).toContain('--no-same-permissions');
        execFileSync('sh', ['-c', cmds[0]!], { input: archive });
        for (const n of got) expect(existsSync(join(dst, n)), `${asked}: ${n}`).toBe(true);
        for (const n of notGot) expect(existsSync(join(dst, n)), `${asked}: ${n}`).toBe(false);
        if (asked === 'photos') expect(statSync(join(dst, 'photos/run')).mode & 0o6000).toBe(0);
        src.streams[0]!.emit('close', 0);
        to.streams[0]!.emit('close', 0);
        await done;
        rmSync(dst, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the destination refused: the source channel opened for it is closed again', async () => {
    const { copyBetweenHosts } = await import('../../src/files/service.js');
    const src = host();
    const dst = host(true);
    await expect(copyBetweenHosts(src.client, dst.client, ['/a/x'], '/b', true)).rejects.toThrow();
    expect(src.streams[0]?.closed).toBe(true);
  });

  it('the source ended without an exit status: failed, not copied', async () => {
    const { copyBetweenHosts } = await import('../../src/files/service.js');
    const src = host();
    const dst = host();
    const done = copyBetweenHosts(src.client, dst.client, ['/a/x'], '/b', true);
    await new Promise((r) => setTimeout(r, 10));
    src.streams[0]!.emit('close', null);
    dst.streams[0]!.emit('close', 0);
    await expect(done).rejects.toThrow(/exit status/);
  });

  it('the bytes of two folders add up, not start again at the second', async () => {
    const { copyBetweenHosts } = await import('../../src/files/service.js');
    const src = host();
    const dst = host();
    const seen: number[] = [];
    const done = copyBetweenHosts(src.client, dst.client, ['/a/x', '/c/y'], '/b', true, (n) => seen.push(n));
    for (let i = 0; i < 2; i++) {
      await new Promise((r) => setTimeout(r, 10));
      src.streams[i]!.emit('data', Buffer.alloc(100));
      src.streams[i]!.emit('close', 0);
      dst.streams[i]!.emit('close', 0);
    }
    expect(await done).toBe(200);
    expect(seen.at(-1)).toBe(200);
  });
});

describe('a path as typed', () => {
  it('~ and ~/ are the home; ~name is not the home with a name glued on (audit 2026-10-30)', () => {
    expect(normalize('~', '/home/alice')).toBe('/home/alice');
    expect(normalize('~/x/', '/home/alice')).toBe('/home/alice/x');
    expect(normalize('notes', '/home/alice')).toBe('/home/alice/notes');
    expect(normalize('~bob/x', '/home/alice')).not.toBe('/home/alicebob/x');
  });
});
