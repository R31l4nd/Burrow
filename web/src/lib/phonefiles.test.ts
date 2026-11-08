import { describe, expect, it, vi } from 'vitest';

// The little of a browser the module reads when it loads (the language).
vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: {}, hidden: false, addEventListener() {}, removeEventListener() {} } });
});

const { MAX_VIEW, phoneCrumbs, reportedPage, phoneDir, phoneFailure, phonePath, phoneTextSource, readHeld, sortEntries } = await import('./phonefiles.js');
type Bridge = import('./phonefiles.js').PhoneBridge;
type Entry = import('./android.js').PhoneEntry;

// The phone's own files on the Files page (report a9552e): the page's side
// of the bridge. The app checks every path again (PhonePathsTest).

const ID = '0123456789abcdef';

describe('a phone path from the address', () => {
  it('is a granted folder and names in it, or the list of folders', () => {
    expect(phonePath(`/${ID}/Notes/todo.txt`)).toBe(`/${ID}/Notes/todo.txt`);
    expect(phonePath(`/${ID}/`)).toBe(`/${ID}`);
    expect(phonePath('/')).toBe('/');
    expect(phonePath(undefined)).toBe('/');
  });

  it('never leads out of a folder: anything else is the list of folders', () => {
    for (const bad of [`/${ID}/../x`, `/${ID}/./x`, `/${ID}/a//b`, '/etc/passwd', 'relative', `/${ID.toUpperCase()}/x`, '/primary:Download', `/${ID}/a\0b`, '/..']) {
      expect(phonePath(bad), bad).toBe('/');
    }
  });

  it("goes up to a file's folder, and from the folder's names back to it", () => {
    expect(phoneDir(`/${ID}/a/b.txt`)).toBe(`/${ID}/a`);
    expect(phoneDir(`/${ID}/b.txt`)).toBe(`/${ID}`);
    const l = { path: `/${ID}/a/b`, parent: `/${ID}/a`, root: { id: ID, name: 'Documents' }, names: ['a', 'b'], canCreate: true, truncated: false, entries: [] };
    expect(phoneCrumbs(l)).toEqual([
      { name: 'Documents', path: `/${ID}` },
      { name: 'a', path: `/${ID}/a` },
      { name: 'b', path: `/${ID}/a/b` },
    ]);
  });
});

describe('a problem report sent from the phone\'s files', () => {
  it('names the page, not the file of the phone', () => {
    expect(reportedPage(`/files/phone?p=%2F${ID}%2Fsecret.txt`)).toBe('/files/phone');
    expect(reportedPage(`/edit/phone?p=%2F${ID}%2Fsecret.txt&ro=1`)).toBe('/edit/phone');
    // A host's file is named as before.
    expect(reportedPage('/files/3?p=%2Fetc')).toBe('/files/3?p=%2Fetc');
    expect(reportedPage('/files/phonebook?p=x')).toBe('/files/phonebook?p=x');
  });
});

describe("a phone folder's entries", () => {
  const e = (name: string, type: 'dir' | 'file' = 'file'): Entry => ({ name, path: `/${ID}/${name}`, type, size: 1, mtime: null, mime: 'text/plain', writable: true });
  it('come folders first, by name with numbers as numbers; hidden ones only when asked', () => {
    const list = [e('b10.txt'), e('.secret'), e('b9.txt'), e('Zeta', 'dir'), e('alpha', 'dir'), e('A.txt')];
    expect(sortEntries(list, false).map((x) => x.name)).toEqual(['alpha', 'Zeta', 'A.txt', 'b9.txt', 'b10.txt']);
    expect(sortEntries(list, true).map((x) => x.name)).toContain('.secret');
  });
});

