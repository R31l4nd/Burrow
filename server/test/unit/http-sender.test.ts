import { describe, expect, it } from 'vitest';
import { boundedSender, MAX_SOCKET_BUFFER } from '../../src/http.js';

describe('a socket that reads slower than it is sent to (AUDIT2 DO-20)', () => {
  it('is let go, not queued without end', () => {
    const sent: string[] = [];
    let closed: number | null = null;
    const socket = { readyState: 1, OPEN: 1, bufferedAmount: 0, send: (d: string) => void sent.push(d), close: (code?: number) => void (closed = code ?? 0) };
    const send = boundedSender<{ t: string }>(socket);
    send({ t: 'a' });
    socket.bufferedAmount = MAX_SOCKET_BUFFER + 1;
    send({ t: 'b' });
    expect(sent).toEqual(['{"t":"a"}']);
    expect(closed).toBe(4008);
  });
});
