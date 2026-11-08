#!/usr/bin/env bash
# scripts/test-fresh-install.sh - the release test: a brand-new Debian 13
# virtual machine (QEMU with KVM, run in a container), Burrow installed on it
# by following docs/INSTALL.md ("Just trying it") from the committed tree
# (as a clone gets it), then the first sign-in and first host
# through the API (scripts/vm/first-signin.py). Needs /dev/kvm and internet.
# About 15 minutes; everything is removed afterwards.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/docker-lib.sh
. "$ROOT/scripts/docker-lib.sh"
need curl sha512sum ssh-keygen openssl
cd "$ROOT"

WORK="$(mktemp -d)"
CACHE="$ROOT/artifacts/vm-cache"
NAME=burrow-fresh-vm
IMAGE_URL=https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2
SUMS_URL=https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS
cleanup() { docker rm -fv "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
[ -e /dev/kvm ] || { echo "needs /dev/kvm"; exit 1; }

echo "== the tree as committed"
# HEAD, or before the release commit what it will hold: HEAD with the
# changes to tracked files (git add new ones first).
TREE="$(git stash create)"
git archive --prefix=burrow/ -o "$WORK/burrow.tgz" "${TREE:-HEAD}"
tar -xzf "$WORK/burrow.tgz" -C "$WORK" burrow/scripts/vm/first-signin.py

echo "== a Debian 13 cloud image"
mkdir -p "$CACHE"
# Bounded and retried: a fetch that hung held the shared test lock for
# minutes (A3-OPS-21). The image is a few hundred MB, so it gets longer.
CURL=(curl --connect-timeout 20 --retry 3 --retry-delay 5)
"${CURL[@]}" --max-time 120 -fsSL "$SUMS_URL" | grep ' debian-13-genericcloud-amd64.qcow2$' > "$WORK/SHA512SUMS"
if ! (cd "$CACHE" && sha512sum -c --status "$WORK/SHA512SUMS" 2>/dev/null); then
  "${CURL[@]}" --max-time 1800 -fL -o "$CACHE/debian-13-genericcloud-amd64.qcow2" "$IMAGE_URL"
  (cd "$CACHE" && sha512sum -c "$WORK/SHA512SUMS")
fi

echo "== the machine"
ssh-keygen -q -t ed25519 -N '' -f "$WORK/key"
PW="$(openssl rand -hex 12)"
cat > "$WORK/user-data" <<CLOUD
#cloud-config
users:
  - name: burrow
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: false
    ssh_authorized_keys: ["$(cat "$WORK/key.pub")"]
chpasswd:
  expire: false
  users: [{name: burrow, password: "$PW", type: text}]
ssh_pwauth: true
CLOUD
printf 'instance-id: burrow-fresh\nlocal-hostname: fresh\n' > "$WORK/meta-data"
rebuild burrow-vm scripts/vm
docker run -d --label burrow.ignore=true --name "$NAME" --device /dev/kvm -v "$WORK":/work -v "$CACHE":/cache:ro burrow-vm sleep infinity >/dev/null
docker exec "$NAME" sh -c '
  cd /work
  genisoimage -quiet -output seed.iso -volid cidata -joliet -rock user-data meta-data
  qemu-img create -q -f qcow2 -b /cache/debian-13-genericcloud-amd64.qcow2 -F qcow2 disk.qcow2 30G
  nohup qemu-system-x86_64 -enable-kvm -cpu host -smp 4 -m 6144 -nographic \
    -drive file=disk.qcow2,if=virtio -drive file=seed.iso,media=cdrom \
    -netdev user,id=n,hostfwd=tcp::2222-:22 -device virtio-net-pci,netdev=n > qemu.log 2>&1 &'
SSH=(docker exec -i "$NAME" ssh -i /work/key -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5 burrow@127.0.0.1)
for _ in $(seq 1 60); do "${SSH[@]}" true 2>/dev/null && break; sleep 5; done
"${SSH[@]}" 'cloud-init status --wait >/dev/null; . /etc/os-release; echo "up: $PRETTY_NAME"'

echo "== docs/INSTALL.md, step by step"
docker exec -i "$NAME" sh -c 'cat /work/burrow.tgz' | "${SSH[@]}" 'tar -xzf - -C ~'
docker exec -i "$NAME" sh -c 'cat /work/burrow/scripts/vm/first-signin.py' | "${SSH[@]}" 'cat > ~/first-signin.py'
"${SSH[@]}" 'set -e
  curl -fsSL https://get.docker.com | sh >/tmp/docker-install.log 2>&1
  sudo usermod -aG docker "$USER"
  docker --version; sudo docker compose version'
"${SSH[@]}" 'set -e
  cd ~/burrow
  cp .env.example .env
  sed -i "s|^BURROW_ORIGIN=.*|BURROW_ORIGIN=http://localhost:8080|" .env
  echo COMPOSE_FILE=compose.yaml:compose.try.yaml >> .env
  docker network create proxy >/dev/null
  docker compose up -d --build 2>&1 | tail -3'
"${SSH[@]}" 'cd ~/burrow; for i in $(seq 1 60); do [ "$(docker inspect -f "{{.State.Health.Status}}" burrow 2>/dev/null)" = healthy ] && break; sleep 5; done; docker inspect -f "burrow: {{.State.Health.Status}}" burrow'
TOKEN="$("${SSH[@]}" 'cd ~/burrow; docker compose logs burrow' | grep -oE '[A-Z0-9]{5}(-[A-Z0-9]{5}){3}' | tail -1)"
[ -n "$TOKEN" ] || { echo "no setup token in the log"; exit 1; }
echo "setup token found in the log"
GW="$("${SSH[@]}" "docker network inspect proxy -f '{{(index .IPAM.Config 0).Gateway}}'")"

echo "== first sign-in and first host"
"${SSH[@]}" "python3 ~/first-signin.py $TOKEN $GW $PW"
