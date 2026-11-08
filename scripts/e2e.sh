#!/usr/bin/env bash
# scripts/e2e.sh - end-to-end tests: a freshly built Burrow container, a
# throwaway sshd next to it, and Playwright (desktop + phone viewport)
# against it. Everything is removed afterwards.
#
#   bash scripts/e2e.sh            # builds burrow:e2e first
#   SKIP_BUILD=1 bash scripts/e2e.sh
#
# Writing a test against what a whole run leaves behind (hosts, alerts,
# analyses, workspaces), without a whole run each time:
#   E2E_KEEP=1 bash scripts/e2e.sh                 # a run that leaves everything up
#   E2E_REUSE=1 bash scripts/e2e.sh --no-deps --project=press-each   # just that, again and again
#   TOUR_ONLY=phone-nl-host bash scripts/e2e.sh --no-deps --project=setup --project=desktop --project=look --grep "claims a fresh|builds a group|every page and dialog"   # a few tour screens
# The gate uses neither.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/docker-lib.sh
. "$ROOT/scripts/docker-lib.sh"
cd "$ROOT"

PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27"
PORT="${E2E_PORT:-8190}"
NET=burrow-e2e
APP=burrow-e2e-app
SSHD=burrow-e2e-sshd
SSHD2=burrow-e2e-sshd2
# A host with the real docker CLI on this machine's Docker, through a filter
# that shows it the tests' own containers only (server/test/sshd/docker-filter.mjs):
# the throwaway "burrowtest" ones of server/test/sshd/testcontainers.sh and
# what the specs start, never the live ones (A3-WEB-16, W-FUNC-17).
SSHD3=burrow-e2e-docker
DFILTER=burrow-e2e-dockerfilter
DFILTER_DIR="${TMPDIR:-/tmp}/burrow-e2e-dockerfilter"
LLM=burrow-e2e-llm
IDP=burrow-e2e-idp
# The browser's network: Playwright shares this container's, on the test
# network, never the machine's (e2e/forward.mjs: other containers starting
# made Chromium abort page loads, net::ERR_NETWORK_CHANGED).
FWD=burrow-e2e-fwd
NODE_IMAGE="$(grep -oE 'node:[^"]+' scripts/node.sh | head -1)"

cleanup() {
  # Burrow's own log next to the test results, for when a test fails.
  [ -d e2e/test-results ] && docker logs "$APP" > e2e/test-results/burrow.log 2>&1 || true
  # The routes the tests used successfully, for scripts/route-coverage.mjs.
  mkdir -p coverage && docker exec "$APP" cat /tmp/route-hits.txt >> coverage/route-hits.txt 2>/dev/null || true
  docker rm -fv "$APP" "$SSHD" "$SSHD2" "$SSHD3" "$DFILTER" "$LLM" "$IDP" "$FWD" >/dev/null 2>&1 || true
  rm -rf "$DFILTER_DIR"
  bash server/test/sshd/testcontainers.sh down
  # What the tests made on this machine's Docker, if a failed run left it.
  for p in burrowtest-e2e burrowtest-panel; do docker ps -aq --filter "label=com.docker.compose.project=$p" | xargs -r docker rm -fv >/dev/null 2>&1 || true; done
  docker rm -fv burrowtest-e2ecrash >/dev/null 2>&1 || true
  # Containers a spec starts itself and removes at its end: gone too when that spec failed half way (AUDIT2 TEST-13).
  docker rm -fv burrowtest-lf burrowtest-bulk-a burrowtest-bulk-b burrowtest-bulk-c >/dev/null 2>&1 || true
  docker ps -aq --filter name=burrowtest-many- | xargs -r docker rm -fv >/dev/null 2>&1 || true
  docker network rm burrowtest-e2e_default burrowtest-panel_default >/dev/null 2>&1 || true
  bash server/test/sshd/registry.sh down
  bash server/test/sshd/ntfy.sh down
  bash server/test/sshd/mailpit.sh down
  docker network rm "$NET" >/dev/null 2>&1 || true
}
# A run of chosen projects without their dependencies (--no-deps) keeps them
# in the order given, one at a time: run side by side, the setup would not be
# done before the others start.
case " $* " in *" --no-deps "*) set -- "$@" --workers=1 ;; esac
if [ -n "${E2E_REUSE:-}" ]; then
  # The instance a kept run left up, its passkey in e2e/.state.
  docker inspect "$APP" >/dev/null 2>&1 || { echo "no kept e2e instance: run E2E_KEEP=1 bash scripts/e2e.sh first"; exit 1; }
  GW="$(docker network inspect "$NET" -f '{{(index .IPAM.Config 0).Gateway}}')"
  exec docker run --rm --label burrow.ignore=true --network "container:$FWD" --ipc host \
    --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -e CI="${CI:-}" -e E2E_RETRIES="${E2E_RETRIES:-0}" -e E2E_RESUME="${E2E_RESUME:-}" -e REPLAY="${REPLAY:-}" -e TOUR_ONLY="${TOUR_ONLY:-}" -e README_SHOTS="${README_SHOTS:-}" -e E2E_BASE_URL="http://localhost:${PORT}" -e SSHD_HOST="$SSHD" -e SSHD2_HOST="$SSHD2" -e DOCKER_HOST_SSHD="$SSHD3" -e LLM_URL="http://$LLM:8000/v1" -e APPS_BASE="http://$GW:8191" -e IDP_URL="http://$GW:8200" \
    -v "$ROOT":/app -w /app/e2e \
    "$PLAYWRIGHT_IMAGE" npx playwright test "$@"
