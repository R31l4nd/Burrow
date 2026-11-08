import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { WebSocket as ServerSocket } from 'ws';
import { LspBridge } from '../../src/lsp/bridge.js';
import { MAX_MESSAGE } from '../../src/lsp/framing.js';
import type { ServerDef } from '../../src/lsp/servers.js';
import { makeApp, ORIGIN, setupAdmin, type TestApp } from '../helpers.js';

// The WebSocket <-> language server bridge, with a small language server of
// the test's own (FAKE below, run by node): it answers initialize with what
// it was started with, asks the client for its configuration, and reports
// every message it got, so a test sees what reached the server.

const FAKE = String.raw`
let buf = Buffer.alloc(0);
const seen = [];
const send = (m) => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\r\n\r\n'); process.stdout.write(b); };
process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, end).toString())[1]);
    if (buf.length < end + 4 + len) return;
    const m = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString());
    buf = buf.subarray(end + 4 + len);
    seen.push(m.method ? { method: m.method, params: m.params } : { answer: m.id, result: m.result });
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { capabilities: { hoverProvider: true }, pid: process.pid } });
    if (m.method === 'initialized') {
      // Not JSON, then requests the bridge answers itself.
      process.stdout.write('Content-Length: 5\r\n\r\nnope!');
      send({ jsonrpc: '2.0', id: 900, method: 'workspace/configuration', params: { items: [{ section: 'fake.lint' }, {}, { section: 'missing' }] } });
      send({ jsonrpc: '2.0', id: 901, method: 'client/registerCapability', params: {} });
      send({ jsonrpc: '2.0', id: 902, method: 'window/workDoneProgress/create', params: {} });
      send({ jsonrpc: '2.0', id: 903, method: 'workspace/configuration', params: {} });
    }
    if (m.method === 'test/report') send({ jsonrpc: '2.0', id: m.id, result: seen });
    if (m.method === 'test/exit') process.exit(3);
    if (m.method === 'test/flood') process.stdout.write('Content-Length: ' + (64 << 20) + '\r\n\r\n');
  }
});
`;

const settings = { fake: { lint: { enable: true } } };
let def: ServerDef | null = { command: process.execPath, args: ['-e', FAKE], initializationOptions: { mine: 1 }, settings };

vi.mock('../../src/lsp/servers.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lsp/servers.js')>()),
  serverFor: (lang: string) => (lang === 'python' ? null : def),
}));

