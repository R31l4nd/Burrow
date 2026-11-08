# Burrow: one container with the API, the web app and (later) the language
# servers. npm workspaces: shared -> server + web.

# Node 24 on Debian 13 slim, pinned on digest (Debian 12 carried 52 HIGH or
# CRITICAL advisories without a fix there, A3-OPS-10). The same image runs the dev
# commands (scripts/node.sh); scripts/gate.sh checks that both agree.
FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
COPY e2e/package.json e2e/
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY web web
# A release's few sentences, shown under About (the same text F-Droid shows).
COPY android/fastlane/metadata/android android/fastlane/metadata/android
RUN npm run build

# Native tools for the editor: linters, formatters and two language servers.
# shfmt built from its source with the pinned Go: its release binaries are
# built with an older Go, whose advisories in net/http and crypto/tls made the
# image scan fail every few weeks (trivy, .trivyignore.yaml) although shfmt
# opens no connection. Built for the target on the build's own platform; the
# module's checksums are checked against Go's checksum database.
FROM --platform=$BUILDPLATFORM golang:1.27-bookworm@sha256:d9b6a1beb9474adc2a1ce842573639b44b2a0dd49b6669f51d3821baf9ec37c9 AS shfmt
ARG TARGETARCH
# renovate: datasource=github-releases depName=mvdan/sh extractVersion=^v(?<version>.+)$
ARG SHFMT_VERSION=3.14.1
RUN CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH:-amd64}" GOTOOLCHAIN=local GOFLAGS=-trimpath GOBIN= \
    go install -ldflags='-s -w' "mvdan.cc/sh/v3/cmd/shfmt@v${SHFMT_VERSION}" \
 && install -D -m 0755 "$(find /go/bin -type f -name shfmt)" /out/shfmt

# Downloaded at a fixed version and checked against a pinned SHA-256 per
# architecture; a changed file fails the build instead of shipping. Named
# with their licences in README.md (Third-party data and programs).
FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 AS tools
# Set by BuildKit for the platform being built (no default here: a default made arm64
# builds fetch amd64 tools, AUDIT2 OPS-01); amd64 only for the old builder.
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /t
# The versions, each with the comment Renovate reads (A3-OPS-12). A new
# version needs its SHA-256s below as well: until then the build fails.
# renovate: datasource=github-releases depName=hadolint/hadolint extractVersion=^v(?<version>.+)$
ARG HADOLINT_VERSION=2.15.1
# renovate: datasource=github-releases depName=astral-sh/ruff
ARG RUFF_VERSION=0.16.9
# renovate: datasource=github-releases depName=tamasfe/taplo
ARG TAPLO_VERSION=0.10.0
# renovate: datasource=github-releases depName=koalaman/shellcheck extractVersion=^v(?<version>.+)$
ARG SHELLCHECK_VERSION=0.11.0
RUN set -eu; \
  GH=https://github.com; \
  case "${TARGETARCH:-amd64}" in \
    amd64) \
      HADOLINT="$GH/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/hadolint-linux-x86_64 c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507"; \
      RUFF="$GH/astral-sh/ruff/releases/download/${RUFF_VERSION}/ruff-x86_64-unknown-linux-gnu.tar.gz 1bfbb819b5d4f9af501748862276b60e412d336034d99387691a4d4bce7a6f13"; \
      TAPLO="$GH/tamasfe/taplo/releases/download/${TAPLO_VERSION}/taplo-linux-x86_64.gz 8fe196b894ccf9072f98d4e1013a180306e17d244830b03986ee5e8eabeb6156"; \
      SHELLCHECK="$GH/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.x86_64.tar.xz 8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198" ;; \
    arm64) \
      HADOLINT="$GH/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/hadolint-linux-arm64 f6198ef8090f404dbb771abfee086eb8c48ac177f30da7fd3510aca35b344b5d"; \
      RUFF="$GH/astral-sh/ruff/releases/download/${RUFF_VERSION}/ruff-aarch64-unknown-linux-gnu.tar.gz a13061e8f471b49c9d2aa284c32dd54a0e5534d702d1a44e1d7f4c875569586d"; \
      TAPLO="$GH/tamasfe/taplo/releases/download/${TAPLO_VERSION}/taplo-linux-aarch64.gz 033681d01eec8376c3fd38fa3703c79316f5e14bb013d859943b60a07bccdcc3"; \
      SHELLCHECK="$GH/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.aarch64.tar.xz 12b331c1d2db6b9eb13cfca64306b1b157a86eb69db83023e261eaa7e7c14588" ;; \
    *) echo "unsupported architecture $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  fetch() { set -- $1; curl -fsSL -o "$(basename "$1")" "$1"; echo "$2  $(basename "$1")" | sha256sum -c -; }; \
  for spec in "$HADOLINT" "$RUFF" "$TAPLO" "$SHELLCHECK"; do fetch "$spec"; done; \
  mkdir -p /tools/bin; \
  install -m 0755 hadolint-linux-* /tools/bin/hadolint; \
  tar -xzf ruff-*.tar.gz --strip-components=1 -C /tools/bin; \
  gunzip -c taplo-linux-*.gz > /tools/bin/taplo && chmod 0755 /tools/bin/taplo; \
  tar -xJf shellcheck-*.tar.xz --strip-components=1 -C /tools/bin "shellcheck-v${SHELLCHECK_VERSION}/shellcheck"; \
  /tools/bin/shellcheck --version >/dev/null; /tools/bin/ruff --version >/dev/null; /tools/bin/taplo --version >/dev/null; /tools/bin/hadolint --version >/dev/null

# Production dependencies only, installed apart so the runtime image carries
# no compilers, test tools or bundlers.
FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS prod-deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
COPY e2e/package.json e2e/
RUN npm ci --omit=dev --no-audit --no-fund -w @burrow/server -w @burrow/shared

FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446
# Which of Burrow's images this is: an untagged one left behind by a build is found by it (scripts/gate.sh, leftovers).
LABEL burrow.image="app"
ENV NODE_ENV=production \
    BURROW_DATA_DIR=/data \
    PORT=8080
WORKDIR /app
COPY --from=prod-deps /app/node_modules node_modules
COPY --from=prod-deps /app/package.json ./
COPY --from=build /app/shared/package.json shared/
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/migrations server/migrations
COPY --from=build /app/server/assets server/assets
COPY --from=build /app/web/dist server/public
COPY --from=tools /tools/bin/ /usr/local/bin/
COPY --from=shfmt /out/shfmt /usr/local/bin/shfmt
# Debian's security fixes since the base image was made, and no npm, npx or
# corepack: Burrow never runs them, and the npm bundled with Node carried
# advisories of its own (brace-expansion, tar, undici). The node user
# (uid 1000) owns only the data directory. No setuid or setgid file (su,
# passwd, mount...): Burrow needs none, and they matter when the image runs
# without no-new-privileges (A3-OPS-10; the gate's image step checks it).
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
WORKDIR /app/server
CMD ["node", "dist/index.js"]
