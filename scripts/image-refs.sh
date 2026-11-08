# scripts/image-refs.sh - sourced: image_refs lists every image the
# repository pins (Dockerfiles, compose files, the scripts and test helpers),
# one per line. The gate checks them (pins), scripts/repin.sh refreshes them.
image_refs() {
  {
    git ls-files -co --exclude-standard -z '*Dockerfile' '*Dockerfile.*' | xargs -0 -r grep -hoE '^FROM +[^ ]+' | awk '{print $2}' | grep -E '[:/]'
    git ls-files -co --exclude-standard -z 'compose*.yaml' | xargs -0 -r grep -hoE '^[[:space:]]*image: +[^ $]+' | awk '{print $2}'
    grep -hoE '"?(node|mcr\.microsoft\.com/playwright):[0-9a-z][^" ]*' scripts/node.sh scripts/e2e.sh | tr -d '"'
    # The images the other scripts pin (Trivy, Go, the test helpers): their drift is noted too (A3-OPS-12).
    grep -hoE '[a-z0-9][a-z0-9./-]*:[0-9a-z][^@" ]*@sha256:[a-f0-9]{64}' scripts/*.sh android/test/*.sh server/test/sshd/*.sh
  } | grep -v ':local$' | sort -u
  # (:local images are built here from pinned bases, never pulled.)
}
