#!/usr/bin/env bash
# scripts/android-test.sh - the Android app on an API 35 emulator against a
# real Burrow: the test container behind a TLS proxy at
# https://10.0.2.2:8443 (the emulator's name for this machine), the test
# sshd, and a fake web app for the app tabs. Runs the instrumented tests in
# android/app/src/androidTest. Needs /dev/kvm. Everything is removed after.
#
#   bash scripts/android-test.sh            # builds burrow:e2e first
#   SKIP_BUILD=1 bash scripts/android-test.sh
#   KEEP=1 bash scripts/android-test.sh     # leave everything running (debugging)
#   ONLY=PhoneFilesTest bash scripts/android-test.sh   # one class or Class#method (comma list), paired first as needed
#   ALL_FILES=1 bash scripts/android-test.sh   # also "All files" read for real (the emulator crashes there at times)
#   PASSES="tablet dark-nl tablet-dark-nl"  # the passes after the phone's (default: tablet dark-nl; "" none)
#
# Beside another run on this machine (names, ports, limits; defaults as before):
#   ANDROID_TEST_PREFIX=burrow-droid  TLS_PORT=8443 APP_PORT=8099 SSHD_PORT=2222 WG_PORT=51899
#   EMU_CPUS= EMU_MEMORY= (docker limits)  EMU_SCRATCH= (a host folder instead of its own volume)
#   GRADLE_VOLUME=burrow_android-gradle  TEST_IMAGE=burrow:e2e  SKIP_ANDROID_IMAGE=1 (use the build image as it is)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/docker-lib.sh
. "$ROOT/scripts/docker-lib.sh"
need openssl
cd "$ROOT"
# Made here, as this user: compose mounts ./artifacts, and a missing one is made by Docker as root.
mkdir -p artifacts

[ -e /dev/kvm ] || { echo "/dev/kvm missing: the emulator needs hardware virtualisation"; exit 1; }

PREFIX="${ANDROID_TEST_PREFIX:-burrow-droid}"
NET="$PREFIX"
APP="$PREFIX-app"
SSHD="$PREFIX-sshd"
PROXY="$PREFIX-tls"
FAKE="$PREFIX-fakeapp"
EMU="$PREFIX-emulator"
TLS_PORT="${TLS_PORT:-8443}"
APP_PORT="${APP_PORT:-8099}"
SSHD_PORT="${SSHD_PORT:-2222}"
export WG_PORT="${WG_PORT:-51899}"
# The tunnel's throwaway server (android/test/wg-server.sh): the gate's name unless a prefix is given.
if [ -n "${ANDROID_TEST_PREFIX:-}" ]; then export WG_NAME="$PREFIX-wg"; fi
GRADLE_VOLUME="${GRADLE_VOLUME:-burrow_android-gradle}"
TEST_IMAGE="${TEST_IMAGE:-burrow:e2e}"
NODE_IMAGE="$(grep -oE 'node:[^"]+' scripts/node.sh | head -1)"
ORIGIN="https://10.0.2.2:$TLS_PORT"
APP_URL="http://10.0.2.2:$APP_PORT/"
CA_DIR=android/app/build/test-ca

