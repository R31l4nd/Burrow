# A throwaway virtual machine for the fresh-install test: QEMU with KVM, in
# a container so nothing is installed on this machine.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
# Which of Burrow's images this is: an untagged one left behind by a build is found by it (scripts/gate.sh, leftovers).
LABEL burrow.image="vm"
RUN apt-get update \
 && apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils genisoimage openssh-client curl ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*
