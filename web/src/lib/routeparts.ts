// Parts of the address read safely: a malformed escape ("%E0%A4%A") threw
// while the page was drawn, and the whole app went blank (audit WP-04).

/** The part as text, or null when it is not valid percent-encoding. */
export function textPart(s: string | undefined): string | null {
  if (s === undefined || s === '') return null;
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** The part as an id (a positive whole number), or null. */
export function idPart(s: string | undefined): number | null {
  return /^[1-9]\d{0,14}$/.test(s ?? '') ? Number(s) : null;
}
