#!/usr/bin/env bash
# scripts/docker-lib.sh - sourced by the test scripts.

# need TOOL...: the tools beyond bash, git, make and Docker that a test script
# runs on this machine itself; said at once when one is missing (AUDIT2 OPS-22).
need() {
  local t
  for t in "$@"; do command -v "$t" >/dev/null 2>&1 || { echo "$(basename "$0") needs $t on this machine (besides bash, git, make and Docker)." >&2; exit 1; }; done
}

# rebuild TAG [docker build args...]: build TAG, then remove the image TAG
# pointed at before when nothing uses or names it any more. Every build left
# the one before behind, untagged (88 of Burrow's alone in two weeks).
rebuild() {
  local tag="$1" old new
  shift
  old="$(docker image inspect -f '{{.Id}}' "$tag" 2>/dev/null || true)"
  docker build -q -t "$tag" "$@" >/dev/null
  new="$(docker image inspect -f '{{.Id}}' "$tag")"
  [ -n "$old" ] && [ "$old" != "$new" ] && drop_untagged "$old"
  return 0
}

# drop_untagged ID...: remove these images if no tag names them any more (a
# rollback tag keeps one); without -f, one a container still uses stays too.
drop_untagged() {
  local id
  for id in "$@"; do
    [ "$(docker image inspect -f '{{len .RepoTags}}' "$id" 2>/dev/null || echo gone)" = 0 ] && docker rmi "$id" >/dev/null 2>&1 || true
  done
}

# docker_filter NAME DIR: this machine's Docker as a test sshd with the real
# docker CLI may see it, its tests' own containers only
# (server/test/sshd/docker-filter.mjs), on DIR/docker.sock. The sshd mounts
# DIR at /var/run/docker-filter. Before, it held this machine's socket and a
# test instance read the live containers' logs (A3-WEB-16, W-FUNC-17).
docker_filter() {
  local name="$1" dir="$2" root node
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  node="$(grep -oE 'node:[^"]+' "$root/scripts/node.sh" | head -1)"
  mkdir -p "$dir"
  docker rm -fv "$name" >/dev/null 2>&1 || true
  docker run -d --label burrow.ignore=true --name "$name" --user "$(id -u):$(id -g)" --group-add "$(stat -c %g /var/run/docker.sock)" \
    --read-only --cap-drop ALL --security-opt no-new-privileges \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$dir":/filter -v "$root/server/test/sshd/docker-filter.mjs":/docker-filter.mjs:ro \
    -e DOCKER_FILTER_LOG="${DOCKER_FILTER_LOG:-}" "$node" node /docker-filter.mjs /var/run/docker.sock /filter/docker.sock >/dev/null
  local _
  for _ in $(seq 1 100); do [ -S "$dir/docker.sock" ] && return 0; sleep 0.1; done
  echo "the docker filter did not start"; docker logs "$name"; return 1
}
