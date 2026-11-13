import { describe, expect, it } from 'vitest';
import { parseProcesses, processesCommand, PROCESS_SCRIPT } from '../../src/hosts/processes.js';

// Report 387b0e: which processes use the CPU and the memory now, htop-like,
// on a host's statistics. The script's answer for three processes: a shell
// burning a core in a container, a big database, and one that ended between
// the two reads (no comm, user or cgroup any more).

const OUT = `@@begin 100 4096
@@mem 16303208
@@cores 4
@@up 1835418.25 1835420.25
@@total 212
@@pid 4242 198 2560
@@comm sh
@@user tester
@@cg 0::/system.slice/docker-${'a'.repeat(64)}.scope
@@cmd sh -c while :; do :; done
@@pid 77 3 524288
@@comm postgres
@@user postgres
@@cg 0::/system.slice/postgresql.service
@@cmd postgres: checkpointer
@@pid 9 0 0
@@comm kworker/0:1
@@user root
@@cg 0::/
@@cmd
@@pid 5150 40 100
@@gone
@@end
`;

describe('the process overview (report 387b0e)', () => {
  it('reads CPU as top does (100 = one core), memory from resident pages, the container by its cgroup', () => {
    const p = parseProcesses(OUT, new Map([['a'.repeat(64), 'burner']]));
    expect(p).toMatchObject({ seconds: 2, cores: 4, memTotal: 16303208 * 1024, total: 212 });
    expect(p.top.map((x) => x.pid)).toEqual([4242, 77, 9]);
    expect(p.top[0]).toEqual({ pid: 4242, name: 'sh', command: 'sh -c while :; do :; done', user: 'tester', container: 'burner', cpu: 99, memBytes: 2560 * 4096 });
    expect(p.top[1]).toMatchObject({ name: 'postgres', container: null, cpu: 1.5, memBytes: 524288 * 4096 });
    // A kernel thread: no command line.
    expect(p.top[2]).toMatchObject({ name: 'kworker/0:1', command: '', cpu: 0, memBytes: 0 });
  });

  it('an answer cut short is not read as an empty list', () => {
    expect(() => parseProcesses(OUT.replace('@@end\n', ''))).toThrow(/cut short/);
    expect(() => parseProcesses('')).toThrow();
  });

  it('runs as the SSH user: /proc/<pid>/stat, cmdline and cgroup are open to every user', () => {
    expect(processesCommand()).toMatch(/^sh -c /);
    expect(processesCommand()).not.toContain('sudo');
    expect(PROCESS_SCRIPT).toContain('/stat');
  });
});
