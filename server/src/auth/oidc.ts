import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as client from 'openid-client';
import { z } from 'zod';
import type { OidcSettings } from '@burrow/shared';
import { isLocalUrl } from '../ai/settings.js';
import { audit } from '../audit.js';
import type { Ctx } from '../context.js';
import { appSettings, invites, passkeys, sessions, users } from '../db/schema.js';
import { actor, HttpError, parse, requireAuth, secretFor } from '../http.js';
import { markStepUp } from './sessions.js';
import { openInvite } from './users.js';

// Single sign-on with OpenID Connect (Authelia, Authentik, Pocket ID,
// Keycloak): the authorization code flow with PKCE. A user signs in through
// the provider when the provider's identity (issuer and sub) is linked to
// the account; the first time, an account whose name equals the provider's
// username, or whose e-mail equals a verified e-mail (as chosen), is linked. Nobody gets an account from the provider alone: that takes an
// invite (which can be accepted through the provider). Step-up works through
// the provider too (a fresh sign-in there: prompt=login, max_age=0).

const KEY = 'oidc';
const SECRET = 'app_settings.oidc.client_secret';
const FLOW_TTL_MS = 10 * 60_000;
const CONFIG_TTL_MS = 60 * 60_000;

interface Stored {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecretEnc: string | null;
  label: string;
  claim: 'preferred_username' | 'email';
}

const DEFAULTS: Stored = { enabled: false, issuer: '', clientId: '', clientSecretEnc: null, label: 'Single sign-on', claim: 'preferred_username' };

function load(ctx: Ctx): Stored {
  const row = ctx.db.select().from(appSettings).where(eq(appSettings.key, KEY)).get();
  return row ? { ...DEFAULTS, ...(JSON.parse(row.value) as Partial<Stored>) } : { ...DEFAULTS };
}

export function getOidc(ctx: Ctx): OidcSettings {
  const s = load(ctx);
  return { enabled: s.enabled, issuer: s.issuer, clientId: s.clientId, hasSecret: s.clientSecretEnc !== null, label: s.label, claim: s.claim, redirectUri: redirectUri(ctx) };
}

const redirectUri = (ctx: Ctx) => `${ctx.config.origin}/api/auth/oidc/callback`;

export const oidcInput = z.object({
  enabled: z.boolean(),
  issuer: z.url().max(300),
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().max(500).optional(),
  label: z.string().trim().min(1).max(40),
  claim: z.enum(['preferred_username', 'email']),
});

// ---- provider configuration (discovery), cached

let cached: { key: string; at: number; config: client.Configuration } | null = null;

async function configuration(ctx: Ctx, s: Stored): Promise<client.Configuration> {
  const key = `${s.issuer}|${s.clientId}|${s.clientSecretEnc}`;
  if (cached && cached.key === key && ctx.now() - cached.at < CONFIG_TTL_MS && Date.now() - cached.at < CONFIG_TTL_MS) return cached.config;
  const secret = s.clientSecretEnc ? ctx.box.open(s.clientSecretEnc, SECRET) : undefined;
  // Plain http only for a provider on this network (and the tests).
  const execute = new URL(s.issuer).protocol === 'http:' && isLocalUrl(s.issuer) ? [client.allowInsecureRequests] : [];
  let config: client.Configuration;
  try {
    config = await client.discovery(new URL(s.issuer), s.clientId, secret, undefined, { execute, timeout: 10 });
  } catch (err) {
    throw new HttpError(502, 'oidc_unreachable', `The provider did not answer as expected: ${(err as Error).message}`);
  }
  cached = { key, at: Date.now(), config };
  return config;
}

// ---- flows in progress (state -> what to do on the way back)

interface Flow {
  purpose: 'login' | 'stepup' | 'invite';
  verifier: string;
  nonce: string;
  at: number;
  /** stepup: the session to confirm (the callback arrives without the cookie). */
  sessionHash?: string;
  inviteToken?: string;
  /** The page to come back to ("/containers/1/web"). */
  next: string;
  /** SHA-256 of the cookie set in the browser that started it: the callback must come back to that browser. */
  browser: string;
  /** The provider set up when it started: switched off or changed since, the flow is void (AUDIT2 AUTH-08). */
  provider: string;
}

