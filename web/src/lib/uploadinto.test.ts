import { beforeEach, describe, expect, it, vi } from 'vitest';

// Files into a folder the same way from the picker and from a drop (report 6d86aa): a name there
// already asked, a dropped folder left out and said.
const uploads: { dir: string; names: string[]; overwrite: boolean }[] = [];
const shown: string[] = [];
let answer: 'confirm' | 'other' | null = 'other';
let listed: string[] = [];
vi.mock('./api.js', () => ({ get: async () => ({ path: '/srv/data', parent: '/srv', home: '/home/x', entries: listed.map((name) => ({ name })) }) }));
vi.mock('./confirm.svelte.js', () => ({ choose: async () => answer }));
vi.mock('./files.svelte.js', () => ({ upload: (_h: number, dir: string, files: { name: string }[], _d: unknown, overwrite = false) => uploads.push({ dir, names: files.map((f) => f.name), overwrite }) }));
vi.mock('./i18n/index.svelte.js', () => ({ t: (k: string) => k }));
vi.mock('./ui.svelte.js', () => ({ toast: (text: string) => shown.push(text) }));
const { dragsFiles, droppedFiles, freeName, uploadInto } = await import('./uploadinto.js');

const file = (name: string) => ({ name, size: 1, slice: () => new Blob(['x']) });

describe('uploadInto', () => {
  beforeEach(() => {
    uploads.length = 0;
    shown.length = 0;
  });

  it('a free name, not taken: app (1).yaml, then app (2).yaml', () => {
    expect(freeName('app.yaml', new Set(['app.yaml']))).toBe('app (1).yaml');
    expect(freeName('app.yaml', new Set(['app.yaml', 'app (1).yaml']))).toBe('app (2).yaml');
    expect(freeName('README', new Set(['README']))).toBe('README (1)');
  });

  it('new names go up at once; one there already: kept both, replaced, or left out as answered', async () => {
    listed = ['a.txt', 'b.txt'];
    answer = 'other';
    await uploadInto(1, '/srv/data', [file('new.txt'), file('a.txt')]);
    expect(uploads).toEqual([{ dir: '/srv/data', names: ['new.txt', 'a (1).txt'], overwrite: false }]);
    uploads.length = 0;
    answer = 'confirm';
    await uploadInto(1, '/srv/data', [file('b.txt')]);
    expect(uploads).toEqual([{ dir: '/srv/data', names: ['b.txt'], overwrite: true }]);
    uploads.length = 0;
    answer = null;
    await uploadInto(1, '/srv/data', [file('b.txt')]);
    expect(uploads).toEqual([]);
    await uploadInto(1, '/srv/data', []);
    expect(uploads).toEqual([]);
  });

  it('a drag of files is told from one of text; a dropped folder is left out and said', () => {
    const drag = (types: string[]) => ({ dataTransfer: { types } }) as unknown as DragEvent;
    expect(dragsFiles(drag(['Files']))).toBe(true);
    expect(dragsFiles(drag(['text/plain']))).toBe(false);
    expect(dragsFiles({ dataTransfer: null } as unknown as DragEvent)).toBe(false);
    const f1 = { name: 'one.txt' };
    const dir = { name: 'photos' };
    const drop = {
      dataTransfer: {
        items: [
          { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) },
          { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) },
        ],
        files: [f1, dir],
      },
    } as unknown as DragEvent;
    expect(droppedFiles(drop)).toEqual([f1]);
    expect(shown).toEqual(['files.dropNoFolders']);
    const plain = { dataTransfer: { items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) }], files: [f1] } } as unknown as DragEvent;
    expect(droppedFiles(plain)).toEqual([f1]);
  });
});
