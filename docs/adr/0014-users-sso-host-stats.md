# 14. More users, single sign-on, host statistics

Date: 2026-09-27 - Status: accepted

## Context

For 0.12.0, the extras chosen: more than one person (with a role
that cannot open a shell), sign-in through an existing identity provider,
and how the hosts themselves are doing (CPU, memory, disks, temperatures,
SMART).

## Decision

- **Roles on the routes**: every API route is the admin's unless it says
  otherwise (unchanged rule); the routes an operator may use - reading
  hosts, containers, logs, alerts, reports, files and host statistics,
  and analysing logs - are marked `auth: 'user'`. The pages hide what a
  role cannot do; the server refuses it regardless. An end-to-end check
  walks an operator through every page and fails on any refused request.
  (Amended 2026-10-11: files only in the folders an admin allows per
  host, ADR 15.)
- **Invites** are one-time links (a week; only the hash stored). Accepting
  one makes an account with the invite's role that runs the setup wizard
  for a way to sign in - or accepting through single sign-on, which is that
  way. There is always one admin left.
- **OpenID Connect** with openid-client (authorization code, PKCE, nonce).
  Nobody gets an account from the provider alone; a provider identity signs
  in to the account it is linked to, and the first time links to the
  account whose name (or e-mail) equals the chosen claim. Step-up through
  the provider uses `prompt=login` and `max_age=0`. The flow state lives in
  memory, keyed by `state`, and carries the session to confirm (the
  SameSite cookie does not come along on the provider's redirect). Plain
  http is allowed only for a provider on the local network. In the Android
  app the provider's pages stay in the WebView during a sign-in.
- **Host statistics** from what every Linux has (/proc, /sys, df), one SSH
  command; a sample every five minutes for a month of history; SMART with
  smartctl through sudo (the stored password, else `sudo -n`) every six
  hours. A full disk, SMART trouble and heat raise alerts through a second
  built-in rule, subjects written `@disk /data`, `@smart /dev/sda`.

## Consequences

- A flow in progress is lost when Burrow restarts (sign in again).
- Linking by name trusts the provider's names; choose e-mail when names
  there are free to pick.
- Hosts without smartctl, or where sudo needs a password Burrow does not
  have, show SMART as unavailable with the reason.
