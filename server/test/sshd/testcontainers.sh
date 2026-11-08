#!/usr/bin/env bash
# server/test/sshd/testcontainers.sh up|down - a small compose-like stack on
# this machine's Docker for the container and log tests: a web service that
# logs JSON (pino-style levels) on stdout and errors on stderr, and a worker
# that exits. Labelled as compose project "burrowtest".
set -euo pipefail
ALPINE="alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f"
label() { printf -- '--label com.docker.compose.project=burrowtest --label com.docker.compose.service=%s --label com.docker.compose.project.config_files=/srv/burrowtest/compose.yaml' "$1"; }
case "${1:-}" in
  up)
    docker rm -fv burrowtest-web burrowtest-worker >/dev/null 2>&1 || true
    # shellcheck disable=SC2046
    docker run -d --label burrow.ignore=true --name burrowtest-web $(label web) "$ALPINE" sh -c \
      'i=0; while true; do i=$((i+1)); echo "{\"level\":30,\"msg\":\"request $i\"}"; [ $((i % 3)) -eq 0 ] && echo "ERROR upstream timeout $i" >&2; sleep 0.5; done' >/dev/null
    # shellcheck disable=SC2046
    docker run -d --label burrow.ignore=true --name burrowtest-worker $(label worker) "$ALPINE" sh -c 'echo "WARN worker starting"; echo "INFO job done"; exit 3' >/dev/null
    ;;
  down)
    docker rm -fv burrowtest-web burrowtest-worker >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 up|down"; exit 2 ;;
esac
