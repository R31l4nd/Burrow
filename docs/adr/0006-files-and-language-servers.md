# 6. Files over SFTP, language servers in the container

Date: 2026-09-26 - Status: accepted

## Decision

- File access uses SFTP plus the host's standard tools over the same SSH
  connection; no agent on the host. Copies between hosts stream tar through
  Burrow, which works for trees, keeps permissions and needs only tar.
- Language servers and linters run in the Burrow container on the text the
  editor sends. One process per open editor (not per user, as first
  designed): simpler and robust with several tabs; idle processes stop after ten
  minutes.
- Raw file responses never render as documents in Burrow's origin.

## Consequences

The image is larger (~630 MB). Files are edited as text up to 5 MB. Sudo
saving and a workspace view come in 0.8.0.
