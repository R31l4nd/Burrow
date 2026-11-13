import type { ProcessList, ProcessNow } from '@burrow/shared';
import { shellQuote } from '../ssh/quote.js';
import { containerOf } from './diskio.js';

// Report 387b0e: which processes use the CPU and the memory now, the way
// htop shows it, sampled on demand while someone looks. From /proc only:
// each process's CPU time (utime + stime in /proc/<pid>/stat) twice, a
// couple of seconds apart, and its resident pages; then the busiest and the
// largest more closely (name, user, container, command line). Those files
// are open to every user, so no sudo (a host mounting /proc with hidepid
// shows the SSH user's own processes only; the total says how many it saw).

export const PROCESS_SECONDS = 2;
/** The busiest on CPU and the largest in memory, each. */
const TOP = 15;
/** A command line is cut here. */
const COMMAND = 300;

/**
 * One cat reads every process's stat (cheap with thousands of processes);
 * awk keeps pid, CPU ticks and resident pages, reading the fields after the
 * name's last ')' (a name may hold spaces and brackets).
 */
export const PROCESS_SCRIPT = [
  'cd /proc || exit 3',
  'echo "@@begin $(getconf CLK_TCK 2>/dev/null || echo 100) $(getconf PAGESIZE 2>/dev/null || echo 4096)"',
  `echo "@@mem $(awk '/^MemTotal:/{print $2}' meminfo)"`,
  `echo "@@cores $(grep -c '^processor' cpuinfo)"`,
  `st() { cat [0-9]*/stat 2>/dev/null | awk '{p=$1; sub(/^.*\\) /, ""); print p, $12+$13, $22}'; }`,
  `read -r u1 x < uptime; a=$(st); sleep ${PROCESS_SECONDS}; read -r u2 x < uptime; b=$(st)`,
  'echo "@@up $u1 $u2"',
  `echo "@@total $(printf '%s\\n' "$b" | grep -c .)"`,
  // Per process: its ticks over the sample (all of them for one started meanwhile), and its pages now.
  `d=$(printf '%s\\n' "$a" @@ "$b" | awk '$0=="@@"{s=1;next} {if(s) print $1, $2-(($1 in o)?o[$1]:0), $3; else o[$1]=$2}')`,
  `top=$( { printf '%s\\n' "$d" | sort -k2,2nr | head -n ${TOP}; printf '%s\\n' "$d" | sort -k3,3nr | head -n ${TOP}; } | cut -d' ' -f1 | sort -un)`,
  'for p in $top; do echo "@@pid $(printf \'%s\\n\' "$d" | grep -m1 "^$p ")"; [ -d "$p" ] || { echo @@gone; continue; }',
  '  echo "@@comm $(cat $p/comm 2>/dev/null)"; echo "@@user $(stat -c %U $p 2>/dev/null)"',
  '  echo "@@cg $(grep -s -m1 -E \'[0-9a-f]{64}|lxc\' $p/cgroup)"',
  `  echo "@@cmd $(tr '\\0' ' ' < $p/cmdline 2>/dev/null | cut -c1-${COMMAND})"`,
  'done',
  'echo @@end',
].join('\n');

/** As the SSH user, whoever that is. */
export function processesCommand(): string {
  return `sh -c ${shellQuote(PROCESS_SCRIPT)}`;
}

/** The script's answer; throws when it is cut short or makes no sense (failed is not empty). */
export function parseProcesses(out: string, names: Map<string, string> = new Map()): Omit<ProcessList, 'hostId' | 'at'> {
  if (!/^@@end$/m.test(out)) throw new Error('the answer was cut short');
  let tick = 100;
  let page = 4096;
  let memTotal = 0;
  let cores = 1;
  let seconds = PROCESS_SECONDS;
  let total = 0;
  const top: ProcessNow[] = [];
  let cur: ProcessNow | null = null;
  for (const line of out.split('\n')) {
    const m = /^@@(\w+)(?: (.*))?$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const rest = (m[2] ?? '').trim();
    const nums = rest.split(/\s+/).map(Number);
    if (key === 'begin') [tick = 100, page = 4096] = nums;
    else if (key === 'mem') memTotal = (nums[0] ?? 0) * 1024;
    else if (key === 'cores') cores = Math.max(1, nums[0] ?? 1);
    else if (key === 'up') seconds = nums[1]! - nums[0]! > 0 ? nums[1]! - nums[0]! : PROCESS_SECONDS;
    else if (key === 'total') total = nums[0] ?? 0;
    else if (key === 'pid') {
      const [pid, ticks, pages] = nums;
      cur = null;
      if (!pid) continue;
      cur = { pid, name: '', command: '', user: '', container: null, cpu: Math.round(((ticks ?? 0) / tick / seconds) * 1000) / 10, memBytes: (pages ?? 0) * page };
      top.push(cur);
    } else if (key === 'gone' && cur) {
      top.pop();
      cur = null;
    } else if (cur && key === 'comm') cur.name = rest;
    else if (cur && key === 'user') cur.user = rest;
    else if (cur && key === 'cg') cur.container = containerOf(rest, names);
    else if (cur && key === 'cmd') cur.command = rest;
  }
  if (!Number.isFinite(tick) || tick <= 0 || !Number.isFinite(page) || page <= 0 || !total) throw new Error('the answer makes no sense');
  top.sort((a, b) => b.cpu - a.cpu || b.memBytes - a.memBytes);
  return { seconds: Math.round(seconds * 10) / 10, cores, memTotal, total, top };
}