containers() {
  docker rm -fv "$APP" "$SSHD" "$PROXY" "$FAKE" "$EMU" "${WG_NAME:-burrow-wg-server}" >/dev/null 2>&1 || true
  docker volume rm "$EMU-scratch" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
containers
WORK="$(mktemp -d)"
trap '[ -n "${KEEP:-}" ] || containers; rm -rf "$WORK"; git worktree prune' EXIT

echo "-> Throwaway CA and certificate for 10.0.2.2"
mkdir -p "$CA_DIR"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Burrow device test CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" \
  -keyout "$WORK/ca.key" -out "$CA_DIR/ca.pem" 2>"$WORK/openssl.log" || { cat "$WORK/openssl.log"; exit 1; }
openssl req -newkey rsa:2048 -nodes -subj "/CN=10.0.2.2" -keyout "$WORK/tls.key" -out "$WORK/tls.csr" 2>/dev/null
printf 'subjectAltName=IP:10.0.2.2,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' > "$WORK/ext"
openssl x509 -req -in "$WORK/tls.csr" -CA "$CA_DIR/ca.pem" -CAkey "$WORK/ca.key" -CAcreateserial -days 2 -extfile "$WORK/ext" -out "$WORK/tls.pem" 2>/dev/null
chmod 644 "$WORK"/*

echo "-> The app's own unit tests and lint, then debug and test APKs (trusting that CA), with the direct route's page"
bash scripts/direct-assets.sh
# Burrow's words, for the test to find its buttons in the pass's language.
mkdir -p android/app/build/test-i18n/i18n && cp web/src/lib/i18n/en.json web/src/lib/i18n/nl.json android/app/build/test-i18n/i18n/
# The build image through compose, without any .env: the image takes nothing
# from it, and a fresh worktree has none (compose refused for lack of
# BURROW_ORIGIN, which only the server's service needs; W-FUNC-16).
[ -n "${SKIP_ANDROID_IMAGE:-}" ] || BURROW_ORIGIN=https://burrow.invalid docker compose --env-file /dev/null --profile build build -q android-build
# The build image straight (not compose run): no .env.build needed, the signing key's password has no business here.
docker run --rm --label burrow.ignore=true --name "$PREFIX-build" --user "$(id -u):$(id -g)" -v "$ROOT/android":/project -v "$GRADLE_VOLUME":/gradle \
  -e BURROW_TEST_CA=/project/app/build/test-ca/ca.pem -e BURROW_VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json | head -1)" \
  burrow-android-build:local sh -lc 'gradle --no-daemon -q testDebugUnitTest checkUnitTestCoverage lintDebug assembleDebug assembleDebugAndroidTest'

# The release before this one, built from git: the app a person updates
# from (UPGRADE=0 skips it, ONLY too). The same debug key (in the gradle volume), so
# the new one installs over it as an update.
OLD_VERSION=""
if [ "${UPGRADE:-1}" != 0 ] && [ -z "${ONLY:-}" ]; then
  CUR="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json | head -1)"
  for c in $(git log --format=%H -- package.json); do
    v="$(git show "$c:package.json" | sed -n 's/^  "version": "\(.*\)",$/\1/p' | head -1)"
    if [ "$v" != "$CUR" ]; then OLD_REF="$c"; OLD_VERSION="$v"; break; fi
  done
  # Only an app of the same id updates: none in a history that starts here,
  # none across the rename to io.github.r31l4nd.burrow (2.20.3).
  appid() { sed -n 's/^ *applicationId = "\(.*\)"/\1/p' | head -1; }
  if [ -n "$OLD_VERSION" ] && [ "$(git show "$OLD_REF:android/app/build.gradle.kts" 2>/dev/null | appid)" != "$(appid < android/app/build.gradle.kts)" ]; then
    echo "-> The release before this one ($OLD_VERSION) is an app of another id: no update from it to test"
    OLD_VERSION=""
  elif [ -z "$OLD_VERSION" ]; then
    echo "-> No release before this one in the history: no update to test"
  fi
fi
if [ -n "$OLD_VERSION" ]; then
  echo "-> The release before this one ($OLD_VERSION, ${OLD_REF:0:7}), to update from"
  git worktree add -q --detach "$WORK/old" "$OLD_REF"
  mkdir -p "$WORK/old/android/app/build/test-ca" "$WORK/old/android/app/src/main/assets"
  cp "$CA_DIR/ca.pem" "$WORK/old/android/app/build/test-ca/"
  cp -r android/app/src/main/assets/direct "$WORK/old/android/app/src/main/assets/"
  # Its own test's words (from 2.0.0 on its test finds buttons by them), as the release had them.
  mkdir -p "$WORK/old/android/app/build/test-i18n/i18n"
  cp "$WORK"/old/web/src/lib/i18n/*.json "$WORK/old/android/app/build/test-i18n/i18n/" 2>/dev/null || true
  docker run --rm --label burrow.ignore=true --name "$PREFIX-build" --user "$(id -u):$(id -g)" -v "$WORK/old/android":/project -v "$GRADLE_VOLUME":/gradle \
    -e BURROW_TEST_CA=/project/app/build/test-ca/ca.pem -e BURROW_VERSION="$OLD_VERSION" \
    burrow-android-build:local sh -lc 'gradle --no-daemon -q assembleDebug assembleDebugAndroidTest'
fi

echo "-> Emulator image and boot"
rebuild burrow-android-emulator:local -f android/test/Dockerfile.emulator android/test
# The emulator's disks on a volume of its own (on disk), made new each run: on a tmpfs the
# emulator crashed (exit 139) three runs in a row at the same test, with room to spare.
SCRATCH=(-v "$EMU-scratch":/scratch)
[ -z "${EMU_SCRATCH:-}" ] || { mkdir -p "$EMU_SCRATCH" && chmod 777 "$EMU_SCRATCH" && SCRATCH=(-v "$EMU_SCRATCH":/scratch); }
LIMITS=()
[ -z "${EMU_CPUS:-}" ] || LIMITS+=(--cpus "$EMU_CPUS")
[ -z "${EMU_MEMORY:-}" ] || LIMITS+=(--memory "$EMU_MEMORY")
docker run -d --label burrow.ignore=true --name "$EMU" --device /dev/kvm --network host "${SCRATCH[@]}" "${LIMITS[@]}" burrow-android-emulator:local >/dev/null

echo "-> Burrow, sshd, TLS proxy, fake app"
[ -n "${SKIP_BUILD:-}" ] || rebuild "$TEST_IMAGE" .
rebuild burrow-test-sshd server/test/sshd
docker network create "$NET" >/dev/null
# The host is published on the network's gateway address: one of this
# machine's own addresses, so Burrow (in the network) and the emulator
# (NAT through this machine) reach it at the same address, like a LAN host.
GW="$(docker network inspect "$NET" -f '{{(index .IPAM.Config 0).Gateway}}')"
docker run -d --label burrow.ignore=true --name "$SSHD" --network "$NET" -p "$GW:$SSHD_PORT:22" burrow-test-sshd >/dev/null
docker run -d --label burrow.ignore=true --name "$APP" --network "$NET" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -e BURROW_ORIGIN="$ORIGIN" -e STATUS_INTERVAL_SECONDS=5 -e BURROW_IGNORE_LABEL=burrow.test-ignore "$TEST_IMAGE" >/dev/null
docker run -d --label burrow.ignore=true --name "$PROXY" --network "$NET" -p "127.0.0.1:$TLS_PORT:8443" --user "$(id -u):$(id -g)" \
  -v "$ROOT/android/test":/t:ro -v "$WORK":/w:ro "$NODE_IMAGE" node /t/tls-proxy.mjs /w/tls.pem /w/tls.key 8443 "$APP:8080" >/dev/null
docker run -d --label burrow.ignore=true --name "$FAKE" -p "127.0.0.1:$APP_PORT:$APP_PORT" --user "$(id -u):$(id -g)" -v "$ROOT/android/test":/t:ro "$NODE_IMAGE" node /t/fake-app.mjs "$APP_PORT" >/dev/null

TOKEN=""
for _ in $(seq 1 50); do
  TOKEN="$(docker logs "$APP" 2>&1 | grep -oE '^ +[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$' | tr -d ' ' | tail -1 || true)"
  [ -n "$TOKEN" ] && break
  sleep 0.2
done
[ -n "$TOKEN" ] || { echo "no setup token"; docker logs "$APP"; exit 1; }

adb() { docker exec "$EMU" adb "$@"; }
echo "-> Waiting for the emulator"
adb wait-for-device
# The whole log from boot on, kept here: when the emulator dies, its last lines are still at hand.
mkdir -p artifacts && docker exec "$EMU" adb logcat -v time > artifacts/android-logcat.txt 2>&1 &
for _ in $(seq 1 150); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ] && break
  sleep 2
done
[ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ] || { echo "emulator did not boot"; docker logs --tail 50 "$EMU"; exit 1; }
# Past the emulator's own lock screen first (no PIN yet, so dismissing it
# is enough), and the screen stays on so it never comes back. Only then a
# screen lock (PIN 1234), which stands in for the fingerprint: the app lock
# and the device key both accept it on Android 11+.
adb shell svc power stayon true
adb shell settings put system screen_off_timeout 1800000
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
sleep 2
adb shell locksettings set-pin 1234 >/dev/null
for s in window_animation_scale transition_animation_scale animator_duration_scale; do adb shell settings put global "$s" 0; done
# /scratch is a tmpfs, which `docker cp` cannot write to.
docker exec -i "$EMU" sh -c 'cat > /scratch/app.apk' < android/app/build/outputs/apk/debug/app-debug.apk
docker exec -i "$EMU" sh -c 'cat > /scratch/test.apk' < android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
install_new() {
  adb install -r -g /scratch/app.apk >/dev/null
  adb install -r -g /scratch/test.apk >/dev/null
  # This version's debug APK records its coverage (enableAndroidTestCoverage); the release before does not.
  COVERAGE=1
}

echo "-> Preparing Burrow (setup, host, app, pairing code)"
printf 'NODE_EXTRA_CA_CERTS=/app/%s/ca.pem\n' "$CA_DIR" > "$WORK/node.env"
PREP="$(NODE_ENV_FILE="$WORK/node.env" bash scripts/node.sh node android/test/prepare.mjs "https://127.0.0.1:$TLS_PORT" "$ORIGIN" "$TOKEN" "$GW" "$SSHD_PORT" "$APP_URL")"
arg() { printf '%s' "$PREP" | sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\).*/\1/p"; }

# The emulator's own lock screen (keyguard) must not be in front of the
# app: dismiss it and type the PIN digit by digit (`input text` does not
# reach the PIN pad) until the focus is no longer the lock screen.
unlock_screen() {
  local focus
  for _ in $(seq 1 10); do
    focus="$(adb shell dumpsys window | grep mCurrentFocus || true)"
    case "$focus" in
      *NotificationShade*|*Keyguard*|*Bouncer*)
        adb shell input keyevent KEYCODE_WAKEUP
        adb shell wm dismiss-keyguard
        sleep 1
        for k in 1 2 3 4; do adb shell input keyevent "KEYCODE_$k"; done
        adb shell input keyevent KEYCODE_ENTER
        sleep 2 ;;
      *) return 0 ;;
    esac
  done
  echo "the emulator's lock screen stays in front: $focus"
  return 1
}

