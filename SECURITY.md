# Security

Burrow holds SSH access to your machines, so a security problem in it
matters. Please report one privately, not as a public issue:
[GitHub's private vulnerability reporting](https://github.com/R31l4nd/Burrow/security/advisories/new).

Say what you found, how to reproduce it and which version you run
(Settings -> About). You will hear back within a week; a fix comes in a
release with a note in [CHANGELOG.md](CHANGELOG.md) and, where it helps,
an advisory.

Supported: the newest release. Burrow updates itself (Settings -> About),
so staying current takes one tap.

How Burrow protects what it holds is described in the README's
[security model](README.md#security-model), in
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) (what is at stake, from whom,
what is left to you) and in [docs/DESIGN.md](docs/DESIGN.md).

## Advisories in dependencies

The gate checks them on every push: `npm audit` for the packages Burrow
ships (and the build and test tools: a critical advisory there fails too,
a high one is noted),
`govulncheck` for the app's WireGuard code, and trivy for the built images
(the application's Debian packages and Node modules, and the backup
image's Alpine packages); a release scans the images it publishes again,
for both architectures. A high or critical advisory fails it (in the
images only one with a fix: trivy leaves out what nobody can fix yet). The
Android app's Gradle libraries are not scanned by a tool; they are few,
pinned with checksums (`android/gradle/verification-metadata.xml`), and an
advisory in them is judged by hand (below). The few let through are listed with why they cannot
do harm here and until when (then they fail again):
[scripts/audit-allow.json](scripts/audit-allow.json) and
[.trivyignore.yaml](.trivyignore.yaml).

Known and judged:

- `braces` (through the editor's shell language server): a deeply nested
  glob exhausts the stack. Burrow starts that server with background
  analysis off, and every setting it gets is Burrow's own: the browser's
  configuration changes are dropped and its `initialize` request is
  rebuilt with the server's own options, so no pattern from a person
  reaches it.
- `net.i2p.crypto:eddsa` in the Android app (through sshj, the direct
  route's SSH client): its Ed25519 signatures are malleable (CVE-2020-36843),
  and there is no fixed version. A malleable signature is a different valid
  signature by the same key; it does not let anyone sign without the key.
  The library only checks a host's Ed25519 host-key signature; the app's
  own key is EC P-256 in Android's keystore.
- `golang.org/x/crypto` in the app's WireGuard module: an advisory in its
  OpenPGP package, which the WireGuard code does not import
  (`govulncheck` finds no call).
