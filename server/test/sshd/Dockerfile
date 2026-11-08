# Throwaway SSH server for the integration tests: OpenSSH with password and
# key login, tmux, and a user with a known password. Never deploy this.
FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4
# Which of Burrow's images this is: an untagged one left behind by a build is found by it (scripts/gate.sh, leftovers).
LABEL burrow.image="test-sshd"
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server tmux zip unzip git ripgrep sudo \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash tester \
 && echo 'tester:burrow-test-password' | chpasswd \
 && mkdir -p /run/sshd \
 && ssh-keygen -A \
 && echo 'tester ALL=(ALL) ALL' > /etc/sudoers.d/tester \
 && printf 'listen 80;\n' > /etc/burrowtest.conf && chmod 600 /etc/burrowtest.conf
COPY --chmod=755 docker /usr/local/bin/docker
# No systemd in a container: stand-ins for the units and their journal,
# which the test user may read as a member of the journal's group.
COPY --chmod=755 systemctl journalctl /usr/local/bin/
RUN groupadd -f systemd-journal && usermod -aG systemd-journal tester
# A Proxmox VE node's qm and pct, allowed to the test user through sudo
# without a password, as Burrow's guests list asks (server/src/proxmox).
COPY --chmod=755 qm pct /usr/local/bin/
RUN echo 'tester ALL=(root) NOPASSWD: /usr/local/bin/qm, /usr/local/bin/pct' > /etc/sudoers.d/tester-pve && chmod 440 /etc/sudoers.d/tester-pve
# Package updates (server/src/hosts/packages.ts): a local repository that
# offers newer builds of a few installed packages, two from a -security
# suite, so apt list --upgradable has something to say. Only this
# repository is in the lists; nothing from it can be installed.
RUN set -e; arch=$(dpkg --print-architecture); \
  mk() { d=/srv/burrow-repo/$1; suite=$2; shift 2; mkdir -p $d; : > $d/Packages; \
    for p in "$@"; do printf 'Package: %s\nVersion: %s+burrowtest1\nArchitecture: %s\nFilename: ./%s.deb\nSize: 1\nSHA256: %064d\nDescription: test\n\n' $p "$(dpkg-query -W -f='${Version}' $p)" $arch $p 0 >> $d/Packages; done; \
    printf 'Origin: Burrow test\nLabel: Burrow test\nSuite: %s\nCodename: %s\n' $suite $suite > $d/Release; }; \
  mk security trixie-security bash tar; mk updates trixie-updates gzip; \
  mv /etc/apt/sources.list.d/debian.sources /etc/apt/debian.sources.off; \
  printf 'deb [trusted=yes] file:/srv/burrow-repo/security ./\ndeb [trusted=yes] file:/srv/burrow-repo/updates ./\n' > /etc/apt/sources.list.d/burrow-test.list; \
  apt-get update
# PerSourcePenalties (OpenSSH 9.8+) would lock the test runner out for a
# while after the readiness probes and the deliberately failed logins.
RUN printf '%s\n' 'PasswordAuthentication yes' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' 'UsePAM yes' 'PerSourcePenalties no' > /etc/ssh/sshd_config.d/test.conf
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
