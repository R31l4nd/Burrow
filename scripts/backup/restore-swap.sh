#!/bin/sh
# scripts/backup/restore-swap.sh - the second half, with Burrow and the
# backup service stopped: the staged files take the live ones' place by
# renames on one filesystem, and the live ones are kept in
# /data/.before-restore (audit OP-03). To go back: move them back.
#
# Run again after an interruption it goes on where it stopped and never
# removes what it kept: a retry deleted .before-restore first, and with it
# the only copy of a database moved there just before (AUDIT2 OPS-07). The
# files of an earlier, finished restore are kept under a dated name.
set -eu
STAGE=/data/.restore
KEEP=/data/.before-restore
[ -f "$STAGE/burrow.db" ] || { echo "nothing staged; run restore-stage.sh first" >&2; exit 1; }
if [ -d "$KEEP" ] && [ -e /data/burrow.db ]; then
  # A finished restore's files, with a live database beside them: kept apart.
  mv "$KEEP" "$KEEP.$(date -u +%Y%m%dT%H%M%SZ)"
fi
mkdir -p "$KEEP"
for f in burrow.db burrow.db-wal burrow.db-shm secret.key; do
  # Moved aside before the interruption: already kept, left where it is.
  if [ -e "/data/$f" ] && [ ! -e "$KEEP/$f" ]; then mv "/data/$f" "$KEEP/$f"; fi
done
mv "$STAGE/burrow.db" /data/burrow.db
if [ -f "$STAGE/secret.key" ]; then
  mv "$STAGE/secret.key" /data/secret.key
elif [ -f "$KEEP/secret.key" ]; then
  # A backup without its key (the key comes from BURROW_SECRET): the key stays.
  cp -p "$KEEP/secret.key" /data/secret.key
fi
rmdir "$STAGE"
echo "swapped; the files from before are in $KEEP"
