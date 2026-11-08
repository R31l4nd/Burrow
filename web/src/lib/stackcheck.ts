import type { ImageCheck } from '@burrow/shared';

// What a stack's update line says when none of its images has an update:
// from the checks of its own images, not from when any image anywhere was
// last checked (AUDIT2 PAGE-07). An image not checked yet, or one whose check
// failed, is not "up to date".
export type StackCheck = { kind: 'never' } | { kind: 'unchecked'; n: number } | { kind: 'unknown'; n: number } | { kind: 'current'; at: string };

export function stackCheck(checks: (ImageCheck | undefined)[]): StackCheck {
  const seen = checks.filter((c): c is ImageCheck => !!c);
  if (!seen.length) return { kind: 'never' };
  const unknown = seen.filter((c) => c.status === 'unknown').length;
  if (unknown) return { kind: 'unknown', n: unknown };
  if (seen.length < checks.length) return { kind: 'unchecked', n: checks.length - seen.length };
  // The oldest of its checks: that is how current "up to date" is.
  return { kind: 'current', at: seen.map((c) => c.checkedAt).sort()[0]! };
}