fi
[ -n "${E2E_KEEP:-}" ] || trap cleanup EXIT
cleanup

[ -n "${SKIP_BUILD:-}" ] || rebuild burrow:e2e .
# The Android app's direct route as the app bundles it (web/dist-direct):
# mobile-direct.spec.ts serves it at the app's origin (UIA-17).
bash scripts/node.sh sh -c 'npm run build -w @burrow/shared >/dev/null && npm run build:direct -w @burrow/web >/dev/null'
rebuild burrow-test-sshd server/test/sshd
rebuild burrow-test-sshd-docker -f server/test/sshd/Dockerfile.docker server/test/sshd
# The Android app's direct route page (web/dist-direct), looked at by workspace-direct.spec.ts with a stand-in for the app.
bash scripts/node.sh sh -c 'npm run build -w @burrow/shared >/dev/null && npm run build:direct -w @burrow/web >/dev/null'

docker network create "$NET" >/dev/null
# The network's gateway is this machine as seen from the containers, and one
# of this machine's own addresses: an app published there is reachable from
# Burrow (which checks it) and from the browser (which frames it).
GW="$(docker network inspect "$NET" -f '{{(index .IPAM.Config 0).Gateway}}')"
docker run -d --label burrow.ignore=true --name "$SSHD" --network "$NET" burrow-test-sshd >/dev/null
docker run -d --label burrow.ignore=true --name "$SSHD2" --network "$NET" burrow-test-sshd >/dev/null
docker_filter "$DFILTER" "$DFILTER_DIR"
docker run -d --label burrow.ignore=true --name "$SSHD3" --network "$NET" -v "$DFILTER_DIR":/var/run/docker-filter burrow-test-sshd-docker >/dev/null
bash server/test/sshd/testcontainers.sh up
# A registry on this machine's localhost:5001 (where its Docker pulls from),
# which Burrow reaches by name on the test network.
bash server/test/sshd/registry.sh up
docker network connect "$NET" burrowtest-registry
# An ntfy server for push: Burrow posts to it by name, the tests read it on localhost:5002.
bash server/test/sshd/ntfy.sh up
docker network connect "$NET" burrowtest-ntfy
# A mail server: Burrow sends to it by name, the tests read its API on localhost:8025.
bash server/test/sshd/mailpit.sh up
docker network connect "$NET" burrowtest-mailpit
# A stand-in for an OpenAI-compatible LLM server (e2e/fake-llm.mjs).
docker run -d --label burrow.ignore=true --name "$LLM" --network "$NET" -p "$GW:8191:8000" --user "$(id -u):$(id -g)" -v "$ROOT/e2e":/e2e:ro "$NODE_IMAGE" node /e2e/fake-llm.mjs >/dev/null
# A single sign-on provider (server/test/fake-idp.ts), on this machine's
# gateway address so Burrow and the browser reach it under the same name.
docker run -d --label burrow.ignore=true --name "$IDP" --network "$NET" -p "$GW:8200:8200" --user "$(id -u):$(id -g)" -v "$ROOT/server/test":/idp:ro "$NODE_IMAGE" node /idp/fake-idp.ts 8200 "http://$GW:8200" burrow burrow-secret >/dev/null
# Same hardening as compose.yaml, so the tests cover the real runtime shape.
# TERMINAL_MAX_SESSIONS=100: sessions in tmux stay until closed (decision 21), and the
# specs together open more than the 20 a person may have; integration tests the limit.
docker run -d --label burrow.ignore=true --name "$APP" --network "$NET" -p "127.0.0.1:${PORT}:8080" \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -e BURROW_ORIGIN="http://localhost:${PORT}" -e STATUS_INTERVAL_SECONDS=5 -e TERMINAL_MAX_SESSIONS=100 \
  -e BURROW_IGNORE_LABEL=burrow.test-ignore -e BURROW_ROUTE_LOG=/tmp/route-hits.txt \
  -e REGISTRY_ENDPOINTS="localhost:5001=http://burrowtest-registry:5000" \
  -e UPDATE_CHECK_EXCLUDE='^(?!localhost:5001/)' \
  burrow:e2e >/dev/null

