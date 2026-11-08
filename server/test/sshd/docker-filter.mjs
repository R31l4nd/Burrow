// server/test/sshd/docker-filter.mjs UPSTREAM LISTEN - this machine's Docker
// for the test hosts with the real docker CLI (burrow-e2e-docker and the
// integration tests' third sshd), seen through a filter: they see, read and
// act on the tests' own containers only. Before, they held this machine's
// Docker socket itself, and a test instance listed, watched, alerted on and
// reported about the live containers, and read their logs (A3-WEB-16,
// W-FUNC-17).
//
// A test's own container: named burrowtest-* (the scripts' and the specs'
// throwaway ones, compose projects burrowtest-*), the test's own Burrow
// (burrow-e2e-*), or made through this filter
// (a `docker run` of a test, named or not). Everything else is not there: left
// out of lists and events, "No such container" when asked for by name or id.
// Volumes and networks: burrowtest-* and those of the tests' containers.
// Images: those of the tests' containers and the test registry's
// (localhost:5001/); no other image is removed, and nothing is pruned.
//
// Plain Node, no packages: it runs in the node image the scripts use already.
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { chmodSync, rmSync } from 'node:fs';

const [UPSTREAM = '/var/run/docker.sock', LISTEN = '/filter/docker.sock'] = process.argv.slice(2);

const made = new Set(); // ids of containers created through this filter
const TEST = /^\/?burrowtest/;
const testImage = (ref) => typeof ref === 'string' && (ref.startsWith('localhost:5001/') || TEST.test(ref));

