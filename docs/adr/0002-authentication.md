# 2. Built-in, mandatory authentication

Date: 2026-09-26 - Status: accepted

## Context

Burrow is a shell into every host it knows. A reverse proxy or VPN is one
layer, not the only one.

## Decision

- Passkeys (WebAuthn, discoverable, user verification required) are the
  primary method; password (argon2id) is only accepted together with TOTP.
- Ten single-use recovery codes are shown once at setup.
- Server-side sessions in a `__Host-` cookie (HttpOnly, Secure,
  SameSite=Strict); the database stores a hash. No JWT: revocation must be
  immediate.
- Step-up (passkey or TOTP) within 15 minutes for sensitive actions.
- First-run claim with a one-time token from the container log.
- Throttling per IP and account, persisted, with an audit trail.

## Consequences

Passkeys are bound to the hostname in `BURROW_ORIGIN`; changing it means
registering them again. OIDC for people with existing single sign-on comes
in 0.12.0 as an additional method, not a replacement.