# The coverage of every run of this version, pulled after it (the next run
# writes its own): build/outputs/device-coverage/, read by the reports at the end.
COVERAGE=""
COV_DIR=android/app/build/outputs/device-coverage
COV_FILE=/data/data/io.github.r31l4nd.burrow.debug/files/coverage.ec
rm -rf "$COV_DIR" && mkdir -p "$COV_DIR"
pull_coverage() {
  [ -n "$COVERAGE" ] || return 0
  local f
  f="$COV_DIR/run-$(ls "$COV_DIR" | wc -l).ec"
  adb exec-out run-as io.github.r31l4nd.burrow.debug cat files/coverage.ec > "$f" 2>/dev/null || true
  [ -s "$f" ] || { rm -f "$f"; echo "(no coverage from this run)"; }
  adb shell run-as io.github.r31l4nd.burrow.debug rm -f files/coverage.ec >/dev/null 2>&1 || true
}

# Screenshots of every screen the tests pass (WebTestBase.screenshot), for
# a look by a person: artifacts/android-screens/.
SCREENS=artifacts/android-screens
rm -rf "$SCREENS" && mkdir -p "$SCREENS"
pull_screens() {
  adb exec-out run-as io.github.r31l4nd.burrow.debug tar -c -C files screens 2>/dev/null | tar -x -C "$SCREENS" --strip-components=1 2>/dev/null || true
}

