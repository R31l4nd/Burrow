import { and, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../context.js';
import { humanCode, normalizeCode, sha256 } from '../crypto.js';
import { recoveryCodes } from '../db/schema.js';

// Ten single-use codes of 4x4 characters from a 31-symbol alphabet: about 79
// bits each, so a plain SHA-256 is enough; a slow hash would add nothing
// against guessing that the throttle does not already stop.

export const RECOVERY_CODE_COUNT = 10;

export function regenerateRecoveryCodes(ctx: Ctx, userId: number): string[] {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => humanCode(4, 4));
  ctx.db.transaction((tx) => {
    tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)).run();
    for (const code of codes) {
      tx.insert(recoveryCodes).values({ userId, codeHash: sha256(normalizeCode(code)) }).run();
    }
  });
  return codes;
}

/** Consume a code. True if it was valid and unused. */
export function useRecoveryCode(ctx: Ctx, userId: number, code: string): boolean {
  const hash = sha256(normalizeCode(code));
  const res = ctx.db
    .update(recoveryCodes)
    .set({ usedAt: ctx.now() })
    .where(and(eq(recoveryCodes.userId, userId), eq(recoveryCodes.codeHash, hash), isNull(recoveryCodes.usedAt)))
    .run();
  return res.changes === 1;
}

export function remainingRecoveryCodes(ctx: Ctx, userId: number): number {
  return ctx.db
    .select({ id: recoveryCodes.id })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
    .all().length;
}