/** Which provider, as set up now: a flow started under another is not finished. */
const providerOf = (s: Stored) => `${issuerOf(s.issuer)} ${s.clientId}`;

/**
 * Single sign-on is a way in for this account now: switched on, and linked
 * at the provider set up now (a link to an earlier one signs nobody in).
 */
export function ssoUsable(ctx: Ctx, u: { oidcSub: string | null; oidcIss: string | null }): boolean {
  const s = load(ctx);
  return s.enabled && !!s.issuer && !!u.oidcSub && u.oidcIss === issuerOf(s.issuer);
}
const flows = new Map<string, Flow>();

// The browser that started a flow keeps a cookie for it: without it a
// callback URL someone else started (and sent you) would sign you in as
// them (login CSRF). Lax: it comes along on the provider's redirect back.
const FLOW_COOKIE = 'burrow_sso';
const FLOW_COOKIE_OPTS = { path: '/api/auth/oidc', httpOnly: true, secure: true, sameSite: 'lax' as const };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** "https://id.example/app/" and "https://id.example/app" are one provider. */
const issuerOf = (s: string) => s.replace(/\/+$/, '');

function prune(): void {
  const now = Date.now();
  for (const [k, f] of flows) if (now - f.at > FLOW_TTL_MS) flows.delete(k);
}

export interface OidcHooks {
  /** Signs the user in on this reply (a new session and cookie). */
  signIn: (req: FastifyRequest, reply: FastifyReply, user: typeof users.$inferSelect, method: string) => void;
}

/** Username the claim gives: made to fit Burrow's rules. */
export function usernameFrom(value: string): string {
  const base = value.split('@')[0]!.toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '');
  return base.slice(0, 32) || 'user';
}

