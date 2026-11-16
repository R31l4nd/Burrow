#!/usr/bin/env bash
# server/test/sshd/ntfy.sh up|down - a throwaway ntfy server on this
# machine's localhost:${NTFY_PORT:-5002}, for the push tests.
set -euo pipefail
PORT="${NTFY_PORT:-5002}"
NAME="${NTFY_CONTAINER:-burrowtest-ntfy}"
NTFY="binwiederhier/ntfy:latest@sha256:038da2be5e668fee6d36a62884eea48975e1b71c29a56964e5298c1b9165a573"
case "${1:-}" in
  up)
    docker rm -fv "$NAME" >/dev/null 2>&1 || true
    docker run -d --label burrow.ignore=true --name "$NAME" -p "127.0.0.1:${PORT}:80" "$NTFY" serve >/dev/null
    for _ in $(seq 1 50); do
      curl -fs "http://127.0.0.1:${PORT}/v1/health" >/dev/null 2>&1 && break
      sleep 0.2
    done
    ;;
  down)
    docker rm -fv "$NAME" >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 up|down"; exit 2 ;;
esac
