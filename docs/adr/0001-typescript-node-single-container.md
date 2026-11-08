# 1. TypeScript on Node in a single container

Date: 2026-09-26 - Status: accepted

## Context

Burrow needs persistent terminals whose screen can be handed to a device that
reconnects, SFTP, Docker over SSH, WebSockets and language servers, and must
be easy for others to install.

## Decision

One container running Node 24 (active LTS) with Fastify, `ssh2`,
`better-sqlite3` (via Drizzle) and a Svelte 5 SPA. The deciding factor is
`@xterm/headless` + `@xterm/addon-serialize`: the server keeps the terminal
state and sends a reconnecting device the exact current screen.

The first design said Node 22; Node 24 was chosen at the start because 22
is in maintenance.

## Consequences

One language across server, client and tests. SQLite keeps the install to a
single volume. Scaling beyond one process is not a goal.
