#!/usr/bin/env bash
# scripts/replay.sh <report id> - a problem report's input played again.
#
# The report's recording.json (the last 30 seconds of input on a terminal,
# made by web/src/lib/inputlog.ts) goes through e2e/tests/replay.spec.ts on
# the e2e setup: a fresh session of the same kind, the same text box
# setting and screen size, each event as it came. It prints what the
# terminal then shows and the suggestions, and leaves replay.png beside the
# report in artifacts/bugreports/<id>/.
set -euo pipefail
cd "$(dirname "$0")/.."
ID="${1:?usage: make replay ID=<report id>}"
DIR="artifacts/bugreports/$ID"
[ -f "$DIR/report.md" ] || make --no-print-directory bugs ID="$ID" >/dev/null
[ -f "$DIR/recording.json" ] || { echo "$ID has no input recording (only reports from a terminal have one)."; exit 1; }
REPLAY="$DIR/recording.json" bash scripts/e2e.sh --no-deps --project=setup --project=replay --reporter=list
echo "Picture: $DIR/replay.png"
