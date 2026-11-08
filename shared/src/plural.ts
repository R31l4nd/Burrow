/** "1 error", "2 errors": the singular for exactly one. */
export const plural = (n: number, one: string, other: string): string => `${n} ${n === 1 ? one : other}`;
