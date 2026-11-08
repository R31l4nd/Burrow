import { eq } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { humanCode, normalizeCode, safeEqual } from '../crypto.js';
import { users } from '../db/schema.js';

// First-run claim. Until an account has finished setup, a one-time token is
// printed in the container log. Only someone who can read that log (i.e. who
// runs the container) can create the admin, so a stranger who reaches the
// page first cannot claim the instance.

export class SetupGate {
  #token: string | null = null;

  constructor(private readonly ctx: Ctx) {}

  /** A finished account exists. */
  isComplete(): boolean {
    return this.ctx.db.select({ id: users.id }).from(users).where(eq(users.incomplete, false)).get() !== undefined;
  }

  /** Called at start-up: prints a token when setup is still open. */
  announce(print: (token: string) => void): void {
    if (this.isComplete()) {
      this.#token = null;
      return;
    }
    this.#token ??= humanCode(4, 5);
    print(this.#token);
  }

  check(token: string): boolean {
    return this.#token !== null && safeEqual(normalizeCode(token), normalizeCode(this.#token));
  }

  close(): void {
    this.#token = null;
  }

  /** For tests. */
  get token(): string | null {
    return this.#token;
  }
}

export function setupBanner(token: string, origin: string): string {
  const line = '='.repeat(64);
  return [
    '',
    line,
    '  Burrow is not set up yet.',
    `  Open ${origin} and enter this one-time setup token:`,
    '',
    `      ${token}`,
    '',
    '  The token changes on every restart until setup is finished.',
    line,
    '',
  ].join('\n');
}
