#!/usr/bin/env bash
# scripts/test-backup.sh - make a backup of a throwaway Burrow instance,
# verify it restores, and check that a wrong key is refused. Nothing here
# touches a real instance.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/docker-lib.sh
. "$ROOT/scripts/docker-lib.sh"
need openssl
cd "$ROOT"

VOL=burrow-backuptest-data
APP=burrow-backuptest-app
WORK=""
cleanup() {
  docker rm -fv "$APP" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  [ -z "$WORK" ] || rm -rf "$WORK"
}
trap cleanup EXIT
cleanup
WORK="$(mktemp -d)"

[ -n "${SKIP_BUILD:-}" ] || rebuild burrow:e2e .
rebuild burrow-backup:e2e --build-arg PKG_DATE="$(date +%F)" -f Dockerfile.backup .

# A real database: start Burrow once so it migrates and creates secret.key.
docker volume create "$VOL" >/dev/null
docker run -d --label burrow.ignore=true --name "$APP" -v "$VOL":/data -e BURROW_ORIGIN=http://localhost -e STATUS_INTERVAL_SECONDS=0 burrow:e2e >/dev/null
for _ in $(seq 1 50); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$APP" 2>/dev/null)" = healthy ] && break
  docker exec "$APP" test -f /data/burrow.db 2>/dev/null && sleep 1 && break
  sleep 0.3
done
mkdir -p "$WORK/backups"
chmod 777 "$WORK/backups"
openssl rand -base64 48 > "$WORK/key"
chmod 644 "$WORK/key"

run_backup() {
  docker run --rm --label burrow.ignore=true --user 1000:1000 --network none --read-only --tmpfs /tmp \
    -v "$VOL":/data -v "$WORK/backups":/backups -v "$1":/run/secrets/backup_encryption_key:ro \
    burrow-backup:e2e "${@:2}"
}

# Taken while Burrow is running: the online backup must be consistent.
run_backup "$WORK/key" /app/scripts/backup/backup.sh
ARCHIVE="$(cd "$WORK/backups" && ls burrow-*.tar.gz.enc | head -1)"
[ -n "$ARCHIVE" ] || { echo "no archive written"; exit 1; }
run_backup "$WORK/key" /app/scripts/backup/verify.sh "/backups/$ARCHIVE"
# How it went, for Settings -> Backups: in the data volume, and Burrow reads it.
docker exec "$APP" cat /data/backup-status.json | grep -q '"ok":true' || { echo "no good backup-status.json"; docker exec "$APP" cat /data/backup-status.json; exit 1; }
# A failing round (no key) is written down too.
if run_backup /dev/null /app/scripts/backup/backup.sh >/dev/null 2>&1; then echo "a backup without a key succeeded"; exit 1; fi
docker exec "$APP" cat /data/backup-status.json | grep -q '"ok":false' || { echo "the failed round is not in backup-status.json"; exit 1; }

# Back up now, asked by Burrow: the loop takes the request within seconds,
# not at the end of its interval, and removes it. The last round long ago:
# the loop's first round is due at once.
touch -d '2 days ago' "$WORK/backups/.last-success"
before="$(ls "$WORK/backups"/burrow-*.tar.gz.enc | wc -l)"
docker run -d --label burrow.ignore=true --name "$APP-loop" --user 1000:1000 --network none --read-only --tmpfs /tmp \
  -e BACKUP_INTERVAL_SECONDS=86400 -e BACKUP_POLL_SECONDS=1 \
  -v "$VOL":/data -v "$WORK/backups":/backups -v "$WORK/key":/run/secrets/backup_encryption_key:ro \
  burrow-backup:e2e /app/scripts/backup/backup.sh --loop >/dev/null
