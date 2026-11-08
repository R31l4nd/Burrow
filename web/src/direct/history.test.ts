import { describe, expect, it } from 'vitest';
import { remembered } from './history.js';

describe("the direct route's history", () => {
  it("keeps commands by the server's rules: never one with a secret on it", () => {
    const h = remembered([], 'docker ps')!;
    expect(h.map((x) => x.command)).toEqual(['docker ps']);
    for (const secret of ['mysql -u root -phunter2', 'export API_TOKEN=abc123', 'curl -u admin:pw https://x', ' cat ~/.secret']) expect(remembered(h, secret), secret).toBeNull();
    expect(remembered(h, 'ls')!.map((x) => x.command)).toEqual(['ls', 'docker ps']);
  });
});
