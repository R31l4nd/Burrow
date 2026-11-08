#!/usr/bin/env bash
# scripts/apk.sh - build the Android app and offer it for download in the
# running Burrow (Settings -> Android app).
#
#   bash scripts/apk.sh            build + publish
#   bash scripts/apk.sh keystore   make the signing key (once)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ -f .env.build ] || { echo ".env.build missing: cp .env.build.example .env.build and set KEYSTORE_PASSWORD"; exit 1; }
grep -q '^KEYSTORE_PASSWORD=..' .env.build || { echo "KEYSTORE_PASSWORD in .env.build is empty"; exit 1; }
mkdir -p artifacts android/keystore

compose() { docker compose --profile build "$@"; }
# The build runs as the user who calls this: it writes in that user's
# checkout, and on CI that user is not uid 1000 (the first release built on
# GitHub, 2026-11-08, could not write android/ there).
export PUID="${PUID:-$(id -u)}" PGID="${PGID:-$(id -g)}"

if [ "${1:-}" = keystore ]; then
  [ -f android/keystore/burrow.jks ] && { echo "android/keystore/burrow.jks exists already; not replacing it (installed apps would refuse updates)."; exit 1; }
  compose build android-build
  compose run --rm android-build keytool -genkeypair -keystore keystore/burrow.jks -alias burrow \
    -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=Burrow" \
    -storepass:env KEYSTORE_PASSWORD -keypass:env KEYSTORE_PASSWORD
  # Readable by its owner only (keytool leaves it 0644); the build runs as that owner.
  chmod 600 android/keystore/burrow.jks || echo "Note: could not make android/keystore/burrow.jks private (chmod 600 it yourself)."
  echo
  echo "Signing certificate (BURROW_ANDROID_CERT_SHA256, only needed for passkeys in the app):"
  compose run --rm android-build keytool -list -keystore keystore/burrow.jks -alias burrow -storepass:env KEYSTORE_PASSWORD | grep 'SHA-256' || true
  echo
  echo "Back up android/keystore/burrow.jks and .env.build: without them no update of the app can be installed."
  exit 0
fi

[ -f android/keystore/burrow.jks ] || { echo "android/keystore/burrow.jks missing: bash scripts/apk.sh keystore"; exit 1; }
VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json | head -1)"
export BURROW_VERSION="$VERSION"
compose build android-build
# APK_DIRECT_BUILT=1: the page was built already, before the signing key was
# there (the release in CI: npm's packages never run beside it, A3-OPS-07).
[ -n "${APK_DIRECT_BUILT:-}" ] || bash scripts/direct-assets.sh
# The image's own command plus Android lint, which fails on any warning (A3-AND-12).
compose run --rm android-build sh -lc 'gradle --no-daemon testDebugUnitTest checkUnitTestCoverage lintDebug assembleRelease && cp app/build/outputs/apk/release/app-release.apk /out/burrow.apk && echo "APK: artifacts/burrow.apk"'
# Signed with v3 (A3-AND-18): without it the key could not be rotated later.
compose run --rm android-build sh -c '"$ANDROID_SDK_ROOT"/build-tools/36.0.0/apksigner verify --verbose /out/burrow.apk' > artifacts/burrow.apk.sig.txt \
  || { cat artifacts/burrow.apk.sig.txt; echo "the APK's signature does not verify"; exit 1; }
grep -q '^Verified using v3 scheme (APK Signature Scheme v3): true' artifacts/burrow.apk.sig.txt \
  || { cat artifacts/burrow.apk.sig.txt; echo "the APK has no v3 signature (android/app/build.gradle.kts)"; exit 1; }

APK=artifacts/burrow.apk
SHA="$(sha256sum "$APK" | cut -d' ' -f1)"
IFS=. read -r MA MI PA <<<"$VERSION"
printf '{"versionName":"%s","versionCode":%d,"sha256":"%s"}\n' "$VERSION" "$((MA * 10000 + MI * 100 + PA))" "$SHA" > artifacts/burrow.apk.json
echo "APK $VERSION  sha256 $SHA"

# Into the running Burrow's data directory (bind mount or named volume alike).
if docker compose ps --status running --services 2>/dev/null | grep -qx burrow; then
  docker compose exec -T burrow mkdir -p /data/downloads
  # Copied beside, then renamed into place, the APK before its description: a download
  # never sees half a file, and the description never names an APK not there yet (AUDIT2 OPS-23).
  docker compose cp -a "$APK" burrow:/data/downloads/.burrow.apk.new
  docker compose cp -a artifacts/burrow.apk.json burrow:/data/downloads/.burrow.apk.json.new
  docker compose exec -T burrow sh -c 'cd /data/downloads && mv -f .burrow.apk.new burrow.apk && mv -f .burrow.apk.json.new burrow.apk.json'
  echo "Offered for download in Burrow: Settings -> Android app."
else
  echo "Burrow is not running; copy artifacts/burrow.apk{,.json} to <data>/downloads/ yourself."
fi
