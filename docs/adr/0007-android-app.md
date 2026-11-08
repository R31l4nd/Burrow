# 7. The Android app: a WebView shell with its own sign-in key

Date: 2026-09-26 - Status: accepted

## Context

For 0.5.0, Burrow on the phone as an app: fingerprint lock, no
screenshots, files to and from other apps, and web apps (Radarr, ...) in tabs
that stay signed in. Passkeys cannot follow it there: a WebView (or any
native app) may use a passkey only for a domain whose
`/.well-known/assetlinks.json` Google has verified from the internet, and
`*.local.*` exists only on the LAN.

## Decision

- **One app, the same web UI.** Kotlin, a WebView on the server's origin, no
  second UI to keep in step. What the page cannot do (a fingerprint, the
  share sheet, Downloads, shortcuts, native tabs) it asks the app for
  through a small bridge (`WebMessageListener`, injected only into the
  server's origin, main frame only, a fixed list of methods).
- **A device key instead of a passkey.** Paired once with a one-time code
  from a signed-in browser (step-up required to show one), the app makes an
  EC P-256 key in the Android Keystore that signs only after a fingerprint
  (or the screen lock on Android 11+) and is voided when fingerprints are
  added. The server stores the public key; the key signs Burrow's own
  challenge (`burrow-device-v1`, purpose, origin, random), for signing in and
  for step-up. The app refuses to sign anything else. Unpairing deletes the
  device and its sessions.
- **Distributed by Burrow itself.** `make apk` builds and signs the APK in a
  pinned container and copies it into the data volume; signed-in users
  download it under Settings. No store, no sideloading from elsewhere.
  Signed with APK Signature Scheme v3 (amended 2026-10-11, A3-AND-18), so
  the key can be rotated later with a lineage (`apksigner rotate`) without
  a new app id; `make apk` checks the v3 signature is there. With minSdk 29
  every phone checks v3, so no v2 block is added; no v4 (`.idsig`, only for
  adb's incremental installs).
- **App tabs in the app are native WebViews with a profile each** (their own
  cookie jar); in a browser an app is framed when its headers allow it -
  the server checks, and only those origins enter `frame-src` - else it
  opens in a new tab.
- `assetlinks.json` is served when `BURROW_ANDROID_CERT_SHA256` is set, for
  a future public hostname where passkeys could work in the app.

## Consequences

- The device key is only as strong as the phone's lock: a PIN counts where
  Android allows it. That is the same bar as a synced passkey.
- The page can ask the app to fetch files from Burrow's own origin only; an
  app tab's page gets no bridge at all. (Amended 2026-10-16, report
  a9552e: the page also reads and writes the phone's own files, but only in
  folders the person picked in Android's folder picker, each with a
  persisted permission the app gives back when the folder is removed; no
  storage permission. See docs/DESIGN.md, "Android app and app tabs".)
- The debug build trusts an extra CA when one is given at build time, for
  the emulator test; release builds trust only the system.
