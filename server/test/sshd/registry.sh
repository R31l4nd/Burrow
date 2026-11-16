#!/usr/bin/env bash
# server/test/sshd/registry.sh up|down - a throwaway registry on this
# machine's localhost:${REGISTRY_PORT:-5001} and three small test images for
# the update tests: v1 and v2 of a service that keeps running, and "bad",
# which exits at once (an update that must be rolled back). The tests push
# them as localhost:5001/burrowtest-app:latest in turn.
set -euo pipefail
PORT="${REGISTRY_PORT:-5001}"
NAME="${REGISTRY_CONTAINER:-burrowtest-registry}"
REGISTRY="registry:3@sha256:82f6ff4a7f982960c8aa51617fea3aabc485df6e55cce80d22deb1de36f1bc3c"
ALPINE="alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f"
case "${1:-}" in
  up)
    docker rm -fv "$NAME" >/dev/null 2>&1 || true
    docker run -d --label burrow.ignore=true --name "$NAME" -p "127.0.0.1:${PORT}:5000" "$REGISTRY" >/dev/null
    for v in v1 v2; do
      printf 'FROM %s\nLABEL burrowtest.version=%s org.opencontainers.image.version=%s org.opencontainers.image.source=https://github.com/burrow-test/app\nCMD ["sh", "-c", "echo %s up; while true; do sleep 1; done"]\n' "$ALPINE" "$v" "$v" "$v" |
        docker build -q -t "burrowtest-app:$v" - >/dev/null
    done
    printf 'FROM %s\nLABEL burrowtest.version=bad\nCMD ["sh", "-c", "echo broken; exit 1"]\n' "$ALPINE" | docker build -q -t burrowtest-app:bad - >/dev/null
    for _ in $(seq 1 50); do
      curl -fs "http://127.0.0.1:${PORT}/v2/" >/dev/null 2>&1 && break
      sleep 0.2
    done
    ;;
  down)
    for p in burrowtest-upd burrowtest-e2e; do docker ps -aq --filter "label=com.docker.compose.project=$p" | xargs -r docker rm -fv >/dev/null; done
    docker network rm burrowtest-upd_default burrowtest-e2e_default >/dev/null 2>&1 || true
    docker rm -fv "$NAME" >/dev/null 2>&1 || true
    # The test images and every tag pushed to the registry: built again on the next up.
    docker images --format '{{.Repository}}:{{.Tag}}' | grep -E "^(burrowtest-app|localhost:${PORT}/burrowtest-(app|ver)):" | xargs -r docker rmi -f >/dev/null 2>&1 || true
    ;;
  *) echo "usage: $0 up|down"; exit 2 ;;
esac
