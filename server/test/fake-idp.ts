// A small OpenID Connect provider for the tests (integration and end to
// end): discovery, a sign-in form with a few users, the authorization code
// flow with PKCE, ID tokens signed with RS256. No dependencies, so Node runs
// it as it is:  node server/test/fake-idp.ts <port> <issuer> <client> <secret>

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export const IDP_USERS: Record<string, { sub: string; email: string; name: string; unverified?: boolean }> = {
  alice: { sub: 'sub-alice', email: 'alice@example.com', name: 'Alice' },
  // A provider that lets anyone type an e-mail: Mallory typed the admin's.
  mallory: { sub: 'sub-mallory', email: 'admin@example.com', name: 'Mallory', unverified: true },
  olivia: { sub: 'sub-olivia', email: 'olivia@example.com', name: 'Olivia' },
  newbie: { sub: 'sub-newbie', email: 'newbie@example.com', name: 'Newbie' },
};

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function startIdp(port: number, issuer: string, clientId: string, clientSecret: string): Promise<Server> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const codes = new Map<string, { user: string; nonce: string; challenge: string; redirect: string; at: number }>();

  function idToken(user: string, nonce: string, authTime: number): string {
    const u = IDP_USERS[user]!;
    const now = Math.floor(Date.now() / 1000);
    const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }));
    const body = b64(
      JSON.stringify({ iss: issuer, sub: u.sub, aud: clientId, iat: now, exp: now + 300, nonce, auth_time: authTime, preferred_username: user, email: u.email, email_verified: !u.unverified, name: u.name }),
    );
    return `${head}.${body}.${b64(sign('sha256', Buffer.from(`${head}.${body}`), privateKey))}`;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (x: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(x));
      };
      if (url.pathname === '/.well-known/openid-configuration') {
        return json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          scopes_supported: ['openid', 'profile', 'email'],
        });
      }
      if (url.pathname === '/jwks') return json({ keys: [jwk] });
      if (url.pathname === '/authorize') {
        const q = url.searchParams;
        if (q.get('client_id') !== clientId || q.get('code_challenge_method') !== 'S256') return json({ error: 'invalid_request' }, 400);
        // A sign-in page: one button per user. The form carries the request on.
        const hidden = ['redirect_uri', 'state', 'nonce', 'code_challenge'].map((k) => `<input type="hidden" name="${k}" value="${(q.get(k) ?? '').replace(/"/g, '&quot;')}">`).join('');
        const buttons = Object.keys(IDP_USERS)
          .map((u) => `<button name="user" value="${u}">Sign in as ${u}</button>`)
          .join('');
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<!doctype html><title>Test IdP</title><h1>Test IdP</h1><p>prompt=${q.get('prompt') ?? ''}</p><form method="post" action="/login">${hidden}${buttons}</form>`);
      }
      if (url.pathname === '/login' && req.method === 'POST') {
        const f = new URLSearchParams(body);
        const user = f.get('user') ?? '';
        if (!IDP_USERS[user]) return json({ error: 'no such user' }, 400);
        const code = randomBytes(16).toString('hex');
        codes.set(code, { user, nonce: f.get('nonce') ?? '', challenge: f.get('code_challenge') ?? '', redirect: f.get('redirect_uri') ?? '', at: Math.floor(Date.now() / 1000) });
        const back = new URL(f.get('redirect_uri') ?? '');
        back.searchParams.set('code', code);
        back.searchParams.set('state', f.get('state') ?? '');
        back.searchParams.set('iss', issuer);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const f = new URLSearchParams(body);
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
        const [id, secret] = basic ? Buffer.from(basic[1]!, 'base64').toString().split(':').map(decodeURIComponent) : [f.get('client_id'), f.get('client_secret')];
        if (id !== clientId || secret !== clientSecret) return json({ error: 'invalid_client' }, 401);
        const c = codes.get(f.get('code') ?? '');
        codes.delete(f.get('code') ?? '');
        if (!c || c.redirect !== f.get('redirect_uri')) return json({ error: 'invalid_grant' }, 400);
        if (createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') !== c.challenge) return json({ error: 'invalid_grant', error_description: 'pkce' }, 400);
        return json({ access_token: randomBytes(16).toString('hex'), token_type: 'Bearer', expires_in: 300, id_token: idToken(c.user, c.nonce, c.at) });
      }
      json({ error: 'not_found' }, 404);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

// Run on its own (the end-to-end tests start it as a container).
if (process.argv[1]?.endsWith('fake-idp.ts')) {
  const [port = '8200', issuer = 'http://localhost:8200', client = 'burrow', secret = 'burrow-secret'] = process.argv.slice(2);
  void startIdp(Number(port), issuer, client, secret).then(() => console.log(`fake IdP on ${port} as ${issuer}`));
}
