import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' }, hidden: false } });
});
const { readFirst, updateServices } = await import('./stackupdate.js');
const { asking, answered } = await import('./confirm.svelte.js');
const { t } = await import('./i18n/index.svelte.js');

// Updating a stack's services by hand: the release notes in between first.
// Nothing to read: on at once. A breaking change, or notes that could not be
// read (AUDIT2 WEB-09), wait for a yes.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const flags = (breaking: string[] = []) => ({ breaking, major: false, security: false, important: false });
const notes = (byImage: Record<string, { name: string; flags: ReturnType<typeof flags> }[] | null>) =>
  vi.fn(async (url: string) => {
    const image = new URL(url, 'http://x').searchParams.get('image')!;
    const r = byImage[image];
    return r ? json({ url: '', releases: r, matched: true, breaking: 0 }) : json({ error: 'not_found', message: 'No notes.' }, 404);
  });

afterEach(() => {
  vi.unstubAllGlobals();
  if (asking.q) answered(null);
});

describe('release notes before an update', () => {
  it('nothing that asks to be read: yes without a question, each image asked once', async () => {
    const fetch = notes({ 'nginx:1': [{ name: '1.27.1', flags: flags() }] });
    vi.stubGlobal('fetch', fetch);
    expect(await readFirst(3, ['nginx:1', 'nginx:1'])).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('/api/docker/3/changelog?image=nginx%3A1');
    expect(asking.q).toBeNull();
  });

  it('a breaking change: named, and the answer decides', async () => {
    vi.stubGlobal('fetch', notes({ 'ghcr.io/acme/app:2': [{ name: 'v2.0.0', flags: flags(['PORT is now HTTP_PORT']) }] }));
    const go = readFirst(3, ['ghcr.io/acme/app:2']);
    await vi.waitFor(() => expect(asking.q).not.toBeNull());
    expect(asking.q).toMatchObject({ text: t('updates.breakingAsk'), danger: true, items: [{ title: 'acme/app:2', lines: ['v2.0.0: PORT is now HTTP_PORT'] }] });
    answered('');
    expect(await go).toBe(true);

    const no = readFirst(3, ['ghcr.io/acme/app:2']);
    await vi.waitFor(() => expect(asking.q).not.toBeNull());
    answered(null);
    expect(await no).toBe(false);
  });

  it('notes that could not be read are not "nothing to read": asked as well (AUDIT2 WEB-09)', async () => {
    vi.stubGlobal('fetch', notes({ 'nginx:1': [{ name: '1.27.1', flags: flags() }], 'private/app:latest': null }));
    const go = readFirst(3, ['nginx:1', 'private/app:latest']);
    await vi.waitFor(() => expect(asking.q).not.toBeNull());
    expect(asking.q!.items).toEqual([{ title: 'private/app:latest', lines: [t('updates.notesUnread')] }]);
    answered(null);
    expect(await go).toBe(false);
  });

  it('notes that cannot be read are asked about once per stack; a breaking change always (decision 9)', async () => {
    let waived = false;
    const changelog = notes({ 'private/app:latest': null, 'ghcr.io/acme/app:2': [{ name: 'v2.0.0', flags: flags(['PORT is now HTTP_PORT']) }] });
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/stacks/shop/notes')) return json({ waived });
      if (url.endsWith('/stacks/shop/notes/waive') && init?.method === 'POST') return ((waived = true), json({ waived: true }));
      return changelog(url);
    });
    vi.stubGlobal('fetch', fetch);
    const first = readFirst(3, ['private/app:latest'], 'shop');
    await vi.waitFor(() => expect(asking.q).not.toBeNull());
    answered('');
    expect(await first).toBe(true);
    expect(waived).toBe(true);
    // The next update of this stack: not asked again for its notes.
    expect(await readFirst(3, ['private/app:latest'], 'shop')).toBe(true);
    expect(asking.q).toBeNull();
    // A breaking change still is.
    const breaking = readFirst(3, ['private/app:latest', 'ghcr.io/acme/app:2'], 'shop');
    await vi.waitFor(() => expect(asking.q).not.toBeNull());
    answered(null);
    expect(await breaking).toBe(false);
  });

  it("the update itself: the stack's operation for just those services", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ id: 'op7' }));
    vi.stubGlobal('fetch', fetch);
    expect(await updateServices(3, 'my app', ['web', 'db'])).toEqual({ id: 'op7' });
    expect(fetch.mock.calls[0]![0]).toBe('/api/docker/3/stacks/my%20app/ops');
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ op: 'update', services: ['web', 'db'] });
  });
});