/** A request to the real Docker, its body as JSON (or text). */
function upstream(method, path, body) {
  return new Promise((resolve, reject) => {
    const r = request({ socketPath: UPSTREAM, method, path, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode ?? 500, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

// The test's own Burrow (burrow-e2e-*) is shown too: a test checks that Burrow
// never stops itself, which it can only do while it sees itself.
const SELF = /^\/?burrow-e2e-/;
const ours = (c) => !!c && (made.has(c.Id) || (c.Names ?? [c.Name]).some((n) => TEST.test(n ?? '') || SELF.test(n ?? '')));

/** Is this container (by id or name) one of the tests'? */
async function containerOk(ref) {
  const r = await upstream('GET', `/containers/${encodeURIComponent(ref)}/json`);
  if (r.status !== 200 || !r.json) return r.status === 404 ? 'missing' : false;
  return ours(r.json);
}

async function visibleContainers() {
  const r = await upstream('GET', '/containers/json?all=1');
  return (r.json ?? []).filter(ours);
}

function send(res, status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
const noSuch = (res, what) => send(res, 404, { message: `No such ${what}` });
const refused = (res, what) => send(res, 403, { message: `refused by the test filter: ${what} (server/test/sshd/docker-filter.mjs)` });

/** Passed on as it is, streamed both ways (logs -f, stats, a build's context). */
function pass(req, res, onJson) {
  const up = request({ socketPath: UPSTREAM, method: req.method, path: req.url, headers: req.headers }, (ur) => {
    if (onJson && (ur.statusCode ?? 500) < 300) {
      const chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let out = text;
        try {
          out = JSON.stringify(onJson(JSON.parse(text)));
        } catch {
          // as it came
        }
        const headers = { ...ur.headers, 'content-length': Buffer.byteLength(out) };
        delete headers['transfer-encoding'];
        res.writeHead(ur.statusCode ?? 200, headers);
        res.end(out);
      });
      return;
    }
    res.writeHead(ur.statusCode ?? 500, ur.headers);
    // At once, as Docker sends them: `docker run` waits for the headers of its
    // /wait (whose body comes when the container ends) before it starts it.
    res.flushHeaders();
    ur.pipe(res);
  });
  up.on('error', (e) => (res.headersSent ? res.destroy() : send(res, 502, { message: String(e) })));
  // A followed log or stats stream ends when the client goes.
  res.on('close', () => up.destroy());
  req.pipe(up);
}

/** Docker's events, the other containers' left out (one JSON object per line). */
function events(req, res) {
  const up = request({ socketPath: UPSTREAM, method: req.method, path: req.url, headers: req.headers }, (ur) => {
    res.writeHead(ur.statusCode ?? 500, ur.headers);
    res.flushHeaders();
    let rest = '';
    const pending = [];
    let busy = false;
    const drain = async () => {
      if (busy) return;
      busy = true;
      while (pending.length) {
        const line = pending.shift();
        let keep = true;
        try {
          const e = JSON.parse(line);
          if (e.Type === 'container') keep = made.has(e.Actor?.ID) || TEST.test(e.Actor?.Attributes?.name ?? '');
        } catch {
          // passed on
        }
        if (keep) res.write(line + '\n');
      }
      busy = false;
    };
    ur.on('data', (c) => {
      rest += c.toString('utf8');
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      pending.push(...lines.filter((l) => l.trim()));
      void drain();
    });
    ur.on('end', () => res.end());
  });
  up.on('error', () => res.end());
  // Gone when the client goes (a request's own 'close' comes as soon as it is read).
  res.on('close', () => up.destroy());
  up.end();
}

// DOCKER_FILTER_LOG=1: each request in the container's log (looking into a test).
const LOG = !!process.env.DOCKER_FILTER_LOG;

async function handle(req, res) {
  if (LOG) console.log(req.method, req.url);
  const url = new URL(req.url ?? '/', 'http://docker');
  // The API version in front (/v1.47/containers/json) does not change what is asked.
  const path = url.pathname.replace(/^\/v\d+\.\d+/, '');
  const method = req.method ?? 'GET';
  let m;

  if (/^\/(system|containers|images|volumes|networks|builder|build)\/prune$/.test(path) || path === '/system/prune') return refused(res, 'prune');

  if (path === '/containers/json') return pass(req, res, (list) => list.filter(ours));
  if (path === '/containers/create' && method === 'POST') {
    return pass(req, res, (body) => {
      if (body?.Id) made.add(body.Id);
      return body;
    });
  }
  if ((m = /^\/containers\/([^/]+)(\/.*)?$/.exec(path))) {
    const ok = await containerOk(decodeURIComponent(m[1]));
    if (ok === true) return pass(req, res);
    return noSuch(res, `container: ${decodeURIComponent(m[1])}`);
  }
  if ((m = /^\/exec\/([^/]+)\/json$/.exec(path)) || (m = /^\/exec\/([^/]+)\/(start|resize)$/.exec(path))) {
    const e = await upstream('GET', `/exec/${m[1]}/json`);
    if (e.json?.ContainerID && (await containerOk(e.json.ContainerID)) === true) return pass(req, res);
    return noSuch(res, `exec instance: ${m[1]}`);
  }
  if (path === '/events') return events(req, res);
  // Totals over the whole machine (and lists in older API versions): Burrow does not ask, the tests need not.
  if (path === '/system/df') return refused(res, 'system df');
  if (path === '/images/json') {
    const imgs = new Set((await visibleContainers()).map((c) => c.ImageID));
    return pass(req, res, (list) => list.filter((i) => imgs.has(i.Id) || [...(i.RepoTags ?? []), ...(i.RepoDigests ?? [])].some(testImage)));
  }
  if ((m = /^\/images\/(.+)$/.exec(path)) && method === 'DELETE') {
    const name = decodeURIComponent(m[1]);
    const i = await upstream('GET', `/images/${encodeURIComponent(name)}/json`);
    const tags = i.json?.RepoTags ?? [];
    if (testImage(name) || (tags.length > 0 && tags.every(testImage))) return pass(req, res);
    return refused(res, `removing image ${name}`);
  }
  if (path === '/volumes' && method === 'GET') {
    const vols = new Set((await visibleContainers()).flatMap((c) => (c.Mounts ?? []).map((x) => x.Name).filter(Boolean)));
    return pass(req, res, (body) => ({ ...body, Volumes: (body.Volumes ?? []).filter((v) => vols.has(v.Name) || TEST.test(v.Name)) }));
  }
  if ((m = /^\/volumes\/([^/]+)$/.exec(path))) {
    const name = decodeURIComponent(m[1]);
    if (TEST.test(name) || method === 'GET') {
      if (TEST.test(name)) return pass(req, res);
      const vols = new Set((await visibleContainers()).flatMap((c) => (c.Mounts ?? []).map((x) => x.Name).filter(Boolean)));
      return vols.has(name) ? pass(req, res) : noSuch(res, `volume: ${name}`);
    }
    return refused(res, `volume ${name}`);
  }
  if (path === '/networks' && method === 'GET') {
    return pass(req, res, (list) => list.filter((n) => TEST.test(n.Name) || ['bridge', 'host', 'none'].includes(n.Name)));
  }
  if ((m = /^\/networks\/([^/]+)(\/.*)?$/.exec(path)) && m[1] !== 'create') {
    const n = await upstream('GET', `/networks/${m[1]}`);
    const name = n.json?.Name ?? decodeURIComponent(m[1]);
    if (TEST.test(name) || (method === 'GET' && ['bridge', 'host', 'none'].includes(name))) return pass(req, res);
    return noSuch(res, `network: ${name}`);
  }
  return pass(req, res);
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => send(res, 500, { message: String(e) }));
});
// exec start and attach take over the connection (Upgrade: tcp): checked, then joined as they are.
server.on('upgrade', (req, socket, head) => {
  void (async () => {
    const path = (req.url ?? '').replace(/^\/v\d+\.\d+/, '').split('?')[0];
    let m;
    let ok = false;
    if ((m = /^\/exec\/([^/]+)\/start$/.exec(path))) {
      const e = await upstream('GET', `/exec/${m[1]}/json`);
      ok = !!e.json?.ContainerID && (await containerOk(e.json.ContainerID)) === true;
    } else if ((m = /^\/containers\/([^/]+)\/attach$/.exec(path))) ok = (await containerOk(decodeURIComponent(m[1]))) === true;
    if (!ok) {
      const body = JSON.stringify({ message: `No such container or exec instance: ${path}` });
      socket.end(`HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      return;
    }
    const up = connect(UPSTREAM, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  })().catch(() => socket.destroy());
});
rmSync(LISTEN, { force: true });
server.listen(LISTEN, () => {
  // The test user in the sshd container connects as another uid.
  chmodSync(LISTEN, 0o666);
  console.log(`docker filter on ${LISTEN}`);
});
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => server.close(() => process.exit(0)));
