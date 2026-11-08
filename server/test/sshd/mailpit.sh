#!/usr/bin/env bash
# server/test/sshd/mailpit.sh up|down - a throwaway mail server for the
# e-mail tests: SMTP on localhost:${MAILPIT_SMTP_PORT:-1025}, its API (to read
# what arrived) on localhost:${MAILPIT_API_PORT:-8025}.
set -euo pipefail
SMTP="${MAILPIT_SMTP_PORT:-1025}"
API="${MAILPIT_API_PORT:-8025}"
NAME="${MAILPIT_CONTAINER:-burrowtest-mailpit}"
MAILPIT="axllent/mailpit:latest@sha256:9b3a463be15354c0f0eba91697d80e3e0d8a5623ef0e627cacc836bc17fd5231"
case "${1:-}" in
  up)
    docker rm -fv "$NAME" >/dev/null 2>&1 || true
    docker run -d --label burrow.ignore=true --name "$NAME" -p "127.0.0.1:${SMTP}:1025" -p "127.0.0.1:${API}:8025" "$MAILPIT" >/dev/null
    for _ in $(seq 1 50); do
      curl -fs "http://127.0.0.1:${API}/api/v1/messages" >/dev/null 2>&1 && break
      sleep 0.2
    done
    ;;
  down)
    docker rm -fv "$NAME" >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 up|down"; exit 2 ;;
esac
