// Text as HTML: the one escaper of the renderers that use {@html} (markdown.ts, ansi.ts).
export const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
