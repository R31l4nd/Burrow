// The version this page was built as (vite.config.ts defines it).
declare const __BURROW_VERSION__: string;
export const WEB_VERSION: string = typeof __BURROW_VERSION__ === 'string' ? __BURROW_VERSION__ : 'dev';

/** -1, 0 or 1: a version before, the same as or after another ("2.0.10" after "2.0.9"); text after a "-" is left out. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, '').split('-')[0]!.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}
