#!/usr/bin/env bash
# scripts/test-integration.sh - run the server integration tests against a
# throwaway sshd container (server/test/sshd). The container is removed
# afterwards, also when the tests fail.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/docker-lib.sh
. "$ROOT/scripts/docker-lib.sh"
cd "$ROOT"

NAME="${SSHD_CONTAINER:-burrow-test-sshd}"
PORT="${SSHD_PORT:-2299}"
# A second, separate host for copies between hosts.
NAME2="${NAME}-2"
PORT2="${SSHD2_PORT:-2298}"
# A third with the real docker CLI on this machine's Docker, through a filter
# that shows it the tests' own containers only (server/test/sshd/docker-filter.mjs,
# W-FUNC-17), and a few throwaway containers for it to show (server/test/sshd/testcontainers.sh).
NAME3="${NAME}-docker"
DFILTER="${NAME}-dockerfilter"
DFILTER_DIR="${TMPDIR:-/tmp}/${NAME}-dockerfilter"
PORT3="${DOCKER_SSHD_PORT:-2297}"

# Cleaned up whatever the stage it fails at: set before the first container
# starts, every part tried even when one fails, the env file too (AUDIT2 OPS-11).
ENVF="$(mktemp)"
cleanup() {
  bash server/test/sshd/mailpit.sh down || true
  docker rm -fv "$NAME" "$NAME2" "$NAME3" "$DFILTER" >/dev/null 2>&1 || true
  rm -rf "$DFILTER_DIR"
  bash server/test/sshd/testcontainers.sh down || true
  bash server/test/sshd/registry.sh down || true
  bash server/test/sshd/ntfy.sh down || true
  rm -f "$ENVF"
}
trap cleanup EXIT

rebuild burrow-test-sshd server/test/sshd
rebuild burrow-test-sshd-docker -f server/test/sshd/Dockerfile.docker server/test/sshd
docker rm -fv "$NAME" "$NAME2" "$NAME3" >/dev/null 2>&1 || true
docker run -d --label burrow.ignore=true --name "$NAME" -p "127.0.0.1:${PORT}:22" burrow-test-sshd >/dev/null
docker run -d --label burrow.ignore=true --name "$NAME2" -p "127.0.0.1:${PORT2}:22" burrow-test-sshd >/dev/null
# It holds this machine's Docker socket and listens on 127.0.0.1: a password
# of this run's own, not the one in the repository, so another local user or
# process cannot use it for root while the tests run (A3-OPS-16).
DOCKER_SSHD_PASSWORD="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
docker_filter "$DFILTER" "$DFILTER_DIR"
docker run -d --label burrow.ignore=true --name "$NAME3" -p "127.0.0.1:${PORT3}:22" -e TESTER_PASSWORD="$DOCKER_SSHD_PASSWORD" -v "$DFILTER_DIR":/var/run/docker-filter burrow-test-sshd-docker >/dev/null
bash server/test/sshd/testcontainers.sh up
# A registry on localhost:5001 with test images, for the update tests.
bash server/test/sshd/registry.sh up
# An ntfy server on localhost:5002, for the push tests.
bash server/test/sshd/ntfy.sh up
# A mail server on localhost:1025 (SMTP) and :8025 (API), for e-mail.
bash server/test/sshd/mailpit.sh up

# Wait until sshd answers with its banner, each try bounded; none after 10 s fails here,
# with which, rather than as puzzling test failures later (AUDIT2 OPS-19).
for port in "$PORT" "$PORT2" "$PORT3"; do
  up=0
  for _ in $(seq 1 50); do
    if timeout 2 bash -c "exec 3<>/dev/tcp/127.0.0.1/${port} && head -c 4 <&3 | grep -q SSH" 2>/dev/null; then up=1; break; fi
    sleep 0.2
  done
  [ "$up" = 1 ] || { echo "sshd on port ${port} did not answer"; exit 1; }
done

printf "SSHD_HOST=127.0.0.1\nSSHD_PORT=%s\nSSHD2_PORT=%s\nDOCKER_SSHD_PORT=%s\nDOCKER_SSHD_PASSWORD=%s\nSSHD_CONTAINER=%s\nTEST_LOG=%s\n" "$PORT" "$PORT2" "$PORT3" "$DOCKER_SSHD_PASSWORD" "$NAME" "${TEST_LOG:-}" > "$ENVF"
# The routes the tests used, and the list of all (scripts/route-coverage.mjs).
mkdir -p coverage
printf "BURROW_ROUTE_LOG=/app/coverage/route-hits.txt\nBURROW_ROUTE_LIST=/app/coverage/routes-all.txt\n" >> "$ENVF"
NODE_ENV_FILE="$ENVF" bash scripts/node.sh npm run test:int -w @burrow/server -- "$@"
