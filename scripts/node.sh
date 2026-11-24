#!/usr/bin/env bash
# scripts/node.sh - run node/npm/npx inside the pinned Node image.
#
# Nothing has to be installed on the host: the repo is mounted at /app and
# the command runs as the calling user. The npm cache lives in a named volume
# of that user's so repeated installs stay fast.
#
#   bash scripts/node.sh npm ci
#   bash scripts/node.sh npx vitest run
#
# NODE_IMAGE must match the FROM line in the Dockerfile; scripts/gate.sh checks it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_IMAGE="node:24-trixie-slim@sha256:4d00acb4bcc42c454c4eb801526f7ad7f772ea3bd4fd168c5cc2e384abcbb9d4"

TTY=()
[ -t 0 ] && [ -t 1 ] && TTY=(-it)

# The cache volume, one per user, made theirs when it is new: Docker creates
# a volume owned by root, which a non-root user cannot write (audit OP-12).
CACHE="burrow-npm-cache-$(id -u)"
if ! docker volume inspect "$CACHE" >/dev/null 2>&1; then
  docker volume create --label burrow.ignore=true "$CACHE" >/dev/null
  docker run --rm --label burrow.ignore=true --user 0:0 -v "$CACHE":/npm-cache "$NODE_IMAGE" chown "$(id -u):$(id -g)" /npm-cache
fi

exec docker run --rm --label burrow.ignore=true "${TTY[@]}" \
  --user "$(id -u):$(id -g)" \
  --network "${NODE_NETWORK:-host}" \
  -e HOME=/tmp/home -e npm_config_cache=/npm-cache -e CI="${CI:-}" \
  ${NODE_ENV_FILE:+--env-file "$NODE_ENV_FILE"} \
  -v "$CACHE":/npm-cache \
  -v "$ROOT":/app -w /app \
  "$NODE_IMAGE" "$@"
