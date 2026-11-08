import { describe, expect, it } from 'vitest';
import { addSample, applyDockerDelta, detectLevel, dockerClientMessage, dockerDelta, HISTORY_POINTS, HISTORY_SPAN_MS, insertionIndex, parseJsonLine, sortKey, splitTimestamp, type ContainerInfo, type HostContainers, type StatsHistory } from './docker.js';

describe('log levels', () => {
  it('reads JSON logs, pino numbers included', () => {
    expect(detectLevel('{"level":30,"msg":"incoming request"}')).toBe('info');
    expect(detectLevel('{"level":50,"msg":"boom"}')).toBe('error');
    expect(detectLevel('{"severity":"WARNING","message":"x"}')).toBe('warn');
    expect(detectLevel('{"log":{"level":"debug"},"message":"x"}')).toBe('debug');
    // ECS: "log.level" as one key.
    expect(detectLevel('{"log.level":"error","message":"failure"}')).toBe('error');
  });

  it('reads the common text forms', () => {
    expect(detectLevel('2026-09-27 07:40:04 ERROR Database is locked')).toBe('error');
    expect(detectLevel('[warn] disk almost full')).toBe('warn');
    expect(detectLevel('time="2026-09-27T07:40:04Z" level=info msg="started"')).toBe('info');
    expect(detectLevel('\x1b[32mINFO\x1b[0m Listening on :8080')).toBe('info');
    expect(detectLevel('Error: connect ECONNREFUSED')).toBe('error');
    expect(detectLevel('[Info] Radarr is starting')).toBe('info');
  });

  it('does not guess from ordinary words', () => {
    expect(detectLevel('no errors found in 3 files')).toBeNull();
    expect(detectLevel('GET /info 200')).toBeNull();
  });
});

describe('timestamps', () => {
  it('splits docker logs -t lines', () => {
    expect(splitTimestamp('2026-09-27T07:40:04.550926770Z hello world')).toEqual({ ts: '2026-09-27T07:40:04.550926770Z', text: 'hello world' });
    expect(splitTimestamp('no timestamp')).toBeNull();
  });

  it('sorts lines of different hosts into one timeline', () => {
    const keys = ['2026-09-27T07:40:04.5Z', '2026-09-27T07:40:04.550926770Z', '2026-09-27T07:40:04Z'].map(sortKey);
    expect(keys).toEqual(['2026-09-27T07:40:04.500000000Z', '2026-09-27T07:40:04.550926770Z', '2026-09-27T07:40:04.000000000Z']);
    const sorted = ['2026-09-27T07:40:04.000000000Z', '2026-09-27T07:40:05.000000000Z'];
    expect(insertionIndex(sorted, sortKey('2026-09-27T07:40:04.5Z'))).toBe(1);
    expect(insertionIndex(sorted, sortKey('2026-09-27T07:40:05Z'))).toBe(2);
  });
});

describe('levels and times of other loggers', () => {
  it("pino's lower numbers, and a line that only looks like JSON", () => {
    expect(detectLevel('{"level":20,"msg":"x"}')).toBe('debug');
    expect(detectLevel('{"level":10,"msg":"x"}')).toBe('trace');
    expect(detectLevel('{"level":60,"msg":"x"}')).toBe('fatal');
    expect(detectLevel('{"level":40,"msg":"x"}')).toBe('warn');
    expect(detectLevel('{"level":true,"msg":"x"}')).toBeNull();
    expect(detectLevel('{not json} ERROR after all')).toBe('error');
    expect(detectLevel('[1,2]')).toBeNull();
  });

  it('a time with an offset sorts as the same moment in UTC; what is no time stays as it is', () => {
    expect(sortKey('2026-09-27T09:40:04.5+02:00')).toBe('2026-09-27T07:40:04.500000000Z');
    expect(sortKey('2026-09-27T07:40:04Z')).toBe('2026-09-27T07:40:04.000000000Z');
    expect(sortKey('yesterday')).toBe('yesterday');
  });
});

