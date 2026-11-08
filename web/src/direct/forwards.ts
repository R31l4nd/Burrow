/**
 * Whether a port forward opens as https: as chosen when it was started, kept
 * per forward; guessed from the port (443) only for one started elsewhere.
 * Guessed every time, HTTPS on 8443 opened as http and HTTP on 443 as https
 * (AUDIT2 TERM-17).
 */
export type Schemes = Record<string, boolean>;

export const withScheme = (schemes: Schemes, forwardId: string, https: boolean): Schemes => ({ ...schemes, [forwardId]: https });

export const isHttps = (schemes: Schemes, f: { forwardId: string; targetPort: number }): boolean => schemes[f.forwardId] ?? f.targetPort === 443;

/** Only the forwards still there: a stopped one's choice goes with it. */
export const keptSchemes = (schemes: Schemes, forwardIds: string[]): Schemes => Object.fromEntries(Object.entries(schemes).filter(([id]) => forwardIds.includes(id)));
