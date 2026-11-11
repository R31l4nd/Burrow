#!/usr/bin/env bash
# scripts/gate.sh - the gate that must pass before a push (pre-push hook,
# scripts/install-hooks.sh) and in CI (.github/workflows/ci.yml).
#
# Everything runs in Docker; the host needs bash, git and docker only.
#
# Steps (a failure does not stop the gate - all results are collected):
#   compose      compose.yaml is valid and keeps its hardening (scripts/check-compose.sh)
#   public       nothing private in what git would commit (scripts/check-public.sh)
#   pins         every image is pinned on a digest; drift is reported
#   deps         npm ci from the lockfile; npm audit (high and above fails)
#   lint         eslint, zero warnings
#   unused       knip: no unused files, exports or dependencies (knip.jsonc)
#   typecheck    tsc for shared/server/e2e, svelte-check for web
#   build        shared -> server -> web
#   unit         vitest unit tests; the server's, the shared code's and web/src/lib's with a coverage floor
#   integration  server against a throwaway sshd, with a coverage floor
#   e2e          Playwright, desktop and phone, against the built image
#   image        advisories in the built image (trivy): high or critical with a fix fail; no setuid files
#   webcoverage  the web app's lines the e2e tests run, with a floor
#   controls     every control the tests look at is pressed by one (or listed why not)
#   routes       every API route used successfully by some test (or excepted,
#                with a reason, in server/test/route-exceptions.json)
#   go           the app's WireGuard (android/wg): gofmt, vet, tests against a
#                throwaway WireGuard server with a coverage floor, govulncheck (advisories in code it calls)
#   backup       backup, verify, wrong key refused; the backup image scanned as the image step scans
#   versions     workspace versions agree; CHANGELOG has the version
#   leftovers    the run left nothing behind: no test container, no volume
#                and no untagged image of its own that was not there before
#
# RESUME=1 (make gate RESUME=1) goes on from the run before: a step whose
# inputs did not change since it passed there is not run again (REUSED), and
# e2e runs again only the specs that failed or changed (with the setup), on
# top of what the run before pressed, saw and covered - unless one of them
# needs the state of a whole run (the tour, the sizes, press*), then all.
# What a run leaves for that is kept in .gate/.
#
# Three outcomes per step: PASS, FAIL, or PASS with a line starting with
# "NOTE:" - seen and worth knowing, but no reason to block the push. Without
# that middle ground every observation must either block or be silenced, and
# a gate that blocks by habit teaches you to type --no-verify.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NODE="bash scripts/node.sh"
declare -a STEPS RESULTS
LOGDIR="$(mktemp -d)"
STATE=.gate
mkdir -p "$STATE"
# The contents of these paths (tracked and new files), as one hash.
fingerprint() { git ls-files -co --exclude-standard -- "$@" | sort | xargs -r sha256sum 2>/dev/null | sha256sum | cut -c1-16; }
# A step's inputs, for RESUME (empty: always run).
inputs_of() {
  case "$1" in
    # All a step reads: its runner (node.sh, the image pins and the
    # invocation in this script), not only the code under test (AUDIT2 OPS-06).
    integration) fingerprint server shared scripts/test-integration.sh scripts/docker-lib.sh scripts/node.sh scripts/gate.sh package-lock.json ;;
    go) fingerprint android/wg android/test/wg-server.sh scripts/gate.sh ;;
    # The round trip runs the app image e2e built: its inputs count too.
    backup) fingerprint .trivyignore.yaml scripts/backup Dockerfile.backup scripts/test-backup.sh scripts/reset.sh scripts/docker-lib.sh scripts/gate.sh server shared web Dockerfile compose.yaml package-lock.json ;;
    *) echo "" ;;
  esac
}

