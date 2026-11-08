import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthState } from '@burrow/shared';

vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' }, hidden: false } });
});
const { activity, nudgeActivity, startActivity, stopActivity } = await import('./activity.svelte.js');
const { setSession } = await import('./session.svelte.js');

// The busy pill's source: what runs on the server, asked every few seconds,
// every second while something runs; an answer that comes after a stop, or
// after a newer look, is dropped (AUDIT2 WEB-11); another account starts
// from nothing (AUDIT2 WEB-01).

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const op = { id: 'op1', hostId: 1, project: 'web', op: 'update', state: 'running' };
let answer: { ops: unknown[]; check: unknown } = { ops: [], check: null };
let asked: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  asked = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (asked.push(url), url === '/api/reports/progress' ? json(null) : json(answer))));
});
afterEach(() => {
  stopActivity();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const looks = () => asked.filter((u) => u === '/api/docker/activity').length;

describe('what runs on the server', () => {
  it('asked every five seconds when idle, every second while something runs', async () => {
    answer = { ops: [], check: null };
    startActivity();
    startActivity();
    await vi.advanceTimersByTimeAsync(0);
    expect(looks()).toBe(1);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(looks()).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(looks()).toBe(2);
    answer = { ops: [op], check: null };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(activity.ops).toEqual([op]);
    const n = looks();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(looks()).toBe(n + 1);
  });

  it('something just started here: looked at once, then every second for a while', async () => {
    answer = { ops: [], check: null };
    startActivity();
    await vi.advanceTimersByTimeAsync(0);
    const n = looks();
    nudgeActivity();
    await vi.advanceTimersByTimeAsync(0);
    expect(looks()).toBe(n + 1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(looks()).toBeGreaterThanOrEqual(n + 3);
  });

  it('hidden: not asked; stopped: an answer still on its way is dropped (AUDIT2 WEB-11)', async () => {
    answer = { ops: [], check: null };
    activity.ops = [];
    let release!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn((url: string) => (url === '/api/reports/progress' ? Promise.resolve(json(null)) : new Promise<Response>((r) => (release = r)))));
    startActivity();
    await vi.advanceTimersByTimeAsync(0);
    stopActivity();
    release(json({ ops: [op], check: null }));
    await vi.advanceTimersByTimeAsync(0);
    expect(activity.ops).toEqual([]);

    vi.stubGlobal('fetch', vi.fn(async (url: string) => (asked.push(url), json(answer))));
    (document as unknown as { hidden: boolean }).hidden = true;
    startActivity();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(looks()).toBe(0);
    (document as unknown as { hidden: boolean }).hidden = false;
  });

  it('another account at this page: not the last one\'s activity (AUDIT2 WEB-01)', async () => {
    const user = (id: number) => ({ setupRequired: false, user: { id, username: `u${id}` } }) as unknown as AuthState;
    setSession(user(1));
    answer = { ops: [op], check: { done: 1, total: 3 } };
    startActivity();
    await vi.advanceTimersByTimeAsync(0);
    expect(activity.check).toEqual({ done: 1, total: 3 });
    stopActivity();
    setSession(user(2));
    expect(activity).toMatchObject({ ops: [], check: null, report: null });
  });
});
