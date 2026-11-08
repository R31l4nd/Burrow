# Installing Burrow

From a fresh Linux machine to a signed-in Burrow with its first host. About
fifteen minutes, most of it the first image build.

## 1. Docker

Any Linux with Docker Engine and Compose v2, plus `git`, `make` and
`openssl` (backups use the last two; on Debian or Ubuntu:
`sudo apt install git make openssl`). Docker's own install script is the
quickest way to Docker:

```sh
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"    # then log out and in again
docker compose version             # v2.x or newer
```

That runs a script from the internet as root, unchecked. The reviewed
route is a package repository whose packages are signed: Docker's own apt
repository (<https://docs.docker.com/engine/install/debian/>, with its
signing key), or your distribution's packages when they carry Compose v2.

## 2. Burrow

```sh
git clone https://github.com/R31l4nd/Burrow.git burrow
cd burrow
cp .env.example .env
```


In `.env`, set `BURROW_ORIGIN` to the address you will open Burrow on, for
example `https://burrow.home.example.com`. Passkeys are tied to this
hostname: pick it once. The other settings have sensible defaults; see
[DEPLOY.md](DEPLOY.md).

## 3. How you reach it

Burrow must be served over **https** (only `http://localhost` is exempt)
and must **not** be reachable from the internet. Choose one:

### A reverse proxy you already run

SWAG, Traefik, Caddy, nginx proxy manager... on a Docker network. Put that
network's name in `PROXY_NETWORK` and point the proxy at
`http://burrow:8080`, passing WebSocket upgrades (the terminal uses them).

**Set `TRUST_PROXY`** to that network's subnet, so Burrow sees each
device's own address:

```sh
# "proxy": your PROXY_NETWORK, when it is another name
docker network inspect proxy -f '{{(index .IPAM.Config 0).Subnet}}'   # e.g. 172.18.0.0/16
sed -i 's|^TRUST_PROXY=.*|TRUST_PROXY=172.18.0.0/16|' .env              # the subnet it printed
docker compose up -d --build
```

Without it every request seems to come from the proxy: ten wrong sign-in
attempts from any device (a guest, a forgotten script) then block sign-in
for everyone for 15 minutes, again and again, and the audit log shows only
the proxy's address.

#### SWAG

swag-auto-proxy can pick Burrow up from its labels, but only once you turn
that on (`SWAG_ENABLE=enable` in `.env`): most SWAG installations face the
internet, and Burrow must not. First make SWAG serve Burrow's name
(`SWAG_URL`, default `burrow.local.*`) to your LAN or VPN only, for example
with an allowlist that swag-auto-proxy puts into Burrow's server block
(its `swag_server_custom_directive` label):

```sh
cat > /path/to/swag/config/nginx/lan-only.conf <<'NGINX'
allow 192.168.0.0/16;   # your LAN
allow 10.0.0.0/8;       # your VPN
deny all;
NGINX
cat > compose.override.yaml <<'YAML'
services:
  burrow:
    labels:
      - swag_server_custom_directive=include /config/nginx/lan-only.conf;
YAML
echo SWAG_ENABLE=enable >> .env
docker compose up -d
```

Then check from outside (a phone on mobile data, Wi-Fi off) that Burrow's
address does not answer.

#### Traefik

Labels on Burrow in `compose.override.yaml`, with an allowlist so only your
LAN and VPN reach it (WebSockets pass by themselves):

```yaml
services:
  burrow:
    labels:
      - traefik.enable=true
      - traefik.http.routers.burrow.rule=Host(`burrow.home.example.com`)
      - traefik.http.routers.burrow.entrypoints=websecure
      - traefik.http.routers.burrow.tls=true
      - traefik.http.routers.burrow.middlewares=burrow-lan
      - traefik.http.middlewares.burrow-lan.ipallowlist.sourcerange=192.168.0.0/16,10.0.0.0/8
      - traefik.http.services.burrow.loadbalancer.server.port=8080
```

Use your entrypoint's name and certificate resolver where yours differ.

#### nginx

A server block of its own; the `map` belongs in the `http` block once:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl;
    server_name burrow.home.example.com;
    # ssl_certificate and ssl_certificate_key: your certificate
    allow 192.168.0.0/16;   # your LAN
    allow 10.0.0.0/8;       # your VPN
    deny all;
    location / {
        proxy_pass http://burrow:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;
    }
}
```

Keep `Host` as it is: Burrow refuses a change whose `Origin` is not its own
address.

#### Nginx Proxy Manager

Under *Access Lists*, add one that allows your LAN and VPN (for example
`192.168.0.0/16` and `10.0.0.0/8`) and denies the rest. Then a *Proxy
Host*: your name for Burrow, scheme `http`, forward hostname `burrow`, port
`8080`, *Websockets Support* on, that access list, and a certificate on its
SSL tab. Nginx Proxy Manager has to be on the `PROXY_NETWORK` network.

Apps: Burrow finds the apps behind any of these from their containers'
labels (homepage, Traefik, Caddy, SWAG) and from the proxy hosts of SWAG
and Nginx Proxy Manager (Containers -> Apps -> Find in containers).

### Caddy, just for Burrow

On a LAN, Caddy cannot get a public certificate by itself: its usual way
needs the machine reachable from the internet on ports 80 and 443, which
Burrow must not be. Use Caddy's own certificate authority (`tls internal`),
and publish the port on the machine's LAN address only:

```sh
docker network create proxy
cat > Caddyfile <<'CADDY'
burrow.home.example.com {
    tls internal
    reverse_proxy burrow:8080
}
CADDY
docker run -d --name caddy --restart unless-stopped --network proxy \
  -p 192.168.1.10:443:443 -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v caddy-data:/data caddy:2
