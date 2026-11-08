#!/usr/bin/env bash
# scripts/repin.sh - every pinned image whose tag moved upstream (the gate's
# pins NOTE) to its new digest, in every file that names the old one; then
# the F-Droid draft's Node to the Node of scripts/node.sh, with its checksum
# from nodejs.org. Maintenance in one go: by hand it took two gate runs
# (2.11.0). Run `make check` and the gate afterwards, as for any change.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source scripts/image-refs.sh

moved=0
while IFS= read -r ref; do
  [ -n "$ref" ] && [ "${ref#*@}" != "$ref" ] || continue
  tag="${ref%@*}"
  pinned="${ref#*@}"
  current="$(timeout 60 docker buildx imagetools inspect "$tag" --format '{{.Manifest.Digest}}' 2>/dev/null)" || { echo "$tag: not asked (offline?)"; continue; }
  [ -n "$current" ] && [ "$current" != "$pinned" ] || continue
  files="$(git grep -l -- "$pinned" || true)"
  for f in $files; do sed -i "s/$pinned/$current/g" "$f"; done
  echo "$tag: ${pinned:7:12} -> ${current:7:12} ($(echo $files | wc -w) files)"
  moved=$((moved + 1))
done < <(image_refs)
echo "$moved images moved"

# The F-Droid draft builds the direct route's page with the same Node.
Y=docs/fdroid/io.github.r31l4nd.burrow.yml
node="$(bash scripts/node.sh node --version | tr -d '\r')"
was="$(grep -oE 'node-v[0-9]+\.[0-9]+\.[0-9]+-linux-x64' "$Y" | head -n 1 | sed 's/^node-//; s/-linux-x64$//')"
if [ -n "$was" ] && [ "$was" != "$node" ]; then
  sha="$(curl -fsSL "https://nodejs.org/dist/$node/SHASUMS256.txt" | awk -v f="node-$node-linux-x64.tar.xz" '$2 == f { print $1 }')"
  [ -n "$sha" ] || { echo "no checksum for Node $node on nodejs.org" >&2; exit 1; }
  sed -i -E "s/$was/$node/g; s/[0-9a-f]{64}(  \/tmp\/node\.tar\.xz)/$sha\1/" "$Y"
  echo "$Y: Node $was -> $node"
fi
bash scripts/fdroid-check.sh
