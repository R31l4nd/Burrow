#!/usr/bin/env bash
# scripts/bump-version.sh X.Y.Z - a release's version everywhere it is
# written, so none is forgotten (the gate's versions step checks them all):
#
#   - package.json of the root, shared, server, web and e2e, and what server
#     and web ask of @burrow/shared;
#   - package-lock.json's entries for those workspaces;
#   - android/version-code.txt (major*10000 + minor*100 + patch);
#   - CHANGELOG.md: what is under [Unreleased] goes under a new [X.Y.Z]
#     section with today's date, with a "### Verified" part to fill in;
#   - the F-Droid draft's version fields (docs/fdroid/io.github.r31l4nd.burrow.yml);
#   - the Android app's "What's new" for that version code, English and
#     Dutch (android/fastlane/.../changelogs/<code>.txt; the app and F-Droid
#     show it), made empty when missing: write them (500 characters at most).
#
# It changes files only; commit them with the release (docs/MAINTAINING.md).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
V="${1:-}"
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: bash scripts/bump-version.sh X.Y.Z" >&2; exit 2; }

bash scripts/node.sh node -e '
  const fs = require("fs");
  const v = process.argv[1];
  const write = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + "\n");
  for (const f of ["package.json", "shared/package.json", "server/package.json", "web/package.json", "e2e/package.json"]) {
    const p = JSON.parse(fs.readFileSync(f, "utf8"));
    p.version = v;
    if (p.dependencies && "@burrow/shared" in p.dependencies) p.dependencies["@burrow/shared"] = v;
    write(f, p);
  }
  const l = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  l.version = v;
  for (const k of ["", "shared", "server", "web", "e2e"]) {
    const p = l.packages[k];
    if (!p) continue;
    p.version = v;
    if (p.dependencies && "@burrow/shared" in p.dependencies) p.dependencies["@burrow/shared"] = v;
  }
  write("package-lock.json", l);
' "$V"

code="$(echo "$V" | awk -F. '{print $1*10000 + $2*100 + $3}')"
echo "$code" > android/version-code.txt

if ! grep -qE "^## \[$V\]" CHANGELOG.md; then
  V="$V" DAY="$(date +%F)" awk '
    !done && /^## \[Unreleased\]/ { print; print ""; print "## [" ENVIRON["V"] "] - " ENVIRON["DAY"]; done = 1; next }
    { print }
  ' CHANGELOG.md > CHANGELOG.md.new
  mv CHANGELOG.md.new CHANGELOG.md
  # A "### Verified" part in the new section, before the next one, when it has none.
  V="$V" awk '
    $0 ~ "^## \\[" ENVIRON["V"] "\\]" { inside = 1; print; next }
    inside && /^## \[/ { if (!seen) { print "### Verified"; print ""; print "- (how this release was tested)"; print "" } inside = 0 }
    inside && /^### Verified/ { seen = 1 }
    { print }
  ' CHANGELOG.md > CHANGELOG.md.new
  mv CHANGELOG.md.new CHANGELOG.md
fi

# The F-Droid draft builds this release (docs/fdroid/README.md).
FD=docs/fdroid/io.github.r31l4nd.burrow.yml
[ -f "$FD" ] || { echo "$FD is missing" >&2; exit 1; }
sed -i -e "s/^\( *-\{0,1\} *\)versionName: .*/\1versionName: $V/" -e "s/^\( *\)versionCode: .*/\1versionCode: $code/" -e "s/^\( *\)commit: v.*/\1commit: v$V/" \
  -e "s/^CurrentVersion: .*/CurrentVersion: $V/" -e "s/^CurrentVersionCode: .*/CurrentVersionCode: $code/" "$FD"

for lang in en-US nl-NL; do
  f="android/fastlane/metadata/android/$lang/changelogs/$code.txt"
  [ -e "$f" ] || : > "$f"
done

echo "version $V (Android $code). Still to write:"
echo "  - CHANGELOG.md, section [$V]: what changed, and ### Verified"
echo "  - android/fastlane/metadata/android/{en-US,nl-NL}/changelogs/$code.txt"
