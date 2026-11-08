/**
 * How often an app was up the last day, for its tile: one decimal below
 * 100, never rounded up, so a short outage does not read "100%" (A3-WEB-22).
 */
export function uptimeLabel(uptime: number | null): string {
  const u = uptime ?? 1;
  if (u >= 1) return '100%';
  const tenths = Math.floor(u * 1000) / 10;
  return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)}%`;
}
