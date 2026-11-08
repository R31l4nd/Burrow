import { isIP } from 'node:net';
import tls from 'node:tls';

// When an app's TLS certificate runs out: read from the handshake itself
// (fetch does not show the certificate). Self-signed and private CAs are
// read too: the date is what counts here, not who signed it.

const TIMEOUT_MS = 10_000;

/** The certificate's end (ms since the epoch) of an https URL; null for http or when it cannot be read. */
export function certExpiry(url: string): Promise<number | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return Promise.resolve(null);
  }
  if (u.protocol !== 'https:') return Promise.resolve(null);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: Number(u.port) || 443, ...(isIP(host) ? {} : { servername: host }), rejectUnauthorized: false, timeout: TIMEOUT_MS });
    const done = (v: number | null) => {
      s.destroy();
      resolve(v);
    };
    s.once('secureConnect', () => {
      const end = Date.parse(s.getPeerCertificate().valid_to ?? '');
      done(Number.isFinite(end) ? end : null);
    });
    s.once('timeout', () => done(null));
    s.once('error', () => done(null));
  });
}
