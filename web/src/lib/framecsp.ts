// The page's CSP (frame-src) is fixed when Burrow's page loads: after apps
// changed, a newly frameable app needs one reload before it may be framed.
// Known for the page's whole life, not one visit to Apps: leaving Apps and
// coming back forgot it, and the frame stayed blocked (AUDIT2 PAGE-18).
export const frameCsp = { stale: false };
