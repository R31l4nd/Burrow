// What a page showed last, kept while the app runs: opened again, the page
// shows it at once and replaces it when the fresh answer is in (a stack or
// a folder read over SSH takes a moment; an empty page meanwhile felt slow).

const kept = new Map<string, unknown>();

export function lastSeen<T>(key: string): T | null {
  return (kept.get(key) as T | undefined) ?? null;
}

export function remember<T>(key: string, value: T): T {
  kept.set(key, value);
  // A long session visits many folders: keep the latest few hundred.
  if (kept.size > 300) kept.delete(kept.keys().next().value!);
  return value;
}
