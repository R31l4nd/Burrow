// The web app's code the e2e run went through (e2e/tests/fixtures.ts adds
// it up per test, by source file): fails below the floor the gate gives
// (lines, percent), and names the files least gone through.
//
// What it measures: V8's coverage per function (detailed: false; per block
// slowed the pages too much for the tour). A line counts as run when the
// function it is in ran, so a branch never taken inside a function that
// ran counts as run too: this is "lines in functions that ran", not which
// branches did (AUDIT2 TEST-05). The branch figure it prints is not used.
//
//   node scripts/web-coverage.mjs <floor>
import { readFileSync } from 'node:fs';

const floor = Number(process.argv[2] ?? 0);
const summary = JSON.parse(readFileSync('e2e/test-results/coverage/summary.json', 'utf8'));
const { total, ...files } = summary;
const pct = total.lines.pct;
console.log(`web app lines in functions e2e ran: ${pct}% (${total.lines.covered} of ${total.lines.total}); statements ${total.statements.pct}%, functions ${total.functions.pct}%, branches ${total.branches.pct}%`);
const least = Object.entries(files)
  .map(([f, s]) => ({ f: f.replace(/^.*?web\/src\//, 'web/src/'), missed: s.lines.total - s.lines.covered, pct: s.lines.pct }))
  .filter((x) => x.missed > 0)
  .sort((a, b) => b.missed - a.missed)
  .slice(0, 15);
console.log(`most lines never run:\n${least.map((x) => `  ${String(x.missed).padStart(5)}  ${x.pct}%  ${x.f}`).join('\n')}`);
if (pct < floor) {
  console.log(`below the floor of ${floor}%`);
  process.exit(1);
}
