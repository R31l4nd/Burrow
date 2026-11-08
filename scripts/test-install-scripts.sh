#!/usr/bin/env bash
# scripts/test-install-scripts.sh - an install script npm has not been told
# about (allowScripts in package.json) fails the install instead of running.
# In npm 11 allowScripts alone only warns and runs it anyway; the repo's
# .npmrc (strict-allow-scripts) makes it an error (A3-OPS-06). A made-up
# package with a postinstall, installed offline with the repo's .npmrc.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$ROOT/scripts/node.sh" sh -c '
  set -u
  d="$(mktemp -d)"
  cd "$d"
  mkdir evil
  printf "{\"name\":\"evil\",\"version\":\"1.0.0\",\"scripts\":{\"postinstall\":\"touch %s/ran\"}}\n" "$d" > evil/package.json
  printf "{\"name\":\"t\",\"version\":\"1.0.0\",\"dependencies\":{\"evil\":\"file:./evil\"}}\n" > package.json
  [ -f /app/.npmrc ] && cp /app/.npmrc .npmrc
  if npm install --no-audit --no-fund --offline >out.txt 2>&1; then echo "an unreviewed install script did not fail the install"; cat out.txt; exit 1; fi
  [ ! -e ran ] || { echo "an unreviewed install script ran"; exit 1; }
  grep -q postinstall out.txt || { echo "the install failed for another reason:"; cat out.txt; exit 1; }
  echo "install scripts: an unreviewed one fails the install and does not run"
'
