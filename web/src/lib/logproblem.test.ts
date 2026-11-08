import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(globalThis, { document: { documentElement: { lang: 'en' } } });
});
const { sourceProblem } = await import('./logproblem.js');

describe('why a log could not be read (report 931cd0)', () => {
  it("docker's words for a container that is gone said in ours; the rest without docker's prefix", () => {
    expect(sourceProblem('Error response from daemon: No such container: bikkel-build-run-47b7')).toBe('This container no longer exists on its host.');
    expect(sourceProblem('Error response from daemon: container abc is restarting, wait until the container is running')).toBe('container abc is restarting, wait until the container is running');
    expect(sourceProblem('ssh: connect ETIMEDOUT')).toBe('ssh: connect ETIMEDOUT');
  });
});