/** A stand-in for the app: a text file, and held files read in pieces. */
function fake(over: Partial<Bridge> = {}): Bridge & { reads: number[]; released: string[] } {
  const reads: number[] = [];
  const released: string[] = [];
  return {
    reads,
    released,
    phoneText: async (path) => ({ path, content: 'hello\n', hash: 'h1', size: 6, mtime: '2026-10-12T14:49:37.000Z', writable: true }),
    phoneSaveText: async (path, content) => ({ path, content, hash: 'h2', size: content.length, mtime: null, writable: true }),
    read: async (_token, offset, length) => {
      reads.push(length);
      const all = 'x'.repeat(2.5 * 1024 * 1024);
      return { data: btoa(all.slice(offset, offset + length)) };
    },
    release: async (token) => void released.push(token),
    ...over,
  };
}

describe("the editor's source for a phone's text file", () => {
  it('reads it, and writes it only over the version read', async () => {
    const src = phoneTextSource(fake(), `/${ID}/a.txt`, false);
    expect(await src.read()).toMatchObject({ content: 'hello\n', hash: 'h1', writable: true, mode: 0 });
    expect(await src.write('new\n', 'h1')).toMatchObject({ content: 'new\n', hash: 'h2' });
  });

  it('says a change on the phone meanwhile as a conflict, as a host does', async () => {
    const src = phoneTextSource(fake({ phoneSaveText: async () => ({ conflict: true }) }), `/${ID}/a.txt`, false);
    await expect(src.write('new\n', 'old')).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });

  it('opened to read: read only, and a write refused before it reaches the phone', async () => {
    let wrote = false;
    const src = phoneTextSource(
      fake({
        phoneSaveText: async () => {
          wrote = true;
          return { conflict: true };
        },
      }),
      `/${ID}/a.txt`,
      true,
    );
    expect((await src.read()).writable).toBe(false);
    await expect(src.write('x', 'h1')).rejects.toMatchObject({ code: 'read_only' });
    expect(wrote).toBe(false);
  });

  it("gives the app's refusal in words, with its code", async () => {
    const src = phoneTextSource(fake({ phoneText: () => Promise.reject(new Error('too_large')) }), `/${ID}/big.log`, false);
    await expect(src.read()).rejects.toMatchObject({ code: 'too_large', message: 'The editor opens files up to 5 MB.' });
    expect(phoneFailure(new Error('no_access')).message).toContain('Add it again');
    // Something the page has no words for: said as it came.
    expect(phoneFailure(new Error('disk on fire'))).toMatchObject({ code: 'phone', message: 'disk on fire' });
    // Not even an Error (a bridge that rejects with a bare value): its words all the same.
    expect(phoneFailure('no_access')).toMatchObject({ code: 'no_access' });
    expect(phoneFailure(42)).toMatchObject({ code: 'phone', message: '42' });
  });
});

describe('a held file read whole', () => {
  it('in pieces of at most 1 MiB, then let go', async () => {
    const b = fake();
    const blob = await readHeld(b, { token: 't1', name: 'p.jpg', mime: 'image/jpeg', size: 2.5 * 1024 * 1024 });
    expect(blob.size).toBe(2.5 * 1024 * 1024);
    expect(blob.type).toBe('image/jpeg');
    expect(Math.max(...b.reads)).toBe(1 << 20);
    expect(b.released).toEqual(['t1']);
  });

  it('a file shorter than the app said (changed meanwhile): what there is, not a read for ever', async () => {
    const b = fake({ read: async (_t, offset) => ({ data: offset === 0 ? btoa('abc') : '' }) });
    const blob = await readHeld(b, { token: 't3', name: 'n.txt', mime: 'text/plain', size: 10 });
    expect(await blob.text()).toBe('abc');
    expect(b.released).toEqual(['t3']);
  });

  it('refused above the limit, and let go all the same', async () => {
    const b = fake();
    await expect(readHeld(b, { token: 't2', name: 'big.png', mime: 'image/png', size: MAX_VIEW + 1 })).rejects.toMatchObject({ code: 'too_large' });
    expect(b.reads).toEqual([]);
    expect(b.released).toEqual(['t2']);
  });
});
