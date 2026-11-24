# A throwaway virtual machine for the fresh-install test: QEMU with KVM, in
# a container so nothing is installed on this machine.
FROM debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0
# Which of Burrow's images this is: an untagged one left behind by a build is found by it (scripts/gate.sh, leftovers).
LABEL burrow.image="vm"
RUN apt-get update \
 && apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils genisoimage openssh-client curl ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*
