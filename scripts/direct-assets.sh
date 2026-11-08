#!/usr/bin/env bash
# scripts/direct-assets.sh - put the direct route's page (web/direct.html)
# into the Android app's assets, with a selection of Fig completion specs.
# Run by scripts/apk.sh and scripts/android-test.sh before the APK build.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT=android/app/src/main/assets/direct
# All 700+ specs are 77 MB; the phone gets the commands a homelab uses.
SPECS=(apt apt-get cat cd chmod chown cp crontab curl df dig docker docker-compose du echo find free git grep head htop ip journalctl kill killall less ln ls lsblk make mkdir mount mv nano npm ping ps python3 rm rsync scp sed ssh sudo systemctl tail tar tmux top touch umount unzip vim wget which zip)

# In Docker (scripts/node.sh) by default; BURROW_NODE=local uses the Node on
# the PATH instead (build servers without Docker, such as F-Droid's).
BUILD='npm run build -w @burrow/shared >/dev/null && npm run build:direct -w @burrow/web >/dev/null'
if [ "${BURROW_NODE:-docker}" = local ]; then sh -c "$BUILD"; else bash scripts/node.sh sh -c "$BUILD"; fi
rm -rf "$OUT"
mkdir -p "$OUT/fig"
cp -r web/dist-direct/. "$OUT/"
FIG="node_modules/@withfig/autocomplete/build"
names=()
for s in "${SPECS[@]}"; do
  if [ -f "$FIG/$s.js" ]; then
    cp "$FIG/$s.js" "$OUT/fig/"
    names+=("\"$s\"")
  fi
done
printf 'var e=[%s];export{e as default};\n' "$(IFS=,; echo "${names[*]}")" > "$OUT/fig/index.js"
echo "direct route: $(du -sh "$OUT" | cut -f1), ${#names[@]} completion specs"