trap 'docker rm -fv "$APP-loop" >/dev/null 2>&1 || true; cleanup' EXIT
for _ in $(seq 1 60); do [ "$(ls "$WORK/backups"/burrow-*.tar.gz.enc | wc -l)" -gt "$before" ] && break; sleep 0.5; done
first="$(ls "$WORK/backups"/burrow-*.tar.gz.enc | wc -l)"
[ "$first" -gt "$before" ] || { echo "the loop made no first round"; docker logs "$APP-loop" | tail; exit 1; }
sleep 1.1
docker exec "$APP" sh -c 'date -u +%Y-%m-%dT%H:%M:%SZ > /data/backup-request'
for _ in $(seq 1 60); do [ "$(ls "$WORK/backups"/burrow-*.tar.gz.enc | wc -l)" -gt "$first" ] && break; sleep 0.5; done
[ "$(ls "$WORK/backups"/burrow-*.tar.gz.enc | wc -l)" -gt "$first" ] || { echo "a requested backup was not made"; docker logs "$APP-loop" | tail; exit 1; }
for _ in $(seq 1 20); do docker exec "$APP" test -e /data/backup-request || break; sleep 0.5; done
if docker exec "$APP" test -e /data/backup-request; then echo "the request was not taken away"; exit 1; fi
docker rm -fv "$APP-loop" >/dev/null

# A restart (a deploy, an update) when the last round is fresh makes no
# extra one: each restart made one, and with count-only retention 30
# archives spanned 4.4 days (A3-OPS-08). A request is still taken.
fresh="$(ls "$WORK/backups"/burrow-*.tar.gz.enc | wc -l)"
docker run -d --label burrow.ignore=true --name "$APP-loop" --user 1000:1000 --network none --read-only --tmpfs /tmp \
  -e BACKUP_INTERVAL_SECONDS=86400 -e BACKUP_POLL_SECONDS=1 \
  -v "$VOL":/data -v "$WORK/backups":/backups -v "$WORK/key":/run/secrets/backup_encryption_key:ro \
  burrow-backup:e2e /app/scripts/backup/backup.sh --loop >/dev/null
sleep 6
[ "$(ls "$WORK/backups"/burrow-*.tar.gz.enc | wc -l)" -eq "$fresh" ] || { echo "a restart with a fresh last round made another one"; docker logs "$APP-loop" | tail; exit 1; }
docker exec "$APP" sh -c 'date -u +%Y-%m-%dT%H:%M:%SZ > /data/backup-request'
for _ in $(seq 1 60); do [ "$(ls "$WORK/backups"/burrow-*.tar.gz.enc | wc -l)" -gt "$fresh" ] && break; sleep 0.5; done
[ "$(ls "$WORK/backups"/burrow-*.tar.gz.enc | wc -l)" -gt "$fresh" ] || { echo "a request after a restart was not taken"; docker logs "$APP-loop" | tail; exit 1; }
docker rm -fv "$APP-loop" >/dev/null

