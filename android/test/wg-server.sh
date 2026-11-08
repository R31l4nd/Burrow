#!/usr/bin/env bash
# android/test/wg-server.sh - a throwaway WireGuard server for the tests of
# the app's own tunnel: kernel WireGuard in a container (NET_ADMIN), UDP
# 51899 published on this machine (51820 is often the real one), and a web page only on the tunnel's side
# (10.99.0.1:8080). Prints the client's wg-quick configuration.
#
#   bash android/test/wg-server.sh up <endpoint-host> > client.conf
#   bash android/test/wg-server.sh down
set -euo pipefail
NAME="${WG_NAME:-burrow-wg-server}"
IMAGE="alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f"
PORT="${WG_PORT:-51899}"

case "${1:-}" in
  down)
    docker rm -fv "$NAME" >/dev/null 2>&1 || true
    ;;
  up)
    ENDPOINT="${2:?endpoint host (as the client reaches this machine)}"
    docker rm -fv "$NAME" >/dev/null 2>&1 || true
    docker run -d --label burrow.ignore=true --name "$NAME" --cap-add NET_ADMIN -p "$PORT:51820/udp" "$IMAGE" sh -c '
      set -e
      apk add -q wireguard-tools-wg iproute2 busybox-extras >/dev/null
      umask 077
      wg genkey > /s.key; wg pubkey < /s.key > /s.pub
      wg genkey > /c.key; wg pubkey < /c.key > /c.pub
      ip link add wg0 type wireguard
      wg set wg0 listen-port 51820 private-key /s.key peer "$(cat /c.pub)" allowed-ips 10.99.0.2/32
      ip addr add 10.99.0.1/24 dev wg0
      ip link set wg0 up
      mkdir -p /www/api/android && echo "hello through the tunnel" > /www/index.html
      # The cache of the direct route, as Burrow serves it (DirectStore.sync).
      echo "{\"hosts\":[],\"from\":\"through the tunnel\"}" > /www/api/android/cache
      # Larger than a few TCP windows: a body cut short shows (the app update, a page).
      head -c 4194304 /dev/urandom > /www/big.bin && sha256sum /www/big.bin | cut -d" " -f1 > /www/big.sha
      # A page that redirects to the own loopback of the phone (?<port>): the tabs must not follow it.
      mkdir -p /www/cgi-bin
      cat > /www/cgi-bin/lure <<"EOS"
#!/bin/sh
printf "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:%s/\r\nContent-Length: 0\r\n\r\n" "$QUERY_STRING"
EOS
      chmod +x /www/cgi-bin/lure
      httpd -f -p 10.99.0.1:8080 -h /www &
      touch /ready
      wait' >/dev/null
    for _ in $(seq 1 60); do docker exec "$NAME" test -f /ready 2>/dev/null && break; sleep 0.5; done
    docker exec "$NAME" test -f /ready || { docker logs "$NAME"; exit 1; }
    cat <<EOF
[Interface]
PrivateKey = $(docker exec "$NAME" cat /c.key)
Address = 10.99.0.2/32

[Peer]
PublicKey = $(docker exec "$NAME" cat /s.pub)
Endpoint = $ENDPOINT:$PORT
AllowedIPs = 10.99.0.0/24
PersistentKeepalive = 25
EOF
    ;;
  *)
    echo "usage: $0 up <endpoint-host> | down" >&2
    exit 2
    ;;
esac
