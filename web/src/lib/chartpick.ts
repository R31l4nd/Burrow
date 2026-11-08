// Where a sample sits along a history chart (by its time, as Sparkline draws it) and which sample is
// nearest to a place on it, so what is shown is the moment under the pointer (report af0eec).

/** 0 at the first sample's time, 1 at the last's. */
export function placeOf(at: number[], i: number): number {
  const span = at.length > 1 ? at[at.length - 1]! - at[0]! : 0;
  return span > 0 ? (at[i]! - at[0]!) / span : 0;
}

/** The sample nearest in time to a place (0..1) along the chart. */
export function nearestIndex(at: number[], place: number): number {
  if (at.length < 2) return 0;
  const t = at[0]! + Math.max(0, Math.min(1, place)) * (at[at.length - 1]! - at[0]!);
  let best = 0;
  for (let i = 1; i < at.length; i++) if (Math.abs(at[i]! - t) < Math.abs(at[best]! - t)) best = i;
  return best;
}
