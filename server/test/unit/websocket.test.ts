import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { SessionSockets } from '../../src/docker/routes.js';
import { clientMessage } from '../../src/lsp/bridge.js';
import { makeApp, ORIGIN, setupAdmin } from '../helpers.js';

describe('messages on a socket', () => {
  it('JSON that is not an object (null, a number, a list) is ignored, the server keeps running', async () => {
    const t = await makeApp();
    await setupAdmin(t);
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (t.app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/docker/ws`, { headers: { origin: ORIGIN, cookie: t.cookie ?? '' } });
    await new Promise((r, j) => (ws.on('open', r), ws.on('error', j)));
    // "null" made the handler read null.t: an uncaught TypeError ended the process.
    for (const m of ['null', '1', '"x"', '[]', '{"t":"watch","hostIds":null}', 'not json']) ws.send(m);
    ws.send(JSON.stringify({ t: 'watch', hostIds: [] }));
    await new Promise((r) => setTimeout(r, 300));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect((await t.request('GET', '/api/auth/state')).statusCode).toBe(200);
    ws.close();
    await t.close();
  });

  it("the editor's language server: only objects, and never its settings from the browser", () => {
    for (const raw of ['null', '1', '[]', '"x"', 'nope']) expect(clientMessage(raw)).toBeNull();
    expect(clientMessage('{"jsonrpc":"2.0","id":1,"method":"initialize"}')).toMatchObject({ method: 'initialize' });
    // Settings are the server's (a glob setting fed the braces advisory): the browser's are dropped.
    expect(clientMessage('{"jsonrpc":"2.0","method":"workspace/didChangeConfiguration","params":{"settings":{"bashIde":{"globPattern":"{"}}}}')).toBeNull();
  });

  it('a socket ends with its login session: expired, not only signed out', async () => {
    const t = await makeApp();
    await setupAdmin(t);
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (t.app.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/docker/ws`, { headers: { origin: ORIGIN, cookie: t.cookie ?? '' } });
    await new Promise((r, j) => (ws.on('open', r), ws.on('error', j)));
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    t.sweepSockets();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    // 31 days on: the session is over, and the socket with it (it went on answering).
    t.advance(31 * 24 * 3600_000);
    t.sweepSockets();
    expect(await closed).toBe(4401);
    await t.close();
  });

  it("an editor's socket also ends when its user is no longer an admin", () => {
    const sockets = new SessionSockets();
    const closed: string[] = [];
    const fake = (name: string) => ({ close: () => closed.push(name) }) as unknown as import('ws').WebSocket;
    sockets.add('s1', fake('containers'));
    sockets.add('s1', fake('editor'), { admin: true });
    sockets.add('s2', fake('other'));
    sockets.sweep(new Map([['s1', 'operator'], ['s2', 'admin']]));
    expect(closed).toEqual(['editor']);
    sockets.sweep(new Map([['s1', 'operator']]));
    expect(closed).toEqual(['editor', 'other']);
  });
});
