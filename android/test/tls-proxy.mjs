// HTTPS in front of the Burrow test container, for the Android device test:
// the app only talks to https origins, and the WebView must trust the
// certificate (the debug build trusts this run's throwaway CA).
//   node tls-proxy.mjs <cert.pem> <key.pem> <listen-port> <target-host:port>
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { connect } from 'node:net';

const [cert, key, port, target] = process.argv.slice(2);
const [host, targetPort] = target.split(':');

const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  const up = request({ host, port: targetPort, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(up);
});

// WebSockets (the terminal): pass the upgrade through as raw bytes.
server.on('upgrade', (req, socket, head) => {
  const up = connect(Number(targetPort), host, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    up.write(head);
    up.pipe(socket).pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(Number(port), '0.0.0.0');