export function registerOidcRoutes(app: FastifyInstance, ctx: Ctx, hooks: OidcHooks): void {
  /** For the sign-in page: is there a button, and what does it say. */
  app.get('/api/auth/oidc', { config: { auth: 'public' } }, async () => {
    const s = load(ctx);
    return { enabled: s.enabled && !!s.issuer, label: s.label };
  });

  app.get('/api/settings/oidc', async () => getOidc(ctx));

  app.put('/api/settings/oidc', { config: { stepUp: true } }, async (req) => {
    const b = parse(oidcInput, req.body);
    const cur = load(ctx);
    const next: Stored = {
      enabled: b.enabled,
      issuer: b.issuer.replace(/\/+$/, ''),
      clientId: b.clientId,
      // Another provider: the stored client secret is not sent there unless given again (A3-SRV-17).
      clientSecretEnc: secretFor(cur.clientSecretEnc, b.clientSecret, cur.issuer.replace(/\/+$/, '') === b.issuer.replace(/\/+$/, ''), (v) => ctx.box.seal(v, SECRET)),
      label: b.label,
      claim: b.claim,
    };
    // An admin who signs in by this provider alone keeps a way in: not
    // switched off or moved from under them (AUDIT2 AUTH-07).
    const stillIn = (u: typeof users.$inferSelect) => next.enabled && !!next.issuer && u.oidcIss === issuerOf(next.issuer);
    const stranded = ctx.db
      .select()
      .from(users)
      .where(eq(users.role, 'admin'))
      .all()
      .filter((u) => ssoUsable(ctx, u) && !stillIn(u) && !(u.passwordHash !== null && u.totpConfirmed) && !ctx.db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, u.id)).get());
    if (stranded.length) throw new HttpError(409, 'last_login_method', `${stranded.map((u) => u.username).join(', ')} would have no way to sign in: add a passkey or a password for them first.`);
    // Switched on: the provider must answer now, not at the first sign-in.
    if (next.enabled) await configuration(ctx, next);
    const value = JSON.stringify(next);
    ctx.db
      .insert(appSettings)
      .values({ key: KEY, value, updatedAt: ctx.now() })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: ctx.now() } })
      .run();
    // Flows begun under the provider as it was: void now (AUDIT2 AUTH-08).
    if (providerOf(next) !== providerOf(cur) || !next.enabled) flows.clear();
    audit(ctx, actor(req), 'settings.oidc', null, { enabled: next.enabled, issuer: next.issuer });
    return getOidc(ctx);
  });

  /** Off to the provider. purpose: login, stepup (signed in) or invite (with the invite token). */
  app.get('/api/auth/oidc/start', { config: { auth: 'public' } }, async (req, reply) => {
    const q = parse(
      z.object({
        purpose: z.enum(['login', 'stepup', 'invite']).default('login'),
        invite: z.string().max(100).optional(),
        // A page of Burrow only, never another site.
        next: z
          .string()
          .max(500)
          .regex(/^\/(?!\/)[^\s]*$/)
          .default('/'),
      }),
      req.query,
    );
    const s = load(ctx);
    if (!s.enabled || !s.issuer) throw new HttpError(404, 'oidc_off');
    const browser = randomBytes(24).toString('base64url');
    const flow: Flow = { purpose: q.purpose, verifier: client.randomPKCECodeVerifier(), nonce: client.randomNonce(), at: Date.now(), next: q.next, browser: sha(browser), provider: providerOf(s) };
    if (q.purpose === 'stepup') flow.sessionHash = requireAuth(req).session.idHash;
    if (q.purpose === 'invite') {
      openInvite(ctx, q.invite ?? '');
      flow.inviteToken = q.invite;
    }
    const config = await configuration(ctx, s);
    const state = randomBytes(24).toString('base64url');
    prune();
    flows.set(state, flow);
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri(ctx),
      scope: 'openid profile email',
      code_challenge: await client.calculatePKCECodeChallenge(flow.verifier),
      code_challenge_method: 'S256',
      state,
      nonce: flow.nonce,
      ...(q.purpose === 'stepup' ? { prompt: 'login', max_age: '0' } : {}),
    });
    reply.setCookie(FLOW_COOKIE, browser, { ...FLOW_COOKIE_OPTS, maxAge: FLOW_TTL_MS / 1000 });
    return reply.redirect(url.href);
  });

  /** Back from the provider. Ends on a page of Burrow either way. */
  app.get('/api/auth/oidc/callback', { config: { auth: 'public' } }, async (req, reply) => {
    const q = req.query as { state?: string; error?: string };
    const flow = q.state ? flows.get(q.state) : undefined;
    // Back to the page it started on, with the outcome for the page to show.
    const back = (hash: string) => {
      const m = /^\/(?:\?sso=(.*))?$/.exec(hash);
      const next = flow?.next ?? '/';
      const to = m ? (m[1] ? `${next}${next.includes('?') ? '&' : '?'}sso=${m[1]}` : next) : hash;
      return reply.redirect(`${ctx.config.origin}/#${to}`);
    };
    if (q.state) flows.delete(q.state);
    const cookie = (req.cookies as Record<string, string | undefined>)[FLOW_COOKIE];
    reply.clearCookie(FLOW_COOKIE, FLOW_COOKIE_OPTS);
    if (!flow || Date.now() - flow.at > FLOW_TTL_MS) return back('/?sso=expired');
    // Started in another browser: not this one's sign-in.
    if (!cookie || sha(cookie) !== flow.browser) {
      audit(ctx, { userId: null, username: null, ip: req.ip }, 'auth.sso_failed', null, { reason: 'another browser' });
      return back('/?sso=expired');
    }
    if (q.error) return back(`/?sso=${encodeURIComponent(q.error)}`);
    const s = load(ctx);
    if (!s.enabled || !s.issuer || providerOf(s) !== flow.provider) return back('/?sso=expired');
    let claims: client.IDToken;
    try {
      const config = await configuration(ctx, s);
      const current = new URL(req.url, ctx.config.origin);
      const tokens = await client.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: flow.verifier,
        expectedState: q.state,
        expectedNonce: flow.nonce,
        idTokenExpected: true,
        ...(flow.purpose === 'stepup' ? { maxAge: 300 } : {}),
      });
      claims = tokens.claims()!;
    } catch (err) {
      ctx.log.warn(`oidc: sign-in failed: ${(err as Error).message}`);
      audit(ctx, { userId: null, username: null, ip: req.ip }, 'auth.sso_failed', null, { reason: (err as Error).message.slice(0, 200) });
      return back('/?sso=failed');
    }
    const sub = String(claims.sub);
    // A subject is unique only at its own provider.
    const iss = issuerOf(String(claims.iss));
    const claimValue = String((claims as Record<string, unknown>)[s.claim] ?? '');
    // An e-mail counts only when the provider vouches for it: some let
    // anyone type one in, an admin's too.
    const email = typeof claims.email === 'string' && claims.email_verified === true ? claims.email : null;
    const linked = (u: { oidcSub: string | null; oidcIss: string | null } | undefined) => !!u && u.oidcSub === sub && u.oidcIss === iss;

    if (flow.purpose === 'stepup') {
      const session = ctx.db.select().from(sessions).where(eq(sessions.idHash, flow.sessionHash ?? '')).get();
      const user = session ? ctx.db.select().from(users).where(eq(users.id, session.userId)).get() : undefined;
      if (!session || !user || !linked(user)) return back('/?sso=wrong_user');
      markStepUp(ctx, session);
      audit(ctx, { userId: user.id, username: user.username, ip: req.ip }, 'auth.step_up', null, { method: 'sso' });
      return back('/?sso=stepped_up');
    }

    if (flow.purpose === 'invite') {
      let inv;
      try {
        inv = openInvite(ctx, flow.inviteToken ?? '');
      } catch {
        return back('/?sso=invite_invalid');
      }
      if (ctx.db.select().from(users).where(and(eq(users.oidcSub, sub), eq(users.oidcIss, iss))).get()) return back('/?sso=already_linked');
      let name = usernameFrom(claimValue || email || sub);
      for (let i = 2; ctx.db.select().from(users).where(eq(users.username, name)).get(); i++) name = `${usernameFrom(claimValue || sub).slice(0, 28)}-${i}`;
      const user = ctx.db
        .insert(users)
        .values({ username: name, role: inv.role, totpConfirmed: false, incomplete: false, oidcSub: sub, oidcIss: iss, email, createdAt: ctx.now() })
        .returning()
        .get();
      ctx.db.update(invites).set({ usedAt: ctx.now(), usedBy: user.id }).where(eq(invites.id, inv.id)).run();
      audit(ctx, { userId: user.id, username: user.username, ip: req.ip }, 'invite.accepted', user.username, { role: user.role, method: 'sso' });
      hooks.signIn(req, reply, user, 'sso');
      return back('/');
    }

    // Sign in: the linked account, or (linked now) the one whose name is the
    // provider's username, or whose e-mail is the verified e-mail, as chosen.
    let user = ctx.db.select().from(users).where(and(eq(users.oidcSub, sub), eq(users.oidcIss, iss))).get();
    const by = s.claim === 'email' ? (email ? sql`lower(${users.email}) = lower(${email})` : null) : claimValue ? sql`lower(${users.username}) = lower(${claimValue})` : null;
    if (!user && by) {
      const match = ctx.db
        .select()
        .from(users)
        .where(and(sql`${users.oidcSub} IS NULL`, by))
        .get();
      if (match && !match.incomplete) {
        ctx.db.update(users).set({ oidcSub: sub, oidcIss: iss, email: match.email ?? email }).where(eq(users.id, match.id)).run();
        user = { ...match, oidcSub: sub, oidcIss: iss };
        audit(ctx, { userId: match.id, username: match.username, ip: req.ip }, 'auth.sso_linked', match.username);
      }
    }
    if (!user || user.incomplete) {
      audit(ctx, { userId: null, username: claimValue || null, ip: req.ip }, 'auth.sso_unknown', null, { sub });
      return back('/?sso=unknown');
    }
    hooks.signIn(req, reply, user, 'sso');
    return back('/');
  });
}
