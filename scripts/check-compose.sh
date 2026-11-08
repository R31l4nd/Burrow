#!/usr/bin/env bash
# scripts/check-compose.sh - compose.yaml is valid and keeps its hardening
# (scripts/compose-check.mjs), with the defaults a new install gets: no .env
# (this machine's own is not read) and no COMPOSE_* from the shell.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p .gate
cfg() {
  env -u COMPOSE_FILE -u COMPOSE_PROFILES -u COMPOSE_PROJECT_NAME BURROW_ORIGIN=https://burrow.example.com \
    docker compose --env-file /dev/null "$@" --profile backup config --format json
}
cfg -f compose.yaml > .gate/compose-default.json
cfg -f compose.yaml -f compose.try.yaml > .gate/compose-try.json
# The data in a folder of the checkout, given relative to it (deploy/local: BURROW_DATA=./data/live).
BURROW_DATA=./data/live cfg -f compose.yaml > .gate/compose-folder.json
bash scripts/node.sh node scripts/compose-check.mjs .gate/compose-default.json .gate/compose-try.json .gate/compose-folder.json "$ROOT"
