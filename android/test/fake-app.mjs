// A stand-in web app for the Android device test's app tab: signed out until
// /login sets a cookie, then signed in for as long as the cookie lives. And
// files for the app's own downloads (DownloadsTest): one that honours Range,
// one that breaks off halfway the first time, and a slow one to stop.
import { createServer } from 'node:http';

// 2 MiB that are easy to check: byte i is (i + version) % 251. /bump makes
// a new version (another ETag): a resume must then start over.
let version = 0;
const fileOf = (v) => Buffer.alloc(2 * 1024 * 1024, 0).map((_, i) => (i + v) % 251);
let FILE = fileOf(0);
const broken = new Set();
let lastRange = '';

function sendFile(req, res, url) {
  const etag = `"v${version}"`;
  // If-Range of another version: the whole (new) file, not a part.
  const sameVersion = !req.headers['if-range'] || req.headers['if-range'] === etag;
  const range = sameVersion ? /^bytes=(\d+)-$/.exec(req.headers.range ?? '') : null;
  lastRange = req.headers.range ?? '';
  const from = range ? Number(range[1]) : 0;
  const head = { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="file.bin"', 'accept-ranges': 'bytes', etag, 'content-length': String(FILE.length - from) };
  if (range) head['content-range'] = `bytes ${from}-${FILE.length - 1}/${FILE.length}`;
  res.writeHead(range ? 206 : 200, head);
  const token = url.searchParams.get('break');
  if (token && !broken.has(token)) {
    // Halfway, the line goes (as when the phone leaves the Wi-Fi).
    broken.add(token);
    res.write(FILE.subarray(from, FILE.length / 2), () => setTimeout(() => res.destroy(), 100));
    return;
  }
  res.end(FILE.subarray(from));
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/file.bin') return sendFile(req, res, url);
  if (url.pathname === '/last-range') return res.end(lastRange);
  // Which version is served now: a later pass of the device test starts after an earlier one's /bump.
  if (url.pathname === '/version') return res.end(String(version));
  if (url.pathname === '/bump') {
    version++;
    FILE = fileOf(version);
    return res.end(String(version));
  }
  if (url.pathname === '/slow.bin') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(64 * 1024 * 1000) });
    const timer = setInterval(() => res.write(Buffer.alloc(64 * 1024)), 200);
    res.on('close', () => clearInterval(timer));
    return;
  }
  if (url.pathname === '/downloads') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><title>Downloads</title><a id="dl" href="/file.bin" download>file.bin</a>');
  }
  if (req.url === '/login') {
    res.writeHead(302, { 'set-cookie': 'fakeapp=signed-in; Max-Age=86400; Path=/; HttpOnly', location: '/' });
    return res.end();
  }
  const signedIn = /(?:^|;\s*)fakeapp=signed-in/.test(req.headers.cookie ?? '');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Fake app</title><p id="state">${signedIn ? 'signed in' : 'signed out'}</p><a href="/login">Log in</a>`);
}).listen(Number(process.argv[2] ?? 8099), '0.0.0.0');
