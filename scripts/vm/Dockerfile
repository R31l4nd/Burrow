# A throwaway virtual machine for the fresh-install test: QEMU with KVM, in
# a container so nothing is installed on this machine.
FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4
# Which of Burrow's images this is: an untagged one left behind by a build is found by it (scripts/gate.sh, leftovers).
LABEL burrow.image="vm"
RUN apt-get update \
 && apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils genisoimage openssh-client curl ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*