# Retention by age with a floor of a count: an archive stays when it is one
# of the newest COUNT or younger than DAYS (by the time in its name).
# COUNT 0 keeps everything; DAYS 0 counts only (A3-OPS-08).
run_backup "$WORK/key" sh -c '
  set -eu
  d=/tmp/r && mkdir -p $d
  make() { rm -rf $d/*; for age in "$@"; do f="$d/burrow-$(date -u -d "@$(( $(date +%s) - age * 86400 ))" +%Y%m%dT%H%M%SZ).tar.gz.enc"; touch "$f" "$f.sha256"; done; }
  left() { ls $d | grep -c "enc\$"; }
  r=/app/scripts/backup/retention.py
  # Three of the last days, two of 10 days ago, five of 40: 30 days keep five, where a count of three kept three.
  make 0 1 2 10 11 40 41 42 43 44
  python3 $r $d 3 30 burrow >/dev/null; [ "$(left)" = 5 ] || { echo "age: $(left) left, not 5"; exit 1; }
  [ "$(ls $d | grep -c sha256)" = 5 ] || { echo "the checksums did not go with their archives"; exit 1; }
  # All old: the newest COUNT stay, whatever their age.
  make 40 41 42 43 44 45; python3 $r $d 4 30 burrow >/dev/null; [ "$(left)" = 4 ] || { echo "floor: $(left) left, not 4"; exit 1; }
  # DAYS 0: the count alone; COUNT 0: nothing removed.
  make 0 1 2 3 4; python3 $r $d 2 0 burrow >/dev/null; [ "$(left)" = 2 ] || { echo "days 0: $(left) left, not 2"; exit 1; }
  make 50 60 70; python3 $r $d 0 30 burrow >/dev/null; [ "$(left)" = 3 ] || { echo "count 0: $(left) left, not 3"; exit 1; }
  # A cap (decision 17): eight rounds within the last days and MAX 5 keep the newest five; the floor never past the cap.
  make 0 1 2 3 4 5 6 7; python3 $r $d 3 30 burrow 5 >/dev/null; [ "$(left)" = 5 ] || { echo "cap: $(left) left, not 5"; exit 1; }
  make 40 41 42 43 44 45; python3 $r $d 30 30 burrow 4 >/dev/null; [ "$(left)" = 4 ] || { echo "floor over the cap: $(left) left, not 4"; exit 1; }
  if python3 $r $d 3 30 burrow x >/dev/null 2>&1; then echo "MAX x was taken"; exit 1; fi
  if python3 $r $d 3 x burrow >/dev/null 2>&1; then echo "DAYS x was taken"; exit 1; fi
'

# Two rounds started at the same moment: one after the other (a lock), each
# its own archive and checksum, both whole (AUDIT2 OPS-09, OPS-10: shared
# names and files, and a copy across filesystems published unfinished).
before="$(ls "$WORK/backups"/burrow-*.tar.gz.enc | wc -l)"
run_backup "$WORK/key" /app/scripts/backup/backup.sh >/dev/null &
run_backup "$WORK/key" /app/scripts/backup/backup.sh >/dev/null &
wait
[ "$(ls "$WORK/backups"/burrow-*.tar.gz.enc | wc -l)" -eq $((before + 2)) ] || { echo "two rounds at once did not make two archives"; ls -la "$WORK/backups"; exit 1; }
(cd "$WORK/backups" && for f in burrow-*.tar.gz.enc; do sha256sum -c "$f.sha256" >/dev/null || { echo "checksum does not match: $f"; exit 1; }; done)
[ -z "$(ls "$WORK/backups" | grep partial)" ] || { echo "a partial file was left"; exit 1; }
for f in $(cd "$WORK/backups" && ls -t burrow-*.tar.gz.enc | head -2); do run_backup "$WORK/key" /app/scripts/backup/verify.sh "/backups/$f" >/dev/null || { echo "$f does not verify"; exit 1; }; done

# A copy cut off by a kill (no trap runs) left its .partial for ever: one
# older than a day goes with the next round, a fresh one (a round under way) stays (OPS-W-17).
touch -d '2 days ago' "$WORK/backups/burrow-20000101T000000Z.tar.gz.enc.partial"
touch "$WORK/backups/burrow-20000102T000000Z.tar.gz.enc.partial"
run_backup "$WORK/key" /app/scripts/backup/backup.sh >/dev/null
[ ! -e "$WORK/backups/burrow-20000101T000000Z.tar.gz.enc.partial" ] || { echo "an old partial copy was left"; exit 1; }
[ -e "$WORK/backups/burrow-20000102T000000Z.tar.gz.enc.partial" ] || { echo "a fresh partial copy was removed"; exit 1; }
rm -f "$WORK/backups/burrow-20000102T000000Z.tar.gz.enc.partial"

openssl rand -base64 48 > "$WORK/wrong"
chmod 644 "$WORK/wrong"
if run_backup "$WORK/wrong" /app/scripts/backup/verify.sh "/backups/$ARCHIVE" >/dev/null 2>&1; then
  echo "a wrong key was accepted"; exit 1
fi
# Archives that decrypt but hold no Burrow database are refused before
# anything is staged: none at all (sqlite3 made an empty one and passed it),
# an empty file, and another program's database (AUDIT2 OPS-02).
run_backup "$WORK/key" sh -c '
  set -eu
  cd /tmp
  for kind in missing empty other; do
    rm -rf w && mkdir -p w/burrow
    case "$kind" in
      empty) : > w/burrow/burrow.db ;;
      other) sqlite3 w/burrow/burrow.db "CREATE TABLE notes(x); INSERT INTO notes VALUES (1);" ;;
    esac
    tar -czf "w.tar.gz" -C w burrow
    python3 /app/scripts/backup/crypto.py encrypt w.tar.gz "/backups/bad-$kind.tar.gz.enc" /run/secrets/backup_encryption_key
  done
'
for kind in missing empty other; do
  if run_backup "$WORK/key" /app/scripts/backup/restore-stage.sh "/backups/bad-$kind.tar.gz.enc" >/dev/null 2>&1; then
    echo "a backup with a $kind database was staged for a restore"; exit 1
  fi
  run_backup "$WORK/key" sh -c '[ ! -e /data/.restore ]' || { echo "a refused $kind backup left a staging folder"; exit 1; }
done
rm -f "$WORK/backups"/bad-*.tar.gz.enc

# A restore: staged while Burrow runs, swapped with it stopped, the files
# from before kept. Its name full of spaces and shell signs runs nothing
# (audit OP-03, OP-04).
run_backup "$WORK/key" sh -c "sqlite3 /data/burrow.db 'CREATE TABLE after_backup(x)'"
ODD="burrow it's \$(touch pwned) \`touch pwned2\`.tar.gz.enc"
cp "$WORK/backups/$ARCHIVE" "$WORK/backups/$ODD"
# Run in the backups folder: a name that ran as a command would leave its file there.
docker run --rm --label burrow.ignore=true --user 1000:1000 --network none --read-only --tmpfs /tmp -w /backups \
  -v "$VOL":/data -v "$WORK/backups":/backups -v "$WORK/key":/run/secrets/backup_encryption_key:ro \
  burrow-backup:e2e /app/scripts/backup/restore-stage.sh "/backups/$ODD" >/dev/null
[ ! -e "$WORK/backups/pwned" ] && [ ! -e "$WORK/backups/pwned2" ] || { echo "the archive's name ran as a command"; exit 1; }
docker stop "$APP" >/dev/null
# A swap interrupted after the live database was moved aside, then run
# again: the files from before survive (the retry removed .before-restore
# first, and with it the only copy; AUDIT2 OPS-07).
run_backup "$WORK/key" sh -c 'mkdir -p /data/.before-restore && mv /data/burrow.db /data/.before-restore/burrow.db'
run_backup "$WORK/key" /app/scripts/backup/restore-swap.sh >/dev/null
run_backup "$WORK/key" sh -c '
  set -eu
  [ -z "$(sqlite3 /data/burrow.db "SELECT name FROM sqlite_master WHERE name = '"'"'after_backup'"'"'")" ] || { echo "not restored"; exit 1; }
  [ -n "$(sqlite3 /data/.before-restore/burrow.db "SELECT name FROM sqlite_master WHERE name = '"'"'after_backup'"'"'")" ] || { echo "the database from before was not kept"; exit 1; }
  [ -f /data/secret.key ] && [ ! -e /data/.restore ]
'
docker start "$APP" >/dev/null
for _ in $(seq 1 50); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$APP" 2>/dev/null)" = healthy ] && break; sleep 0.3; done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$APP")" = healthy ] || { echo "Burrow did not come back after the restore"; docker logs "$APP" | tail -20; exit 1; }
# Reset deletes what Burrow's container has at /data, read from the
# container: a volume by its full name, a folder by its path (AUDIT2 OPS-03:
# it guessed "burrow_<name>", which could be another installation's).
BURROW_RESET_LIB=1 . "$ROOT/scripts/reset.sh"
docker rm -fv "$APP-reset" >/dev/null 2>&1 || true
docker run -d --label burrow.ignore=true --name "$APP-reset" -v "$VOL":/data alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f sleep 60 >/dev/null
[ "$(data_target "$APP-reset")" = "volume $VOL" ] || { echo "reset would delete '$(data_target "$APP-reset")', not the volume $VOL"; exit 1; }
docker rm -fv "$APP-reset" >/dev/null
mkdir -p "$WORK/binddata"
docker run -d --label burrow.ignore=true --name "$APP-reset" -v "$WORK/binddata":/data alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f sleep 60 >/dev/null
[ "$(data_target "$APP-reset")" = "bind $WORK/binddata" ] || { echo "reset would delete '$(data_target "$APP-reset")', not the folder $WORK/binddata"; exit 1; }
docker rm -fv "$APP-reset" >/dev/null

echo "backup round trip OK ($ARCHIVE); made when asked; a wrong key is refused; restored with the files from before kept"