/** The server side of a WebSocket, as the bridge uses it. */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: unknown[] = [];
  closedWith: [number, string] | null = null;
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close(code: number, reason: string) {
    if (this.closedWith) return;
    this.closedWith = [code, reason];
    this.readyState = 3;
    this.emit('close');
  }
  /** As the editor sends it. */
  msg(m: unknown) {
    this.emit('message', Buffer.from(typeof m === 'string' ? m : JSON.stringify({ jsonrpc: '2.0', ...(m as object) })));
  }
  async reply(id: unknown, timeoutMs = 10_000): Promise<{ result?: unknown }> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.sent.find((m) => (m as { id?: unknown }).id === id);
      if (hit) return hit as { result?: unknown };
      if (Date.now() > until) throw new Error(`no answer to ${String(id)}: ${JSON.stringify(this.sent)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async closed(timeoutMs = 10_000): Promise<[number, string]> {
    const until = Date.now() + timeoutMs;
    while (!this.closedWith) {
      if (Date.now() > until) throw new Error('not closed');
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.closedWith;
  }
}

const sock = () => new FakeSocket() as FakeSocket & ServerSocket;
type Seen = { method?: string; params?: Record<string, unknown>; answer?: number; result?: unknown }[];
let reportId = 1000;
async function report(s: FakeSocket): Promise<Seen> {
  const id = ++reportId;
  s.msg({ id, method: 'test/report' });
  return (await s.reply(id)).result as Seen;
}
const ctx = () => ({ log: { info: () => {}, warn: () => {}, debug: () => {} } }) as unknown as ConstructorParameters<typeof LspBridge>[0];

let bridge: LspBridge;
beforeEach(() => {
  def = { command: process.execPath, args: ['-e', FAKE], initializationOptions: { mine: 1 }, settings };
  bridge = new LspBridge(ctx());
});
afterEach(() => {
  vi.useRealTimers();
  bridge.stopAll();
});

describe('LspBridge', () => {
  it("initializes the server with its own options and settings, answers its configuration requests itself, and keeps the browser's settings out", async () => {
    const s = sock();
    bridge.attach(1, 'yaml', 'editor-1', s);
    s.msg({ id: 1, method: 'initialize', params: { capabilities: {}, initializationOptions: { evil: true } } });
    expect((await s.reply(1)).result).toMatchObject({ capabilities: { hoverProvider: true } });
    s.msg({ method: 'initialized', params: {} });
    // What the browser may not send: its own settings, and what is no message at all.
    s.msg({ method: 'workspace/didChangeConfiguration', params: { settings: { bashIde: { backgroundAnalysisMaxFiles: 9999 } } } });
    s.msg('not json');
    s.msg('[1,2]');
    s.msg({ method: 42 });
    s.msg({ method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///a.yml', text: 'a: 1' } } });

    // The bridge's answers reach the server in their own time: asked until all four are there.
    let seen = await report(s);
    for (let i = 0; i < 100 && seen.filter((m) => m.answer !== undefined).length < 4; i++) seen = await report(s);
    expect(seen.filter((m) => m.method && m.method !== 'test/report').map((m) => m.method)).toEqual(['initialize', 'initialized', 'workspace/didChangeConfiguration', 'textDocument/didOpen']);
    expect(seen[0]!.params!.initializationOptions).toEqual({ mine: 1 });
    expect(seen.find((m) => m.method === 'workspace/didChangeConfiguration')!.params).toEqual({ settings });
    const answers = Object.fromEntries(seen.filter((m) => m.answer !== undefined).map((m) => [m.answer, m.result]));
    expect(answers).toEqual({ 900: [{ enable: true }, settings, null], 901: null, 902: null, 903: [] });
    // The server's own requests and its unreadable output never reached the editor.
    expect(s.sent.every((m) => (m as { id?: number }).id === 1 || (m as { id?: number }).id! > 1000)).toBe(true);
  });

  it('a server without initialization options gets none, not the browser\'s', async () => {
    def = { ...def!, initializationOptions: undefined };
    const s = sock();
    bridge.attach(1, 'yaml', 'editor-1', s);
    s.msg({ id: 1, method: 'initialize', params: { initializationOptions: { evil: true } } });
    await s.reply(1);
    expect((await report(s))[0]!.params).not.toHaveProperty('initializationOptions');
  });

  it('an editor that reconnects finds its server again, initialized once: its initialize is answered from memory', async () => {
    const a = sock();
    bridge.attach(7, 'yaml', 'editor-1', a);
    a.msg({ id: 1, method: 'initialize', params: {} });
    const first = (await a.reply(1)).result as { pid: number };
    a.msg({ method: 'initialized', params: {} });
    a.close(1001, 'gone');
    expect(bridge.count()).toBe(1);

    const b = sock();
    bridge.attach(7, 'yaml', 'editor-1', b);
    b.msg({ id: 5, method: 'initialize', params: {} });
    expect((await b.reply(5)).result).toEqual(first);
    b.msg({ method: 'initialized', params: {} });
    const seen = await report(b);
    expect(seen.filter((m) => m.method === 'initialize' || m.method === 'initialized')).toHaveLength(2);
    expect(bridge.count()).toBe(1);
  });

  it('a second tab with the same editor id takes over; the first is closed and its close changes nothing', async () => {
    const a = sock();
    const b = sock();
    bridge.attach(1, 'yaml', 'editor-1', a);
    bridge.attach(1, 'yaml', 'editor-1', b);
    expect(a.closedWith).toEqual([4000, 'replaced']);
    b.msg({ id: 1, method: 'initialize', params: {} });
    await b.reply(1);
    expect(a.sent).toEqual([]);
  });

  it('stops a server ten minutes after its last editor went, not before', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = sock();
    bridge.attach(1, 'yaml', 'editor-1', s);
    s.close(1001, 'gone');
    vi.advanceTimersByTime(9 * 60_000);
    expect(bridge.count()).toBe(1);
    // Back in time: the stop is called off.
    const again = sock();
    bridge.attach(1, 'yaml', 'editor-1', again);
    vi.advanceTimersByTime(60 * 60_000);
    expect(bridge.count()).toBe(1);
    again.close(1001, 'gone');
    vi.advanceTimersByTime(10 * 60_000);
    expect(bridge.count()).toBe(0);
  });

  it('a server that exits closes its editor, and the next attach starts a new one', async () => {
    const s = sock();
    bridge.attach(1, 'yaml', 'editor-1', s);
    s.msg({ id: 1, method: 'initialize', params: {} });
    const { pid } = (await s.reply(1)).result as { pid: number };
    s.msg({ method: 'test/exit' });
    expect(await s.closed()).toEqual([1011, 'language server exited']);
    expect(bridge.count()).toBe(0);

    const t2 = sock();
    bridge.attach(1, 'yaml', 'editor-1', t2);
    t2.msg({ id: 1, method: 'initialize', params: {} });
    expect(((await t2.reply(1)).result as { pid: number }).pid).not.toBe(pid);
  });

  it('stops a server that sends past the framing limits, and one sent a message too large (AUDIT2 FS-20)', async () => {
    const a = sock();
    bridge.attach(1, 'yaml', 'editor-a', a);
    a.msg({ method: 'test/flood' });
    expect(await a.closed()).toEqual([1000, 'stopped']);

    const b = sock();
    bridge.attach(1, 'yaml', 'editor-b', b);
    b.msg('x'.repeat(MAX_MESSAGE + 1));
    expect(await b.closed()).toEqual([1000, 'stopped']);
    expect(bridge.count()).toBe(0);
  });

  it('refuses a language without a server, and more than twelve editors per person; an idle one makes room', async () => {
    expect(() => bridge.attach(1, 'python', 'editor-1', sock())).toThrow(expect.objectContaining({ status: 404, code: 'no_language_server' }));
    // A cheap stand-in process: what it does does not matter here.
    def = { command: 'cat', args: [], settings: {} };
    const socks = Array.from({ length: 12 }, (_, i) => {
      const s = sock();
      bridge.attach(1, 'yaml', `editor-${i}`, s);
      return s;
    });
    expect(() => bridge.attach(1, 'yaml', 'editor-12', sock())).toThrow(expect.objectContaining({ status: 429, code: 'too_many_editors' }));
    // Another person has their own twelve.
    bridge.attach(2, 'yaml', 'editor-0', sock());
    socks[3]!.close(1001, 'gone');
    bridge.attach(1, 'yaml', 'editor-12', sock());
    expect(bridge.count()).toBe(13);
    bridge.stopAll();
    expect(bridge.count()).toBe(0);
    expect(socks[0]!.closedWith).toEqual([1000, 'stopped']);
  });
});

describe('/api/lsp', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp();
    await setupAdmin(t);
  });
  afterEach(async () => {
    t.lsp.stopAll();
    await t.close();
  });

  const open = async (path: string, cookie: string | null) => {
    if (!t.app.server.listening) await t.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = t.app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
    const messages: { id?: number; result?: unknown }[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(String(raw)) as { id?: number }));
    const closed = new Promise<[number, string]>((resolve) => ws.on('close', (code, reason) => resolve([code, String(reason)])));
    const opened = await new Promise<boolean>((resolve) => {
      ws.once('open', () => resolve(true));
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode === 101));
      ws.once('error', () => resolve(false));
    });
    return { ws, messages, closed, opened };
  };

  it('says which languages have a server here', async () => {
    expect(await t.json('GET', '/api/lsp')).toEqual({ yaml: true, shellscript: true, dockerfile: true, json: true, toml: true, python: false });
  });

  it('bridges an editor to its server; a bad language or editor id, or no server, is closed with why', async () => {
    const c = await open('/api/lsp/yaml/ws?editor=abcdefgh1', t.cookie);
    expect(c.opened).toBe(true);
    c.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    const until = Date.now() + 10_000;
    while (!c.messages.some((m) => m.id === 1) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(c.messages.find((m) => m.id === 1)!.result).toMatchObject({ capabilities: { hoverProvider: true } });
    expect(t.lsp.count()).toBe(1);
    c.ws.close();

    expect(await (await open('/api/lsp/cobol/ws?editor=abcdefgh1', t.cookie)).closed).toEqual([4400, 'bad request']);
    expect(await (await open('/api/lsp/yaml/ws?editor=short', t.cookie)).closed).toEqual([4400, 'bad request']);
    expect(await (await open('/api/lsp/python/ws?editor=abcdefgh1', t.cookie)).closed).toEqual([4404, 'No language server for python in this installation.']);
  });

  it('is for signed-in admins only', async () => {
    expect((await open('/api/lsp/yaml/ws?editor=abcdefgh1', null)).opened).toBe(false);
    expect(t.lsp.count()).toBe(0);
  });
});
