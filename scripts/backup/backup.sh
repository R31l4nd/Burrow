#!/usr/bin/env sh
# Runs inside the backup container. Makes one encrypted archive of Burrow's
# whole persistent state: the SQLite database (online backup, consistent even
# while Burrow writes) and the master key that decrypts the secrets in it.
#
#   burrow-<timestamp>.tar.gz.enc   tar -> gzip -> AES-256-GCM (crypto.py)
#   burrow-<timestamp>.tar.gz.enc.sha256
#
# With --loop it repeats every BACKUP_INTERVAL_SECONDS. With
# BACKUP_REMOTE_ENABLED=1 a second copy goes to /remote-backups, which must be
# on a different device; the copy is verified there, not at the source.
set -eu
umask 077

KEY=/run/secrets/backup_encryption_key

once() {
  # Kept: those younger than BACKUP_RETENTION_DAYS, at most the newest
  # BACKUP_RETENTION_MAX (decision 17), and the newest
  # BACKUP_RETENTION_COUNT whatever their age (retention.py, A3-OPS-08).
  keep="${BACKUP_RETENTION_COUNT:-30}"
  days="${BACKUP_RETENTION_DAYS:-30}"
  max="${BACKUP_RETENTION_MAX:-60}"
  # One round at a time (the loop, Back up now, a deploy's backup): rounds
  # side by side shared names and files (AUDIT2 OPS-09).
  exec 9>/backups/.backup.lock
  flock 9
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  out="/backups/burrow-$ts.tar.gz.enc"
  # Two rounds within one second: the second one's name is its own.
  n=2
  while [ -e "$out" ]; do out="/backups/burrow-$ts-$n.tar.gz.enc"; n=$((n + 1)); done
  # A copy cut off by a kill (the trap does not run on SIGKILL) left its
  # .partial for ever: those older than a day go (OPS-W-17).
  find /backups -maxdepth 1 -name 'burrow-*.partial' -mmin +1440 -exec rm -f {} + 2>/dev/null || true
  [ -d /remote-backups ] && find /remote-backups -maxdepth 1 -name 'burrow-*.partial' -mmin +1440 -exec rm -f {} + 2>/dev/null || true
  work="$(mktemp -d /tmp/burrow-backup.XXXXXX)"
  trap 'rm -rf "$work" "$out.partial" "$out.sha256.partial"' EXIT HUP INT TERM

  [ -f /data/burrow.db ] || { echo "No database at /data/burrow.db - is the data volume mounted?" >&2; exit 2; }
  mkdir "$work/burrow"
  sqlite3 /data/burrow.db ".backup '$work/burrow/burrow.db'"
  result="$(sqlite3 "$work/burrow/burrow.db" 'PRAGMA integrity_check;')"
  [ "$result" = "ok" ] || { echo "Integrity check of the copy failed: $result" >&2; exit 1; }
  # The master key: without it the stored SSH keys cannot be decrypted. It is
  # absent when BURROW_SECRET is set in the environment; then back that up.
  if [ -f /data/secret.key ]; then
    cp /data/secret.key "$work/burrow/secret.key"
  else
    echo "Note: no /data/secret.key (BURROW_SECRET is set?) - back up that value separately."
  fi

  tar -C "$work" -czf "$work/backup.tar.gz" burrow
  gzip -t "$work/backup.tar.gz"
  python3 /app/scripts/backup/crypto.py encrypt "$work/backup.tar.gz" "$work/backup.enc" "$KEY"
  # Copied beside its final name, then renamed there: a move from /tmp is a
  # copy across filesystems, and an interrupted one left a cut-off archive
  # under its final name (AUDIT2 OPS-10). Its checksum the same way.
  cp "$work/backup.enc" "$out.partial"
  sync "$out.partial" 2>/dev/null || sync
  (cd /backups && sha256sum "$(basename "$out.partial")" | sed 's/\.partial$//' > "$(basename "$out").sha256.partial")
  mv "$out.partial" "$out"
  mv "$out.sha256.partial" "$out.sha256"

  if [ "${BACKUP_REMOTE_ENABLED:-0}" = "1" ]; then
    [ -d /remote-backups ] && [ -w /remote-backups ] || {
      echo "BACKUP_REMOTE_ENABLED=1 but /remote-backups is missing or not writable for uid $(id -u)." >&2
      exit 2
    }
    # Compare devices, not mount points: a bind mount from the same disk is a
    # mount point too and protects against nothing.
    if [ "$(df -P /backups | awk 'NR==2{print $1}')" = "$(df -P /remote-backups | awk 'NR==2{print $1}')" ]; then
      echo "/backups and /remote-backups are on the same device; the second copy must be elsewhere." >&2
      exit 2
    fi
    remote="/remote-backups/$(basename "$out")"
    cp "$out" "$remote.partial" && mv "$remote.partial" "$remote"
    cp "$out.sha256" "$remote.sha256"
    (cd /remote-backups && sha256sum -c "$(basename "$remote").sha256" >/dev/null)
    python3 /app/scripts/backup/retention.py /remote-backups "$keep" "$days" burrow "$max"
    echo "Second copy verified: $remote"
  fi

  python3 /app/scripts/backup/retention.py /backups "$keep" "$days" burrow "$max"
  # The healthcheck looks at the age of this file: a running process says
  # nothing, a recent successful round does.
  touch /backups/.last-success
  count="$(ls /backups/burrow-*.tar.gz.enc 2>/dev/null | wc -l)"
  remote=false
  [ "${BACKUP_REMOTE_ENABLED:-0}" = "1" ] && remote=true
  status "$(printf '{"ok":true,"at":"%s","file":"%s","bytes":%s,"count":%s,"remote":%s,"error":null}' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$out")" "$(stat -c %s "$out")" "$count" "$remote")"
  rm -rf "$work"
  trap - EXIT HUP INT TERM
  echo "Encrypted backup written: $out"
}