// The container overview sends a host whole once, then what changed (OPS-W-03, decision 19):
// the client's copy, built from the deltas, must be the server's snapshot.
describe('container overview deltas', () => {
  const c = (id: string, state: ContainerInfo['state'] = 'running', restarts = 0) =>
    ({ id, name: `n-${id}`, image: 'img', imageId: 'sha', state, health: null, restarts, startedAt: null, finishedAt: null, exitCode: 0, oomKilled: false, createdAt: '2026-10-01T00:00:00Z', project: null, service: null, configFiles: null, workingDir: null }) as ContainerInfo;
  const host = (containers: ContainerInfo[], extra: Partial<HostContainers> = {}): HostContainers => ({ hostId: 1, hostName: 'h', containers, stats: {}, history: {}, error: null, at: '2026-10-17T00:00:00Z', ...extra });
  const st = (cpu: number) => ({ cpu, memBytes: cpu * 10, memLimitBytes: 1000 });

  it('sends only what changed, and the copy built from it is the next snapshot', () => {
    const prev = host([c('a'), c('b'), c('x')]);
    const next = host([c('a'), c('b', 'exited'), c('d')], { at: '2026-10-17T00:00:05Z' });
    const d = dockerDelta(prev, next, null);
    expect(d.changed?.map((x) => x.id)).toEqual(['b', 'd']);
    expect(d.removed).toEqual(['x']);
    expect(d.order).toEqual(['a', 'b', 'd']);
    expect(d.stats).toBeUndefined();
    const built = applyDockerDelta(prev, d);
    expect(built.containers).toEqual(next.containers);
    expect(built.at).toBe(next.at);
    // The one given is left as it was.
    expect(prev.containers.map((x) => x.id)).toEqual(['a', 'b', 'x']);
  });

  it('nothing changed: no containers, no order, only the time and the error', () => {
    const prev = host([c('a'), c('b')]);
    const d = dockerDelta(prev, host([c('a'), c('b')], { error: 'docker: no answer' }), null);
    expect(d).toEqual({ hostId: 1, hostName: 'h', at: prev.at, error: 'docker: no answer' });
    expect(applyDockerDelta(prev, d)).toMatchObject({ containers: prev.containers, error: 'docker: no answer' });
  });

  it('a new order alone is sent as an order', () => {
    const d = dockerDelta(host([c('a'), c('b')]), host([c('b'), c('a')]), null);
    expect(d.changed).toBeUndefined();
    expect(d.order).toEqual(['b', 'a']);
    expect(applyDockerDelta(host([c('a'), c('b')]), d).containers.map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('a stats sample grows the sparklines; a container gone loses its history', () => {
    const history: Record<string, StatsHistory> = { a: { at: [1000], cpu: [1], mem: [10] }, x: { at: [1000], cpu: [5], mem: [50] } };
    const prev = host([c('a'), c('x')], { history, stats: { a: st(1), x: st(5) } });
    const d = dockerDelta(prev, host([c('a')], { stats: { a: st(2.567) } }), 2000);
    expect(d.sampleAt).toBe(2000);
    const built = applyDockerDelta(prev, d);
    expect(built.stats).toEqual({ a: st(2.567) });
    expect(built.history).toEqual({ a: { at: [1000, 2000], cpu: [1, 2.57], mem: [10, 25.67] } });
    // The copy's history is its own: the base's arrays are not changed.
    expect(history.a!.at).toEqual([1000]);
  });

  it('keeps the last hour and a bounded number of points', () => {
    const h: Record<string, StatsHistory> = {};
    addSample(h, { a: st(1) }, 0);
    addSample(h, { a: st(1) }, HISTORY_SPAN_MS + 1);
    expect(h.a!.at).toEqual([HISTORY_SPAN_MS + 1]);
    for (let i = 1; i <= HISTORY_POINTS + 20; i++) addSample(h, { a: st(1) }, HISTORY_SPAN_MS + 1 + i);
    expect(h.a!.at.length).toBe(HISTORY_POINTS + 12);
  });
});

describe('a log line as JSON', () => {
  it('an object only, never an array, a string or broken JSON', () => {
    expect(parseJsonLine(' {"level":"info","msg":"x"} ')).toEqual({ level: 'info', msg: 'x' });
    expect(parseJsonLine('[1,2]')).toBeNull();
    expect(parseJsonLine('{not json}')).toBeNull();
    expect(parseJsonLine('plain text')).toBeNull();
  });
});

describe('the containers socket', () => {
  it("a page's watch list: whole positive ids only, anything else dropped as a whole", () => {
    expect(dockerClientMessage.safeParse({ t: 'watch', hostIds: [1, 2] }).success).toBe(true);
    expect(dockerClientMessage.safeParse({ t: 'watch', hostIds: [] }).success).toBe(true);
    for (const m of [null, 1, 'x', [], { t: 'watch', hostIds: null }, { t: 'watch', hostIds: [0] }, { t: 'watch', hostIds: [1.5] }, { t: 'watch', hostIds: ['1'] }, { t: 'other', hostIds: [1] }]) {
      expect(dockerClientMessage.safeParse(m).success).toBe(false);
    }
  });
});