# What was there before the run: a run that leaves volumes or images behind
# filled the disk (1691 volumes and 88 images in two weeks).
# The caches a step makes on its first run (npm, Trivy) are dangling between
# runs by design: not a leak (AUDIT2 OPS-04).
dangling_volumes() { docker volume ls -qf dangling=true | grep -vE '^(burrow-npm-cache-[0-9]+|burrow_trivy-cache)$' | sort; }
# Untagged images built from this repository's Dockerfiles (LABEL burrow.image).
dangling_ours() { docker images -qf dangling=true -f label=burrow.image --no-trunc | sort -u; }
dangling_volumes > "$LOGDIR/volumes-before.txt"
dangling_ours > "$LOGDIR/images-before.txt"
# The volumes of this run's own test containers (label burrow.ignore=true),
# noted as each is made: other projects' tests on this machine leave their
# own (a Postgres's data), not this run's leak to report or remove.
: > "$LOGDIR/volumes-ours.txt"
(
  docker events --filter type=container --filter event=create --filter label=burrow.ignore=true --format '{{.Actor.ID}}' 2>/dev/null |
    while read -r id; do docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' "$id" 2>/dev/null >> "$LOGDIR/volumes-ours.txt"; done
) &
EVENTS_PID=$!
stop_events() { pkill -P "$EVENTS_PID" 2>/dev/null; kill "$EVENTS_PID" 2>/dev/null; true; }
trap stop_events EXIT

declare -a DURS
# The cheap steps (up to unit, a few minutes) failing stops the gate before
# the expensive ones (an hour): a type error found at minute three no longer
# waits for the whole e2e run. FULL=1 runs every step regardless.
CHEAP_FAILED=0
run_step() {
  local name="$1"; shift
  echo; echo "==> $name"
  local log="$LOGDIR/$name.log"
  if [ "$CHEAP_FAILED" = 1 ] && [ -z "${FULL:-}" ]; then
    STEPS+=("$name"); RESULTS+=("SKIP"); DURS+=("-"); echo "    SKIP (a cheap step failed; FULL=1 runs it anyway)"
    return
  fi
  local fp
  fp="$(inputs_of "$name")"
  if [ -n "${RESUME:-}" ] && [ -n "$fp" ] && [ "$(cat "$STATE/$name" 2>/dev/null)" = "$fp" ]; then
    STEPS+=("$name"); RESULTS+=("REUSED"); DURS+=("-"); echo "    REUSED (inputs as when it passed)"
    return
  fi
  rm -f "$STATE/$name"
  local t0=$SECONDS
  local rc=0
  "$@" >"$log" 2>&1 || rc=$?
  [ $rc -eq 0 ] && [ -n "$fp" ] && echo "$fp" > "$STATE/$name"
  DURS+=("$(( (SECONDS - t0) / 60 ))m$(( (SECONDS - t0) % 60 ))s")
  if [ $rc -eq 0 ]; then
    if grep -q '^NOTE:' "$log"; then
      STEPS+=("$name"); RESULTS+=("NOTE")
      echo "    PASS, with notes:"; grep '^NOTE:' "$log" | sed 's/^/    | /'
    else
      STEPS+=("$name"); RESULTS+=("PASS"); echo "    PASS"
    fi
  else
    STEPS+=("$name"); RESULTS+=("FAIL")
    echo "    FAIL - last 25 lines ($log):"; tail -25 "$log" | sed 's/^/    | /'
  fi
}

check_compose() {
  # Valid, and the hardening users run with still there (A3-OPS-20).
  bash scripts/check-compose.sh &&
    # Tests build their own images: burrow:local and burrow-backup:local are
    # the live instance's tags. A test build under the first looked to a
    # self-update as already built; under the second it took the tag from
    # the running backup service's image.
    if grep -nE 'burrow(-backup)?:local' scripts/e2e.sh scripts/android-test.sh scripts/test-backup.sh scripts/test-integration.sh; then
      echo "tests must build burrow:e2e / burrow-backup:e2e, not the live tags burrow:local / burrow-backup:local" >&2
      false
    fi
}

# Every image the repository pins (scripts/image-refs.sh, shared with scripts/repin.sh).
source "$ROOT/scripts/image-refs.sh"