# At localhost in the browser's network: Burrow, and the stand-ins the tests read directly.
docker run -d --label burrow.ignore=true --name "$FWD" --network "$NET" --user "$(id -u):$(id -g)" -v "$ROOT/e2e":/e2e:ro "$NODE_IMAGE" \
  node /e2e/forward.mjs "$PORT=$APP:8080" 5001=burrowtest-registry:5000 5002=burrowtest-ntfy:80 8025=burrowtest-mailpit:8025 >/dev/null
for _ in $(seq 1 50); do
  [ "$(docker logs "$FWD" 2>&1 | grep -c '^forwarding')" -eq 4 ] && break
  sleep 0.2
done

TOKEN=""
for _ in $(seq 1 50); do
  TOKEN="$(docker logs "$APP" 2>&1 | grep -oE '^ +[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$' | tr -d ' ' | tail -1 || true)"
  [ -n "$TOKEN" ] && break
  sleep 0.2
done
[ -n "$TOKEN" ] || { echo "no setup token in the container log"; docker logs "$APP"; exit 1; }

# A resumed gate (RESUME=1, scripts/gate.sh) runs only some specs again: what
# the run before them pressed, saw and covered stays and is added to.
if [ -n "${E2E_RESUME:-}" ]; then rm -rf e2e/.state; else rm -rf e2e/test-results e2e/.state; fi
docker run --rm --label burrow.ignore=true --network "container:$FWD" --ipc host \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e CI="${CI:-}" -e E2E_RETRIES="${E2E_RETRIES:-0}" -e E2E_RESUME="${E2E_RESUME:-}" -e REPLAY="${REPLAY:-}" -e TOUR_ONLY="${TOUR_ONLY:-}" -e README_SHOTS="${README_SHOTS:-}" -e E2E_BASE_URL="http://localhost:${PORT}" -e E2E_SETUP_TOKEN="$TOKEN" -e SSHD_HOST="$SSHD" -e SSHD2_HOST="$SSHD2" -e DOCKER_HOST_SSHD="$SSHD3" -e LLM_URL="http://$LLM:8000/v1" -e APPS_BASE="http://$GW:8191" -e IDP_URL="http://$GW:8200" \
  -v "$ROOT":/app -w /app/e2e \
  "$PLAYWRIGHT_IMAGE" npx playwright test "$@"
