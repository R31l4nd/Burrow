// Every control the tour and the other looks show (lookAt in
// e2e/tests/checks.ts) is pressed by some test (e2e/tests/fixtures.ts notes
// each press), unless e2e/controls-allow.json says why not. A control found
// by its test id, or by its English label on its page. The ones still to
// press are listed in e2e/controls-todo.json.
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const R = 'e2e/test-results';
const seen = new Map();
for (const line of readFileSync(`${R}/controls-seen/seen.txt`, 'utf8').split('\n').filter(Boolean)) {
  const [id, where] = line.split('\t');
  if (!seen.has(id)) seen.set(id, where);
}
const pressed = new Set();
for (const f of existsSync(`${R}/pressed`) ? readdirSync(`${R}/pressed`) : []) for (const id of JSON.parse(readFileSync(`${R}/pressed/${f}`, 'utf8'))) pressed.add(id);
const allow = JSON.parse(readFileSync('e2e/controls-allow.json', 'utf8'));
// Still to press: the list only shrinks (an entry pressed now, or no longer
// seen, must go), and a control not on it fails the gate at once.
const todo = new Set(JSON.parse(readFileSync('e2e/controls-todo.json', 'utf8')));
// Nothing added to it since main: a new control is pressed, or allowed with a reason (AUDIT2 OPS-20).
// Main's list, written by the gate from git; without it (no git history), this part is not checked.
let added = [];
if (existsSync(`${R}/controls-todo-main.json`)) {
  const before = new Set(JSON.parse(readFileSync(`${R}/controls-todo-main.json`, 'utf8')));
  added = [...todo].filter((id) => !before.has(id)).sort();
} else console.log('controls-todo.json not compared with main (no git history here)');
const never = [...seen.keys()].filter((id) => !pressed.has(id) && !(id in allow) && !todo.has(id)).sort();
const stale = [...Object.keys(allow), ...todo].filter((id) => pressed.has(id) || !seen.has(id));
console.log(`controls seen: ${seen.size}, pressed by a test: ${[...seen.keys()].filter((id) => pressed.has(id)).length}, allowed unpressed: ${Object.keys(allow).length}, still to press: ${todo.size}`);
if (never.length) console.log(`never pressed by a test (first seen on):\n${never.map((id) => `  ${id}  (${seen.get(id)})`).join('\n')}`);
if (stale.length) console.log(`allowed or still to press, but pressed now or no longer seen (take them off the list):\n  ${stale.join('\n  ')}`);
if (added.length) console.log(`added to the controls still to press since main (press them in a test, or allow them with a reason):\n  ${added.join('\n  ')}`);
process.exit(never.length || stale.length || added.length ? 1 : 0);