# NOT PINNED blocks: from then on a re-published tag could silently build
# something else. DRIFTED only notes: upstream rebuilt (usually security
# fixes); updating is maintenance, not a defect in this push. Offline is not
# a failure either.
check_pins() {
  local refs bad=0 ref tag pinned current
  refs="$(image_refs)"
  [ -n "$refs" ] || { echo "no images found"; return 1; }
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    if [ "${ref#*@}" = "$ref" ]; then echo "$ref: NOT pinned on a digest"; bad=1; continue; fi
    tag="${ref%@*}"; pinned="${ref#*@}"
    if current="$(timeout 60 docker buildx imagetools inspect "$tag" --format '{{.Manifest.Digest}}' 2>&1)"; then
      [ "$current" = "$pinned" ] || echo "NOTE: $tag has moved upstream (pinned ${pinned:7:12}, now ${current:7:12})"
    else
      case "$current" in *429*|*toomanyrequests*) echo "NOTE: $tag NOT checked - registry rate limit (429)";; esac
    fi
  done <<< "$refs"
  # The F-Droid draft builds with the app's own toolchain (A3-OPS-13).
  bash scripts/fdroid-check.sh || bad=1
  # Renovate sees every pin it is meant to (it does not run here yet; A3-OPS-12).
  $NODE node scripts/renovate-check.mjs || bad=1
  # The CI's actions on a reviewed commit, not a tag that can move (AUDIT2 OPS-14).
  local loose
  loose="$(grep -nE '^\s*-?\s*uses: ' .github/workflows/*.yml | grep -vE '@[0-9a-f]{40}( |$)' || true)"
  [ -z "$loose" ] || { echo "actions NOT pinned on a commit:"; echo "$loose"; bad=1; }
  # The dev wrapper and the image must build with the same Node.
  local a b
  a="$(grep -oE 'node:[^"]+' scripts/node.sh | head -1)"
  b="$(grep -oE '^FROM node:[^ ]+' Dockerfile | head -1 | cut -d' ' -f2)"
  [ "$a" = "$b" ] || { echo "scripts/node.sh ($a) and Dockerfile ($b) use different Node images"; bad=1; }
  # The Gradle wrapper and the build image fetch the same Gradle, checked by
  # the same checksum: the wrapper kept 8.11.1's for 9.8.0 (audit AN-02).
  local wv ws dv ds
  wv="$(grep -oE 'gradle-[0-9.]+-bin' android/gradle/wrapper/gradle-wrapper.properties | sed 's/gradle-//;s/-bin//')"
  ws="$(grep -oE 'distributionSha256Sum=[0-9a-f]+' android/gradle/wrapper/gradle-wrapper.properties | cut -d= -f2)"
  dv="$(grep -oE '^ARG GRADLE_VERSION=[0-9.]+' android/Dockerfile | cut -d= -f2)"
  ds="$(grep -oE '^ARG GRADLE_SHA256=[0-9a-f]+' android/Dockerfile | cut -d= -f2)"
  [ -n "$wv" ] && [ "$wv" = "$dv" ] && [ "$ws" = "$ds" ] || { echo "Gradle wrapper ($wv ${ws:0:12}) and android/Dockerfile ($dv ${ds:0:12}) differ"; bad=1; }
  return $bad
}

check_deps() {
  $NODE npm ci --no-fund --no-audit || return 1
  # An install script nobody reviewed fails an install (.npmrc, A3-OPS-06).
  bash scripts/test-install-scripts.sh || return 1
  $NODE node scripts/audit-check.mjs
}

check_typecheck() {
  $NODE npm run build -w @burrow/shared &&
    $NODE npm run typecheck &&
    $NODE npx tsc -p e2e/tsconfig.json
}

TRIVY_IMAGE="aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa"
# Advisories in the image the e2e step built (Debian packages, the Node
# modules in it): high or critical ones that have a fix fail, unless
# .trivyignore.yaml names them with why and until when.
scan_image() {
  docker volume create burrow_trivy-cache >/dev/null
  docker run --rm --label burrow.ignore=true -v /var/run/docker.sock:/var/run/docker.sock:ro -v burrow_trivy-cache:/root/.cache \
    -v "$ROOT/.trivyignore.yaml":/ignore.yaml:ro "$TRIVY_IMAGE" image --quiet --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed \
    --ignorefile /ignore.yaml --exit-code 1 --format table "$1"
}
check_image() {
  docker image inspect burrow:e2e >/dev/null 2>&1 || { echo "no burrow:e2e image (the e2e step builds it)"; return 1; }
  # No setuid or setgid file: harmless under compose's no-new-privileges,
  # not under a plain docker run without it (A3-OPS-10).
  local suid
  suid="$(docker run --rm --label burrow.ignore=true --user 0:0 --entrypoint find burrow:e2e / -xdev -perm /6000 -type f 2>/dev/null)"
  [ -z "$suid" ] || { echo "setuid/setgid files in the image:"; echo "$suid"; return 1; }
  scan_image burrow:e2e
}

