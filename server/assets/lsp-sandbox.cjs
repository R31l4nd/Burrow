'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS: node loads it with --require, before the server's own code. */
// Loaded first into every language server Burrow starts (server/src/lsp/servers.ts). They need no
// network: a YAML file's "# yaml-language-server: $schema=<address>" line made Burrow's container
// fetch any address, inside the network too (audit 2026-11-23). Every way out is refused here.
// BURROW_LSP_READ (folders, ":" between them): the only files read for a schema a document names;
// the server's own code loads as usual (require reads synchronously, not through these).
const refuse = () => {
  throw new Error('No network for a language server in Burrow.');
};
for (const name of ['http', 'https', 'http2', 'net', 'tls', 'dgram']) {
  const mod = require(name);
  for (const fn of ['request', 'get', 'connect', 'createConnection', 'createSocket']) if (typeof mod[fn] === 'function') mod[fn] = refuse;
}
globalThis.fetch = async () => refuse();

const allowed = (process.env.BURROW_LSP_READ || '').split(':').filter(Boolean);
if (allowed.length) {
  const fs = require('fs');
  const path = require('path');
  const ok = (p) => {
    const real = path.resolve(String(p instanceof URL ? p.pathname : p));
    return allowed.some((a) => real === a || real.startsWith(a + path.sep));
  };
  const closed = () => Object.assign(new Error('Not readable by a language server in Burrow.'), { code: 'EACCES' });
  const readFile = fs.readFile;
  fs.readFile = function (p, ...rest) {
    if (ok(p)) return readFile.call(this, p, ...rest);
    const cb = rest[rest.length - 1];
    if (typeof cb === 'function') return process.nextTick(cb, closed());
    throw closed();
  };
  const read = fs.promises.readFile;
  fs.promises.readFile = async (p, ...rest) => {
    if (!ok(p)) throw closed();
    return read(p, ...rest);
  };
}
