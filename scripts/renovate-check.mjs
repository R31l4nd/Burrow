// renovate.json's own regex managers still find what they were written for,
// and every image pinned on a digest in the scripts is one Renovate sees: a
// manager that matched only scripts/(node|e2e).sh left the gate's Trivy and
// Go, the test helpers' Alpine and the editor tools aging silently
// (A3-OPS-12). Nothing runs Renovate here, so this is checked by the gate
// (step pins). `node scripts/renovate-check.mjs --list` prints every match.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['node_modules', '.git', '.gate', 'artifacts', 'data', 'backups', 'build', 'dist', 'coverage', 'test-results']);
const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walk(join(dir, e.name));
    } else if (e.isFile()) files.push(relative(ROOT, join(dir, e.name)));
  }
};
walk(ROOT);

const config = JSON.parse(readFileSync(join(ROOT, 'renovate.json'), 'utf8'));
const list = process.argv.includes('--list');
const bad = [];
// Per file, the [start, end) ranges a docker manager covers.
const covered = new Map();
const dockerFiles = new Set();
for (const [i, m] of (config.customManagers ?? []).entries()) {
  if (m.fileMatch) bad.push(`manager ${i}: fileMatch is deprecated, use managerFilePatterns`);
  const patterns = (m.managerFilePatterns ?? []).map((p) => new RegExp(p.replace(/^\/(.*)\/$/, '$1')));
  const mine = files.filter((f) => patterns.some((p) => p.test(f)));
  let n = 0;
  if (m.datasourceTemplate === 'docker') for (const f of mine) dockerFiles.add(f);
  for (const f of mine) {
    const text = readFileSync(join(ROOT, f), 'utf8');
    for (const s of m.matchStrings) {
      for (const hit of text.matchAll(new RegExp(s, 'g'))) {
        n++;
        const g = hit.groups ?? {};
        if (list) console.log(`${f}: ${g.depName ?? m.depNameTemplate} ${g.currentValue}${g.currentDigest ? ` ${g.currentDigest.slice(0, 19)}` : ''}`);
        if (!g.currentValue) bad.push(`${f}: a match without a version: ${hit[0].slice(0, 80)}`);
        if (m.datasourceTemplate === 'docker') covered.set(f, [...(covered.get(f) ?? []), [hit.index, hit.index + hit[0].length]]);
      }
    }
  }
  if (n === 0) bad.push(`manager ${i} (${m.description ?? m.matchStrings[0]}) matches nothing`);
}
// Every digest pin in those files is inside a match (a pin without a tag, like
// "aquasec/trivy@sha256:...", was not: Renovate cannot tell its version).
for (const f of dockerFiles) {
  const text = readFileSync(join(ROOT, f), 'utf8');
  for (const pin of text.matchAll(/@sha256:[a-f0-9]{64}/g)) {
    if (!(covered.get(f) ?? []).some(([a, b]) => pin.index >= a && pin.index < b)) {
      const line = text.slice(0, pin.index).split('\n').length;
      bad.push(`${f}:${line}: an image pinned on a digest that Renovate does not see (give it a tag: name:tag@sha256:...)`);
    }
  }
}
if (bad.length) {
  console.log(`renovate.json:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log('renovate.json: every regex manager matches, every pinned image in the scripts is seen');