GO_IMAGE="golang:1.27-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea"
check_go() {
  local gw conf rc
  gw="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')"
  conf="$(bash android/test/wg-server.sh up "$gw")" || return 1
  docker run --rm --label burrow.ignore=true -u "$(id -u):$(id -g)" -e HOME=/tmp -e GOPATH=/tmp/go -e GOFLAGS=-modcacherw -e WG_TEST_CONF="$conf" \
    -v "$ROOT/android/wg":/src -w /src "$GO_IMAGE" sh -c 'test -z "$(gofmt -l .)" || { gofmt -l .; exit 1; }; go vet ./... && { go test -count=1 -cover ./... > /tmp/go-test.out; rc=$?; cat /tmp/go-test.out; [ $rc = 0 ]; } &&
      cov="$(sed -n "s/.*coverage: \([0-9]*\)\.[0-9]*% of statements.*/\1/p" /tmp/go-test.out)" && echo "Go statement coverage ${cov}% (floor 94%)" && [ "${cov:-0}" -ge 94 ] &&
      go run golang.org/x/vuln/cmd/govulncheck@v1.8.0 ./...'
  rc=$?
  bash android/test/wg-server.sh down
  return $rc
}

check_versions() {
  local v bad=0 f
  v="$($NODE node -p "require('./package.json').version")"
  for f in shared server web e2e; do
    local w; w="$($NODE node -p "require('./$f/package.json').version")"
    [ "$w" = "$v" ] || { echo "$f/package.json is $w, root is $v"; bad=1; }
  done
  # What server and web ask of shared (npm looks a wrong one up in the registry).
  for f in server web; do
    local d; d="$($NODE node -p "require('./$f/package.json').dependencies['@burrow/shared']")"
    [ "$d" = "$v" ] || { echo "$f asks for @burrow/shared $d, root is $v"; bad=1; }
  done
  grep -qE "^## \[$v\]" CHANGELOG.md || { echo "CHANGELOG.md has no section for $v"; bad=1; }
  # Its Verified part written (scripts/bump-version.sh leaves a line to replace).
  awk -v v="$v" 'index($0, "## [" v "]") == 1 { s = 1; next } s && /^## \[/ { exit } s && /^### Verified/ { ok = 1 } s && /\(how this release was tested\)/ { todo = 1 } END { exit !(ok && !todo) }' CHANGELOG.md \
    || { echo "CHANGELOG.md: the section for $v has no Verified part written"; bad=1; }
  # The Android version code as the app's build computes it, for F-Droid's update check (AUDIT2 DOC-10).
  local code; code="$(echo "$v" | awk -F. '{print $1*10000 + $2*100 + $3}')"
  [ "$(tr -d '[:space:]' < android/version-code.txt 2>/dev/null)" = "$code" ] || { echo "android/version-code.txt is not $code (the code of $v)"; bad=1; }
  # The app's "What's new" for this version, both languages, within F-Droid's 500 characters.
  for f in android/fastlane/metadata/android/{en-US,nl-NL}/changelogs/"$code".txt; do
    if [ ! -s "$f" ]; then echo "$f is missing or empty (What's new in the app)"; bad=1
    elif [ "$(wc -m < "$f")" -gt 500 ]; then echo "$f is longer than 500 characters"; bad=1; fi
  done
  # The F-Droid draft names the latest release (scripts/bump-version.sh writes
  # it); it named 1.1.0 for many releases unnoticed.
  local fd=docs/fdroid/io.github.r31l4nd.burrow.yml
  { grep -q "^CurrentVersion: $v\$" "$fd" && grep -q "^CurrentVersionCode: $code\$" "$fd" && grep -qE "^ *commit: v$v\$" "$fd"; } 2>/dev/null \
    || { echo "$fd does not name $v ($code)"; bad=1; }
  # Every package in the lock is the version its tarball is: a version bump
  # by hand once wrote 1.0.0 over seven of them (AUDIT OP-01).
  $NODE node -e '
    const l = require("./package-lock.json");
    const bad = Object.entries(l.packages).filter(([k, p]) => {
      const m = k.includes("node_modules/") && p.resolved && /\/-\/(.+)\.tgz$/.exec(p.resolved);
      return m && m[1] !== `${k.split("/").pop()}-${p.version}`;
    });
    for (const [k, p] of bad) console.log(`package-lock.json: ${k} says ${p.version}, its tarball is ${p.resolved.split("/").pop()}`);
    process.exit(bad.length ? 1 : 0);
  ' || bad=1
  return $bad
}