# How the last round went, for Burrow to show (Settings -> Backups): the one
# file this script writes into /data.
status() {
  printf '%s\n' "$1" > "/data/backup-status.json.$$" && mv "/data/backup-status.json.$$" /data/backup-status.json || true
}

# A round as its own run of this script (--once): `set -e` is ignored inside
# an `if` condition, also in a subshell, so only a separate process stops at
# the first error. A failure is written down too, with its last line.
round() {
  log="$(mktemp /tmp/burrow-backup-log.XXXXXX)"
  if "$0" --once > "$log" 2>&1; then
    cat "$log"
  else
    code=$?
    cat "$log" >&2
    msg="$(tail -n 1 "$log" | sed 's/["\\]/ /g' | cut -c1-300)"
    status "$(printf '{"ok":false,"at":"%s","file":null,"bytes":null,"count":null,"remote":null,"error":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$msg")"
    rm -f "$log"
    return "$code"
  fi
  rm -f "$log"
}

if [ "${1:-}" = "--once" ]; then
  once
elif [ "${1:-}" = "--loop" ]; then
  interval="${BACKUP_INTERVAL_SECONDS:-86400}"
  # A start (a deploy, an update, the machine) makes a round only when the
  # last good one is older than the interval; otherwise the first waits for
  # what is left of it. Every restart made one, a deploy's own backup came
  # just before, and the extra rounds pushed history out (A3-OPS-08).
  waited="$interval"
  if last="$(stat -c %Y /backups/.last-success 2>/dev/null)"; then
    age=$(( $(date +%s) - last ))
    if [ "$age" -ge 0 ] && [ "$age" -lt "$interval" ]; then
      waited="$age"
      echo "The last backup is ${age}s old: the next in $((interval - age))s."
    fi
  fi
  while true; do
    # Until the next round, or sooner when Burrow asks for one (Settings ->
    # Backups -> Back up now leaves /data/backup-request); taken away as the
    # round starts, so one request is one round.
    while [ "$waited" -lt "$interval" ] && [ ! -f /data/backup-request ]; do
      sleep "${BACKUP_POLL_SECONDS:-5}"
      waited=$((waited + ${BACKUP_POLL_SECONDS:-5}))
    done
    rm -f /data/backup-request
    round || true
    waited=0
  done
else
  round
fi