docker compose up -d --build
```

Put the machine's LAN address in place of `192.168.1.10`, make
`burrow.home.example.com` point at it in your LAN's DNS, and set
`TRUST_PROXY` to the `proxy` network's subnet as above (then
`docker compose up -d`). Each device then
trusts Caddy's root certificate once
(`docker exec caddy cat /data/caddy/pki/authorities/local/root.crt`;
import it as a trusted CA). That is enough for browsers, not for the
Android app: like most apps it trusts only the certificate authorities
Android itself ships, not one imported as a user. For the app, use a
publicly trusted certificate; without opening the machine to the internet
that needs a DNS challenge (SWAG, or a Caddy build with your DNS provider's
module), which is beyond this guide.

### Just trying it

No proxy: Burrow listens on this machine's `127.0.0.1:8080` only, and you
open it through an SSH tunnel (browsers treat `http://localhost` as secure,
so passkeys work).

```sh
sed -i 's|^BURROW_ORIGIN=.*|BURROW_ORIGIN=http://localhost:8080|' .env
# Every later docker compose command (backups, upgrades) keeps the port this way.
echo COMPOSE_FILE=compose.yaml:compose.try.yaml >> .env
docker network create proxy
docker compose up -d --build
```

On your own computer: `ssh -L 8080:127.0.0.1:8080 you@that-machine`, then
open <http://localhost:8080>.

## 4. First sign-in

```sh
docker compose logs burrow
```

The log shows a one-time **setup token** (it changes on every restart until
setup is done). Open Burrow, enter the token, pick a user name, register a
passkey (or a password with an authenticator app), and keep the ten
recovery codes somewhere safe.

## 5. Your first host

*Hosts -> +*: a name, the address, the SSH user, and a password or a key
(*Settings -> Key vault* can generate one and install it on the host).
*Test* connects and asks you to confirm the host's key fingerprint once.
Hosts with Docker (the SSH user in the `docker` group) show up under
*Containers*.

To manage the machine Burrow runs on, add it as a host too: from inside
Burrow's container it is the Docker network's gateway (often `172.17.0.1`,
or `172.18.0.1` on the `proxy` network - `docker network inspect proxy`).

## 6. Backups

Burrow's state is its database and master key, in the data volume. Turn on
the encrypted daily backups:

```sh
(umask 077; openssl rand -base64 48 > secrets/backup_encryption_key)
mkdir -p backups
# The backup service runs as uid 1000: the key and the folder must be its.
# Private from the start (umask), then given to uid 1000: chmod after the
# chown would no longer be yours to run.
sudo chown 1000:1000 secrets/backup_encryption_key backups
echo COMPOSE_PROFILES=backup >> .env
docker compose up -d
make backup      # the first one now, then
make verify-backup FILE=backups/<the file it wrote>
```

Keep a copy of `secrets/backup_encryption_key` away from the backups, and
read [what to keep to recover](DEPLOY.md#what-to-keep-to-recover).
*Settings -> Backups* then shows each round, makes one on request and offers
the newest for download: compose.yaml mounts the backups folder into Burrow
read-only for that (the archive stays encrypted with the key above, which
Burrow does not have).

## 7. The Android app

Burrow builds its own APK, signed with a key of your own (see
[DEPLOY.md](DEPLOY.md#android-app)); then *Settings -> Android app* offers it
for download. A GitHub release may carry a ready APK too; the two cannot
update each other (different keys, DEPLOY.md says more). On the phone: install, enter Burrow's address, and pair with
a code from *Settings* on a signed-in device. The app needs Burrow on a
publicly trusted certificate (see the Caddy section above: a CA you import
on the phone is not trusted by apps). It runs on Android 10 or newer; on
Android 10 pairing and the direct route need a fingerprint set up on the
phone (from Android 11 the screen lock's PIN does too).

## Upgrading

Settings -> About updates Burrow in one step, the backup service
included. By hand, a backup first (`make backup`), then:

```sh
git pull
PKG_DATE=$(date +%F) docker compose up -d --build
```

`PKG_DATE` makes the backup image fetch today's Alpine packages (their
fixes) instead of reusing an old build's. Database migrations run at
start-up and only go forward. Read the CHANGELOG's `### Breaking` items
first, and see [DEPLOY.md](DEPLOY.md#upgrade-roll-back-recover) for going
back to the version before and for recovering on a new machine.
