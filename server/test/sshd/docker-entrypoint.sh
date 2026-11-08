#!/bin/sh
# Lets the test user use the mounted Docker socket (group of its owner).
set -e
# This machine's Docker through the tests' filter (server/test/sshd/docker-filter.mjs):
# the tests' own containers only, never the live ones (W-FUNC-17).
if [ -S /var/run/docker-filter/docker.sock ]; then ln -sf /var/run/docker-filter/docker.sock /var/run/docker.sock; fi
gid="$(stat -L -c %g /var/run/docker.sock)"
getent group "$gid" >/dev/null || groupadd -g "$gid" dockerhost
usermod -aG "$(getent group "$gid" | cut -d: -f1)" tester
# A password of the run's own when given: this sshd holds the Docker socket,
# and the image's password is in the repository (A3-OPS-16).
if [ -n "${TESTER_PASSWORD:-}" ]; then echo "tester:$TESTER_PASSWORD" | chpasswd; fi
exec /usr/sbin/sshd -D -e
