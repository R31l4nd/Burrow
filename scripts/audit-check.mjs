// The gate's dependency audit: every high or critical advisory in what
// Burrow ships (no dev dependencies) fails it, unless scripts/audit-allow.json
// names it with why it cannot do harm here, until a date (then it fails
// again, to be looked at anew).
//
// Dev dependencies run too, on the developer's machine and in CI with the
// repository mounted (vite, vitest, eslint, playwright...): a critical
// advisory only they have fails as well, a high one is a NOTE (A3-OPS-11).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function audit(args) {
  let raw;
  try {
    raw = execFileSync('npm', ['audit', '--json', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    // npm audit exits non-zero when it finds something; its report is still on stdout.
    raw = err.stdout;
  }
  // No usable answer is a failure, never "nothing found": an npm audit that
  // could not reach the registry printed only an error, and that passed.
  let report;
  try {
    report = JSON.parse(raw ?? '');
  } catch {
    console.log(`npm audit ${args.join(' ')} gave no report (not JSON)`);
    process.exit(1);
  }
  if (report.error || typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null || typeof report.metadata?.vulnerabilities !== 'object') {
    console.log(`npm audit ${args.join(' ')} gave no usable report: ${JSON.stringify(report.error ?? report).slice(0, 300)}`);
    process.exit(1);
  }
  // Each advisory once: id -> { severity, title, packages }.
  const found = new Map();
  for (const [name, v] of Object.entries(report.vulnerabilities)) {
    for (const via of v.via) {
      if (typeof via === 'string') continue;
      if (via.severity !== 'high' && via.severity !== 'critical') continue;
      const id = (via.url ?? '').split('/').pop();
      const f = found.get(id) ?? { severity: via.severity, title: via.title, packages: new Set() };
      f.packages.add(name);
      found.set(id, f);
    }
  }
  return found;
}

const allow = JSON.parse(readFileSync(new URL('./audit-allow.json', import.meta.url), 'utf8'));
const today = new Date().toISOString().slice(0, 10);
const allowed = (id) => allow[id] && allow[id].until >= today;
const shipped = audit(['--omit=dev']);
const all = audit([]);
const bad = [];
for (const [id, f] of shipped) {
  const where = [...f.packages].join(', ');
  if (allowed(id)) console.log(`allowed: ${id} (${where}): ${allow[id].reason.slice(0, 80)}...`);
  else bad.push(`${f.severity} ${id} in ${where}: ${f.title}${allow[id] ? ` (allowed until ${allow[id].until}, past)` : ''}`);
}
for (const [id, f] of all) {
  if (shipped.has(id)) continue;
  const where = [...f.packages].join(', ');
  if (allowed(id)) console.log(`allowed (dev): ${id} (${where}): ${allow[id].reason.slice(0, 80)}...`);
  else if (f.severity === 'critical') bad.push(`critical ${id} in the dev dependency ${where}: ${f.title}`);
  else console.log(`NOTE: high ${id} in the dev dependency ${where}: ${f.title} (npm audit fix, or name it in scripts/audit-allow.json)`);
}
if (bad.length) {
  console.log(`not allowed:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log('no advisory of high or critical severity in what ships, and none critical in the dev dependencies, apart from the allowed ones');
