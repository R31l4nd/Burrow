#!/usr/bin/env bash
# A release tag before anything is published (CI): it must be the version
# every package says and have its section in CHANGELOG.md, so the image, its
# tags and the release notes are of the same release (AUDIT2 OPS-12). Says
# whether it may become "latest": a stable release (no -rc) and the newest
# of the stable tags, so an older maintenance release or a prerelease does
# not take it over (OPS-13).
#
#   bash scripts/release-tag.sh v1.25.0          # checks; prints latest=true|false
#   TAGS="v1.24.0 v1.25.0" bash scripts/release-tag.sh v1.24.1   # the tags to compare with (default: git tag)
set -euo pipefail
cd "$(dirname "$0")/.."

tag="${1:?usage: release-tag.sh vX.Y.Z}"
fail() { echo "release tag $tag: $*" >&2; exit 1; }

[[ "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)(-[0-9A-Za-z.-]+)?$ ]] || fail "not vMAJOR.MINOR.PATCH[-pre]"
# No prereleases (audit 2026-11-09): the app's version code and the APK build read X.Y.Z only, so a
# -rc tag put the images out and then failed before the GitHub release.
[ -z "${BASH_REMATCH[2]}" ] || fail "a prerelease: Burrow ships none, tag vX.Y.Z"
version="${tag#v}"

for f in package.json */package.json; do
  [ -f "$f" ] || continue
  v=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$f" | head -n 1)
  [ "$v" = "$version" ] || fail "$f says ${v:-no version}, not $version"
done
grep -q "^## \[$version\]" CHANGELOG.md || fail "CHANGELOG.md has no section ## [$version]"

latest=false
if [ -z "${BASH_REMATCH[2]}" ]; then
  tags="${TAGS:-$(git tag --list 'v*')}"
  newest=$(printf '%s\n' $tags "$tag" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1)
  [ "$newest" = "$tag" ] && latest=true
fi
echo "latest=$latest"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "latest=$latest" >> "$GITHUB_OUTPUT"; fi
