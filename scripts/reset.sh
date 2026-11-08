#!/usr/bin/env bash
# scripts/reset.sh - delete ALL instance data: database, master key, stored
# SSH keys and passwords. Cannot be undone. Backups are left alone.
#
# What is deleted is what Burrow's container has mounted at /data, read from
# the container itself (a volume by its full name, or a folder): guessing
# "burrow_<name>" from settings could remove another installation's volume
# under a different project name, and "../data" was taken for a volume name
# (AUDIT2 OPS-03).
set -euo pipefail
cd "$(dirname "$0")/.."

# "volume <name>" or "bind <absolute path>" for /data in a container; nothing when none is mounted there.
data_target() {
  docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}} {{if eq .Type "volume"}}{{.Name}}{{else}}{{.Source}}{{end}}{{end}}{{end}}' "$1"
}

# Sourced by scripts/test-backup.sh to test data_target alone.
[ -z "${BURROW_RESET_LIB:-}" ] || return 0

container="$(docker compose ps -aq burrow 2>/dev/null | head -1)"
[ -n "$container" ] || { echo "No Burrow container found for this folder's compose project: nothing is deleted. Start it once (make up), or remove its data by hand."; exit 1; }
target="$(data_target "$container")"
kind="${target%% *}"
where="${target#* }"
case "$kind" in
  volume | bind) ;;
  *) echo "Burrow's container has nothing mounted at /data: nothing is deleted."; exit 1 ;;
esac
[ -n "$where" ] && [ "$where" != / ] || { echo "Refusing: the data location is empty or /."; exit 1; }

echo "!! This deletes Burrow's data: accounts, hosts, keys, audit log."
echo "   Exactly this: the Docker $kind '$where'."
echo "   Backups in ./backups are kept."
read -r -p "Type 'burrow' to continue: " answer
[ "$answer" = "burrow" ] || { echo "Cancelled."; exit 1; }

docker compose --profile backup down
if [ "$kind" = bind ]; then
  docker run --rm --label burrow.ignore=true -v "$where":/d alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f \
    sh -c 'rm -rf /d/* /d/.[!.]* /d/..?* 2>/dev/null || true'
else
  docker volume rm "$where"
fi
echo "Data deleted. 'make up' starts a fresh instance with a new setup token."