instrument() {
  unlock_screen
  local out
  set +e
  local cov=()
  [ -z "$COVERAGE" ] || cov=(-e coverage true -e coverageFile "$COV_FILE")
  out="$(adb shell am instrument -w \
    -e origin "$ORIGIN" -e pairCode "${PAIR_CODE:-$(arg pairCode)}" -e hostId "$(arg hostId)" -e appId "$(arg appId)" -e appUrl "$APP_URL" -e totp "$(arg totp)" \
    "${cov[@]}" "$@" io.github.r31l4nd.burrow.debug.test/androidx.test.runner.AndroidJUnitRunner 2>&1)"
  set -e
  printf '%s\n' "$out"
  # The emulator itself gone (it crashed with exit 139 mid-test, saying nothing): said, with the
  # last of the log taken since boot (artifacts/android-logcat.txt), which adb no longer reaches.
  if [ "$(docker inspect -f '{{.State.Running}}' "$EMU" 2>/dev/null)" != true ]; then
    echo "the emulator stopped: exit $(docker inspect -f '{{.State.ExitCode}}' "$EMU" 2>/dev/null)"
    docker logs --tail 20 "$EMU" 2>&1 || true
    tail -400 artifacts/android-logcat.txt 2>/dev/null | grep -iE 'burrow|chromium|AndroidRuntime|TestRunner|FATAL|fuse|MediaProvider|lowmemory|kill' | tail -60 || true
    exit 1
  fi
  pull_screens
  pull_coverage
  if ! printf '%s' "$out" | grep -q '^OK ('; then
    adb logcat -d -t 300 | grep -iE 'burrow|chromium|AndroidRuntime|TestRunner' | tail -80 || true
    # Which activities came and went, and why (the launcher found in front).
    adb logcat -d -b events | grep -E 'wm_(on_|finish|destroy|set_resumed|pause|task_moved|create_activity|restart)' | tail -40 || true
    exit 1
  fi
}

