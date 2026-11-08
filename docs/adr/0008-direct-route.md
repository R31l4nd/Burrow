# 8. The direct route: the phone's own SSH, with Burrow's terminal UI

Date: 2026-09-27 - Status: accepted

## Context

For 0.6.0: when Burrow cannot be reached (WireGuard off, server down), the
Android app must still open a terminal on a host. The design asked for an
ed25519 key in the Android Keystore, a JS bridge to the same xterm UI and an
encrypted cache of hosts, snippets and history.

## Decision

- **Key: ECDSA P-256** (`ecdsa-sha2-nistp256`), not ed25519. The Keystore
  supports ed25519 only from Android 13 and not on every device; P-256 works
  everywhere from Android 10 and OpenSSH accepts it by default. The key never
  leaves the phone and is usable for 30 seconds after a fingerprint (or the
  screen lock on Android 11+): the app asks right before each login.
- **Burrow installs the key per host**, chosen by an admin (with step-up),
  over its own SSH connection: one `authorized_keys` line marked
  `burrow-direct:<device id>:`, removed again when the host is unticked or the
  phone is unpaired. The app reports its key after pairing; a new key (the
  app reinstalled) replaces the old one on its hosts.
- **Host keys are Burrow's.** The cache carries the host keys Burrow trusts
  and the app applies the same rule (any other key is a hard stop). Only a
  host Burrow never connected to can be trusted on the phone, after showing
  the fingerprint.
- **One terminal UI.** The terminal was split out of the session page
  (`components/TermView.svelte`) and a second small entry, `web/direct.html`,
  is bundled into the APK and served from the app's own asset origin
  (`appassets.androidplatform.net`), with no network access of its own. It
  talks to Kotlin (`BurrowDirect` bridge, `sshj`) instead of a WebSocket. The
  shell integration's marks are parsed by the same code as on the server
  (`shared/src/shellwatch.ts`), so completion and history work; the Fig specs
  for about fifty common commands come along (all 700 are 77 MB).
- **Cache:** `GET /api/android/cache` (the paired app's session only) with
  the direct hosts, their host keys, snippets and history, stored on the
  phone with AES-256-GCM under a Keystore key. No Burrow credentials in it.

## Consequences

- Direct sessions have no AI, by design. They were not persistent
  at first; amended 2026-09-30 (1.5.0): on a host with tmux a direct session
  runs in a tmux of its own and leaving only detaches (see docs/USAGE.md).
- Commands typed in direct sessions stay in the phone's cache; they are not
  sent back to Burrow.
- sshj brings BouncyCastle along; the APK grows from about 1 MB to 4 MB.
  (Amended 2026-10-11: with the app's own WireGuard, Go for three ABIs, the
  APK is about 28 MB.)
