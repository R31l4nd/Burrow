// The browser's own network for the e2e run (scripts/e2e.sh): Playwright
// shares this container's network namespace, on the test network, instead
// of the machine's. On the machine's network, every container another
// project started or stopped changed its interfaces, and Chromium aborted
// the page loading at that moment (net::ERR_NETWORK_CHANGED: a blank page,
// 2.3.1 gate). The tests still reach Burrow and the stand-ins at localhost
// (a passkey needs that origin): each port here goes on to a container.
//
//   node forward.mjs <port>=<host>:<port> ...
import net from 'node:net';

for (const spec of process.argv.slice(2)) {
  const [port, target] = spec.split('=');
  const [host, to] = target.split(':');
  net
    .createServer((c) => {
      const up = net.connect(Number(to), host);
      const end = () => (c.destroy(), up.destroy());
      c.pipe(up);
      up.pipe(c);
      for (const s of [c, up]) s.on('error', end).on('close', end);
    })
    .listen(Number(port), '127.0.0.1', () => console.log(`forwarding ${port} to ${target}`));
}