# Nothing private in what git would commit (secrets, keys, your own names
# from deploy/local/private-patterns.txt when you have one): found at the
# push, not after it. Seconds.
check_public() {
  local t rc
  t="$(mktemp -d)"
  git ls-files -co --exclude-standard -z | while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done | tar --null -T - -cf - | tar -xf - -C "$t"
  bash scripts/check-public.sh "$t"
  rc=$?
  rm -rf "$t"
  return $rc
}

run_step compose     check_compose
run_step public      check_public
run_step pins        check_pins
run_step deps        check_deps
run_step lint        $NODE npx eslint . --max-warnings 0
run_step unused      $NODE npx knip --no-progress
run_step typecheck   check_typecheck
# The page's first download stays small: CodeMirror, xterm and the QR code
# writer load with what uses them (its main bundle went from 1.9 MB to
# 472 KB, #149). Lower this as it shrinks, never raise it for a change.
BUNDLE_MAX_KB=500
check_build() {
  $NODE npm run build || return 1
  local f kb
  f="$(ls web/dist/assets/index-*.js | head -1)"
  kb=$(( $(stat -c %s "$f") / 1024 ))
  echo "main bundle: ${kb} KB (at most ${BUNDLE_MAX_KB})"
  [ "$kb" -le "$BUNDLE_MAX_KB" ]
}
run_step build       check_build
# The server's tests keep a floor under how much of it they run (lines):
# raise it when coverage grows, never lower it to make a change pass.
COVERAGE_UNIT=67
COVERAGE_INTEGRATION=81
# The shared package's own tests (types, schemas, the logic both sides use).
COVERAGE_SHARED=98
# The web app's lines the e2e tests run (scripts/web-coverage.mjs).
COVERAGE_WEB=96
# The web app's own logic (web/src/lib) as its unit tests run it: the router,
# the api client, the terminal's pool and completion, uploads, the app bridge.
COVERAGE_WEB_UNIT=82
check_unit() {
  $NODE npm run test -w @burrow/shared -- --coverage --coverage.include='src/**' --coverage.exclude='src/**/*.test.ts' --coverage.reporter=text-summary --coverage.reportsDirectory=coverage/shared --coverage.thresholds.lines="$COVERAGE_SHARED" &&
    $NODE npm run test -w @burrow/web -- --coverage --coverage.include='src/lib/**' --coverage.exclude='src/**/*.test.ts' --coverage.exclude='src/**/*.json' --coverage.reporter=text-summary --coverage.reportsDirectory=coverage/web --coverage.thresholds.lines="$COVERAGE_WEB_UNIT" &&
    NODE_ENV_FILE="$ROUTE_ENV" $NODE npm run test -w @burrow/server -- --coverage --coverage.include='src/**' --coverage.reporter=text-summary --coverage.reporter=json-summary --coverage.reportsDirectory=coverage/unit --coverage.thresholds.lines="$COVERAGE_UNIT"
}
# Fresh counts of the routes used (scripts/route-coverage.mjs): the server's
# unit tests, the integration tests and e2e each add the routes they used.
[ -n "${RESUME:-}" ] || rm -f coverage/route-hits.txt coverage/routes-all.txt
mkdir -p coverage
ROUTE_ENV="$LOGDIR/route.env"
echo BURROW_ROUTE_LOG=/app/coverage/route-hits.txt > "$ROUTE_ENV"
run_step unit        check_unit
# Only a cheap step's failure skips the rest; a failed e2e still lets the others report.
printf '%s\n' "${RESULTS[@]}" | grep -qx FAIL && CHEAP_FAILED=1
run_step integration bash scripts/test-integration.sh --coverage --coverage.include='src/**' --coverage.reporter=text-summary --coverage.reporter=json-summary --coverage.reportsDirectory=coverage/integration --coverage.thresholds.lines="$COVERAGE_INTEGRATION"
# A test that fails once and passes on its retry does not fail the gate: it
# is named as a NOTE, to be made steady, instead of costing a whole run.
# The spec files a run failed in, and each spec file's hash: what a resume runs again.
# Playwright's summary lists them under "N failed", before "N flaky" or "N passed".
e2e_failed() { sed 's/\x1b\[[0-9;]*m//g' "$LOGDIR/e2e.log" | awk '/^ +[0-9]+ failed$/ { on = 1; next } /^ +[0-9]+ [a-z ]+(\(|$)/ { on = 0 } on' | grep -oE 'tests/[a-z0-9.-]+\.spec\.ts' | sort -u; }
app_inputs() { fingerprint web server shared Dockerfile package-lock.json e2e/playwright.config.ts; }
spec_hashes() { (cd e2e && sha256sum tests/*.spec.ts) | sort -k2; }
# What every spec leans on: the helpers, fixtures and fake servers, and the scripts that run them (AUDIT2 OPS-06).
e2e_helpers() { fingerprint e2e ':!e2e/tests/*.spec.ts' scripts/e2e.sh scripts/node.sh scripts/docker-lib.sh scripts/gate.sh; }
# Which of the specs a resume may run alone: those that need only the setup
# and the test host (not the tour, the sizes or press*, which look at what a
# whole run made).
# browsers.spec.ts runs in the Firefox and WebKit projects only, which a
# resume does not start: changed or failed, it needs the whole run (AUDIT2 OPS-05).
alone() { case "$1" in tests/workspace-tour.spec.ts | tests/workspace-sizes.spec.ts | tests/press-*.spec.ts | tests/seen.spec.ts | tests/replay.spec.ts | tests/browsers.spec.ts) return 1 ;; esac; }
# The desktop project's specs, in the order it runs them (by file name).
desktop_specs() { (cd e2e && ls tests/*.spec.ts) | grep -E '^tests/(hosts|terminal[a-z-]*|workspace[a-z-]*)\.spec\.ts$' | grep -vE '^tests/workspace-(tour|sizes)\.spec\.ts$' | LC_ALL=C sort; }
# A desktop spec uses what the ones before it made: those run again with it
# (#145: alone it failed on a host or channel an earlier spec makes).
with_earlier() {
  local last="" f
  for f in "$@"; do desktop_specs | grep -qx "$f" && { [ -z "$last" ] || [[ "$f" > "$last" ]]; } && last="$f"; done
  { printf '%s\n' "$@"; [ -z "$last" ] || desktop_specs | awk -v l="$last" '$0 <= l'; } | grep . | LC_ALL=C sort -u
}
check_e2e() {
  local again="" f partial="" notrun=0
  # The results must be the gate's own: a run of scripts/e2e.sh without
  # E2E_RESUME in between cleared them (and took the stamp with it).
  if [ -n "${RESUME:-}" ] && [ -f "$STATE/e2e-specs" ] && [ -d e2e/test-results/pressed ] && cmp -s e2e/test-results/.gate-stamp "$STATE/e2e-stamp" &&
    [ "$(e2e_helpers)" = "$(cat "$STATE/e2e-helpers" 2>/dev/null)" ]; then
    again="$( { cat "$STATE/e2e-failed" 2>/dev/null; diff <(spec_hashes) "$STATE/e2e-specs" | grep '^<' | awk '{print $3}'; } | sort -u)"
    partial=1
    for f in $again; do alone "$f" || partial=""; done
    # shellcheck disable=SC2086
    [ -z "$partial" ] || again="$(with_earlier $again)"
    # Tests that did not run (a failure in desktop stops the projects after
    # it) are not in the coverage, the presses or the pages seen: all again.
    notrun="$(cat "$STATE/e2e-notrun" 2>/dev/null || echo 0)"
    [ "$notrun" = 0 ] || partial=""
    if [ -z "$again" ] && [ "$notrun" = 0 ]; then
      # Nothing failed and no spec changed: all of it again only if the app did.
      [ "$(app_inputs)" = "$(cat "$STATE/e2e-app" 2>/dev/null)" ] && { echo "nothing failed or changed since the last run"; return 0; }
      partial=""
    fi
  fi
  if [ -n "$partial" ]; then
    echo "NOTE: resumed: e2e ran again only $(echo "$again" | wc -w) spec(s), the rest as in the run before: $(echo $again)"
    # shellcheck disable=SC2086
    E2E_RESUME=1 E2E_RETRIES=1 bash scripts/e2e.sh --no-deps --project=setup --project=desktop --project=mobile tests/setup.spec.ts tests/hosts.spec.ts $again
  else
    E2E_RETRIES=1 bash scripts/e2e.sh
  fi
  local rc=$?
  e2e_failed > "$STATE/e2e-failed"
  # A resumed run keeps the count of the run it resumed (its own skips nothing).
  [ -n "$partial" ] || { sed 's/\x1b\[[0-9;]*m//g' "$LOGDIR/e2e.log" | grep -oE '^ +[0-9]+ did not run' | grep -oE '[0-9]+' || echo 0; } | tail -1 > "$STATE/e2e-notrun"
  spec_hashes > "$STATE/e2e-specs"
  app_inputs > "$STATE/e2e-app"
  e2e_helpers > "$STATE/e2e-helpers"
  date +%s%N | tee "$STATE/e2e-stamp" > e2e/test-results/.gate-stamp 2>/dev/null || true
  [ $rc -eq 0 ] || return 1
  local flaky
  flaky="$(sed 's/\x1b\[[0-9;]*m//g' "$LOGDIR/e2e.log" | grep -A40 -E '^ +[0-9]+ flaky$' | grep -E '^ +\[' | sed 's/^ *//' || true)"
  [ -z "$flaky" ] || echo "$flaky" | sed 's/^/NOTE: flaky (passed on its retry): /'
}
run_step e2e         check_e2e
run_step image       check_image
run_step webcoverage $NODE node scripts/web-coverage.mjs "$COVERAGE_WEB"
# The controls still to press as main has them: the list may not grow (AUDIT2 OPS-20).
check_controls() {
  local base
  rm -f e2e/test-results/controls-todo-main.json
  if base="$(git merge-base HEAD main 2>/dev/null)"; then git show "$base:e2e/controls-todo.json" > e2e/test-results/controls-todo-main.json 2>/dev/null || rm -f e2e/test-results/controls-todo-main.json; fi
  $NODE node scripts/controls-check.mjs
}
run_step controls    check_controls
run_step routes      $NODE node scripts/route-coverage.mjs
run_step go          check_go
# The backup image is released too: scanned as the application's is (AUDIT OP-09).
check_backup() { env SKIP_BUILD=1 bash scripts/test-backup.sh && scan_image burrow-backup:e2e; }
run_step backup      check_backup
run_step versions    check_versions

check_leftovers() {
  local bad=0 c
  c="$(docker ps -a --filter label=burrow.ignore=true --format '{{.Names}}' | grep -vE '^burrow-android-build' || true)"
  [ -z "$c" ] || { echo "test containers still there:"; echo "$c"; bad=1; }
  # New since the start, and made by one of this run's containers.
  c="$(comm -13 "$LOGDIR/volumes-before.txt" <(dangling_volumes) | comm -12 - <(grep -v '^$' "$LOGDIR/volumes-ours.txt" | sort -u))"
  [ -z "$c" ] || { echo "volumes left behind ($(echo "$c" | wc -l)); a container removed without -v?"; echo "$c" | head -20; bad=1; }
  c="$(comm -13 "$LOGDIR/images-before.txt" <(dangling_ours))"
  [ -z "$c" ] || { echo "untagged images left behind (build with rebuild, scripts/docker-lib.sh):"; echo "$c"; bad=1; }
  return $bad
}
run_step leftovers   check_leftovers
# Every run builds the image again: the build cache kept to its newest 40 GB
# (it had grown to 290 GB). Only cache; the next build fills what it needs.
docker builder prune -f --keep-storage 40GB >/dev/null 2>&1 || true

echo; echo "==================== gate ===================="
fail=0
for i in "${!STEPS[@]}"; do
  printf '  %-12s %-5s %s\n' "${STEPS[$i]}" "${RESULTS[$i]}" "${DURS[$i]:-}"
  case "${RESULTS[$i]}" in FAIL | SKIP) fail=1 ;; esac
done
echo "  total: $(( SECONDS / 60 ))m"

echo "  logs: $LOGDIR"
[ $fail -eq 0 ] && echo "  GATE PASSED" || echo "  GATE FAILED"
exit $fail
