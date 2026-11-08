// Which API routes no test used successfully (an answer below 400) during
// the integration and end-to-end tests. Each must have a test, or a line in
// server/test/route-exceptions.json saying why not. An exception for a route
// that is used by now, or that no longer exists, fails too: the list stays true.
import { existsSync, readFileSync } from 'node:fs';

const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean) : []);
const all = read('coverage/routes-all.txt')
  .map((l) => l.replace(/ ws$/, ''))
  .filter((l) => / \/api\//.test(l) && !l.endsWith(' /api/*'));
const hits = new Set(read('coverage/route-hits.txt'));
const exceptions = JSON.parse(readFileSync('server/test/route-exceptions.json', 'utf8'));

if (!all.length) {
  console.error('no list of routes (coverage/routes-all.txt): run the integration tests first');
  process.exit(1);
}
const unused = all.filter((r) => !hits.has(r) && !(r in exceptions));
const stale = Object.keys(exceptions).filter((r) => hits.has(r) || !all.includes(r));
console.log(`routes: ${all.length}, used by a test: ${all.filter((r) => hits.has(r)).length}, excepted: ${Object.keys(exceptions).length}`);
if (unused.length) console.log(`never used successfully by a test:\n  ${unused.join('\n  ')}`);
if (stale.length) console.log(`exceptions no longer true (used now, or gone):\n  ${stale.join('\n  ')}`);
process.exit(unused.length || stale.length ? 1 : 0);