# The keyboard a person reported with (FUTO), installed beside the
# emulator's own: DeviceTest types with each. Only when its APK is at hand
# (140 MB, not fetched here), checked against its SHA-256.
FUTO_APK="${FUTO_APK:-$HOME/.cache/burrow-android/futo-keyboard-0.1.30.apk}"
FUTO_SHA=0f7bca8365a13cea1cb2c21fb3c96b6fd73fbd64c3b7bd247b764f3e11ed8eba
if [ -f "$FUTO_APK" ] && echo "$FUTO_SHA  $FUTO_APK" | sha256sum -c --quiet 2>/dev/null; then
  echo "-> FUTO's keyboard installed beside the emulator's own"
  docker exec -i "$EMU" sh -c 'cat > /scratch/futo.apk' < "$FUTO_APK"
  adb install -r /scratch/futo.apk >/dev/null
else
  echo "-> FUTO's keyboard: not tested (no $FUTO_APK)"
fi

# ONLY=<Class[#method]>[,...]: those tests alone (looking into a failure or
# at one screen), with what they need first: the app set up and paired
# (DeviceTest t0 and t1) unless that is what is asked, the throwaway
# WireGuard server, the direct route turned on (W-FUNC-16: PhoneFilesTest
# alone met the setup screen and failed in 3 s).
if [ -n "${ONLY:-}" ]; then
  echo "-> Only $ONLY"
  install_new
  only=()
  IFS=, read -r -a parts <<< "$ONLY"
  for t in "${parts[@]}"; do only+=("io.github.r31l4nd.burrow.$t"); done
  joined="$(IFS=,; echo "${only[*]}")"
  case ",$ONLY," in
    *,DeviceTest,*|*,DeviceTest#t0*|*,DeviceTest#t1*) ;;
    *)
      echo "-> Set up and paired first (DeviceTest t0, t1)"
      instrument -e class "io.github.r31l4nd.burrow.DeviceTest#t0_asksForTheServerFirst,io.github.r31l4nd.burrow.DeviceTest#t1_locksThenPairsWithACode" -e shotPrefix only-
      ;;
  esac
  # DeviceTest's later steps as the passes run them: from the state the pairing left.
  keep=()
  case ",$ONLY," in *,DeviceTest,*|*,DeviceTest#t0*|*,DeviceTest#t1*) ;; *) keep=(-e keep 1) ;; esac
  wg=()
  if [[ "$ONLY" == *WireGuardTest* ]]; then wg=(-e wgConf "$(bash android/test/wg-server.sh up 10.0.2.2 | base64 -w0)"); fi
  if [[ "$ONLY" == *DirectRouteTest* ]]; then
    # As the full run does: Burrow puts the phone's key on the host, d1 fetches the cache with
    # Burrow up, d2 and d3 run with Burrow stopped (asked alone, d1 runs first all the same).
    NODE_ENV_FILE="$WORK/node.env" bash scripts/node.sh node android/test/enable-direct.mjs "https://127.0.0.1:$TLS_PORT" "$ORIGIN" "$(arg cookie)" "$(arg hostId)" "$(arg totp)"
    D=io.github.r31l4nd.burrow.DirectRouteTest
    instrument -e class "$D#d1_fetchesTheCache"
    later=()
    case ",$ONLY," in *,DirectRouteTest,*) later=("$D#d2_terminalWithoutBurrow" "$D#d3_portForward") ;; esac
    for t in "${parts[@]}"; do case "$t" in DirectRouteTest#d2*|DirectRouteTest#d3*) later+=("io.github.r31l4nd.burrow.$t") ;; esac; done
    if [ ${#later[@]} -gt 0 ]; then
      docker stop "$APP" "$PROXY" >/dev/null
      instrument -e class "$(IFS=,; echo "${later[*]}")"
    fi
  else
    instrument -e class "$joined" "${keep[@]}" "${wg[@]}"
  fi
  [ ${#wg[@]} = 0 ] || bash android/test/wg-server.sh down
  echo "-> Screens: $SCREENS ($(ls "$SCREENS" | wc -l) files)"
  exit 0
fi

if [ -n "$OLD_VERSION" ]; then
  echo "-> $OLD_VERSION set up and paired, then this version installed over it"
  docker exec -i "$EMU" sh -c 'cat > /scratch/old.apk' < "$WORK/old/android/app/build/outputs/apk/debug/app-debug.apk"
  docker exec -i "$EMU" sh -c 'cat > /scratch/old-test.apk' < "$WORK/old/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
  adb install -g /scratch/old.apk >/dev/null
  adb install -g /scratch/old-test.apk >/dev/null
  PAIR_CODE="$(arg upgradeCode)" instrument -e class "io.github.r31l4nd.burrow.DeviceTest#t0_asksForTheServerFirst,io.github.r31l4nd.burrow.DeviceTest#t1_locksThenPairsWithACode"
  install_new
  installed="$(adb shell dumpsys package io.github.r31l4nd.burrow.debug | sed -n 's/.*versionName=\([^ ]*\).*/\1/p' | tr -d '\r' | head -1)"
  [ "$installed" = "$CUR-debug" ] || { echo "after the update the app is $installed, not $CUR-debug"; exit 1; }
  # The server, the device key and the pairing kept: it signs in as it did.
  instrument -e class io.github.r31l4nd.burrow.DeviceTest#t2_signsInWithTheDeviceKey -e shotPrefix upgrade- -e keep 1
  # The rest starts from a fresh install.
  adb uninstall io.github.r31l4nd.burrow.debug >/dev/null
fi
install_new

echo "-> Instrumented tests: the app with Burrow"
instrument -e class io.github.r31l4nd.burrow.DeviceTest

echo "-> The phone's own files: a folder granted in Android's picker, read, copied to the host and back"
instrument -e class io.github.r31l4nd.burrow.PhoneFilesTest

# "All files" read for real on the emulator: apart, because the emulator itself died there (exit
# 139, nothing said) in most runs, a phone does not; its side in the app is AllFilesTest (JVM).
if [ -n "${ALL_FILES:-}" ]; then
  echo "-> All files: Android's permission, the phone's storage listed and read, switched off again"
  instrument -e class io.github.r31l4nd.burrow.AllFilesDeviceTest
else
  echo "-> All files on the emulator: left out (ALL_FILES=1 runs it; the emulator crashes there at times)"
fi

# The same app again as a tablet, in the dark and in Dutch: the screens
# that change most, their screenshots apart (tablet-*, dark-nl-*). Each
# test finds Burrow's buttons by their text in the pass's language and
# starts from its own state (an app tab signed out again), so a pass runs
# after the phone's as it would alone.
PASS_TESTS="t2_signsInWithTheDeviceKey t5_appTabKeepsItsOwnSignIn t5b_downloadsAskFirstResumeAndStop t5d_anAppTabThatCannotBeReachedSaysSo t6_reportsItsDirectRouteKey t9_aPushNotificationLinkOpensThePage t9c_openingBurrowKeepsTheDirectRoute ta_backClosesAnOpenDialogFirst tz_theTextBoxRunsInYourOwnTmux tzb_theTerminalTakesTheKeyboardAndTheVolumeKeys tzc_aShakeReportsAProblemUnlessTurnedOff"
PASS_CLASSES="$(for t in $PASS_TESTS; do printf 'io.github.r31l4nd.burrow.DeviceTest#%s,' "$t"; done)"
# The screen stays on from here: off between two runs, the app locks
# itself (as it should) and the next run finds it locked.
adb shell svc power stayon true
for p in ${PASSES-tablet dark-nl}; do
  case "$p" in
    tablet) size=1600x2560; night=no; lang=en ;;
    dark-nl) size=; night=yes; lang=nl ;;
    tablet-dark-nl) size=1600x2560; night=yes; lang=nl ;;
    *) echo "unknown pass $p (tablet, dark-nl, tablet-dark-nl)"; exit 1 ;;
  esac
  echo "-> Pass $p"
  [ -z "$size" ] || { adb shell wm size "$size" && adb shell wm density 320; }
  adb shell cmd uimode night "$night" >/dev/null
  # The app's own language (Android 13+), as a person sets it: the native screens; the page follows (WebTestBase.opened).
  adb shell cmd locale set-app-locales io.github.r31l4nd.burrow.debug --locales "$lang"
  instrument -e class "${PASS_CLASSES%,}" -e shotPrefix "$p-" -e keep 1 -e lang "$lang"
  adb shell wm size reset && adb shell wm density reset
  adb shell cmd uimode night no >/dev/null
  adb shell cmd locale set-app-locales io.github.r31l4nd.burrow.debug --locales en
