#!/usr/bin/env bash
# scripts/fdroid-check.sh - docs/fdroid/io.github.r31l4nd.burrow.yml builds with the
# toolchain the app is built and tested with: Go, its checksum, gomobile and
# the NDK of android/Dockerfile, and the Node of scripts/node.sh. The draft
# had drifted to an older Go and NDK and a Node checksum placeholder
# (A3-OPS-13). Its version fields are filled in by scripts/bump-version.sh.
# NODE_VERSION=vX.Y.Z skips asking the image.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
Y=docs/fdroid/io.github.r31l4nd.burrow.yml
arg() { sed -n "s/^ARG $1=//p" android/Dockerfile | head -n 1; }
GO="$(arg GO_VERSION)"; GO_SHA="$(arg GO_SHA256)"; NDK="$(arg NDK_VERSION)"; GOMOBILE="$(arg GOMOBILE_VERSION)"
NODE="${NODE_VERSION:-$(bash scripts/node.sh node --version | tr -d '\r')}"
bad=0
need() { grep -qF -- "$1" "$Y" || { echo "$Y: no $2 ($1)"; bad=1; }; }
need "go${GO}.linux-amd64.tar.gz" "Go $GO as in android/Dockerfile"
need "$GO_SHA  /tmp/go.tgz" "checksum of Go $GO as in android/Dockerfile"
need "ndk: $NDK" "NDK $NDK as in android/Dockerfile"
need "gomobile@$GOMOBILE " "gomobile $GOMOBILE as in android/Dockerfile"
need "gobind@$GOMOBILE" "gobind $GOMOBILE as in android/Dockerfile"
need "node-${NODE}-linux-x64.tar.xz" "Node $NODE as in scripts/node.sh"
if grep -qE 'NODE_SHA256|[^0-9a-f][0-9a-f]{0,63}  /tmp/node\.tar\.xz' "$Y"; then echo "$Y: the Node checksum is not filled in"; bad=1; fi
[ "$bad" = 0 ] && echo "F-Droid metadata: the toolchain of android/Dockerfile and scripts/node.sh"
exit "$bad"