done
# Turned on its side: the emulator does not turn reliably here (it once
# did, and showed the terminal crowded out with the keyboard up); that
# case is e2e's (mobile.spec.ts, a phone turned on its side).

# What the launcher shows on a long-press of the icon.
adb shell dumpsys shortcut | grep -A3 "Package: io.github.r31l4nd.burrow.debug" | head -20 || true

echo "-> The app's own WireGuard: a throwaway server, its page only behind the tunnel"
WG_CONF="$(bash android/test/wg-server.sh up 10.0.2.2 | base64 -w0)"
instrument -e class io.github.r31l4nd.burrow.WireGuardTest -e wgConf "$WG_CONF"
bash android/test/wg-server.sh down

echo "-> Direct route: Burrow puts the phone's key on the host; the app fetches its cache"
NODE_ENV_FILE="$WORK/node.env" bash scripts/node.sh node android/test/enable-direct.mjs "https://127.0.0.1:$TLS_PORT" "$ORIGIN" "$(arg cookie)" "$(arg hostId)" "$(arg totp)"
instrument -e class io.github.r31l4nd.burrow.DirectRouteTest#d1_fetchesTheCache

echo "-> Burrow stopped: the direct route still reaches the host"
docker stop "$APP" "$PROXY" >/dev/null
instrument -e class io.github.r31l4nd.burrow.DirectRouteTest#d2_terminalWithoutBurrow,io.github.r31l4nd.burrow.DirectRouteTest#d3_portForward

echo "-> Another server chosen: nothing of the old one stays (it unpairs the app, so last)"
instrument -e class io.github.r31l4nd.burrow.ServerChangeTest

echo "-> Coverage: the device test's runs ($(ls "$COV_DIR" | wc -l) files), alone and with the JVM tests"
# The same build as above (same environment): the classes the APK was made of.
docker run --rm --label burrow.ignore=true --name "$PREFIX-build" --user "$(id -u):$(id -g)" -v "$ROOT/android":/project -v "$GRADLE_VOLUME":/gradle \
  -e BURROW_TEST_CA=/project/app/build/test-ca/ca.pem -e BURROW_VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json | head -1)" \
  burrow-android-build:local sh -lc 'gradle --no-daemon -q deviceCoverageReport combinedCoverageReport showDeviceCoverage' \
  || echo "(no coverage report: see above)"
echo "   per file: android/app/build/reports/coverage/combined/html/index.html"

echo "-> Screens for review: $SCREENS ($(ls "$SCREENS" | wc -l) files)"
