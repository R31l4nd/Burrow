# Build environment for the Android app: no Android Studio needed, runs on
# the server, reproducible. Same pins as the author's other Android project.
#
# Pinned by digest like the other images in this repo: a tag can be
# re-published, and then the "same" build would silently build something else.
FROM eclipse-temurin:21-jdk-noble@sha256:114cabb73033ca4ce7ceec3deb62396bc1b716282bae051ed3c1d82e38fcab2d
# Which of Burrow's images this is: an untagged one left behind by a build is found by it (scripts/gate.sh, leftovers).
LABEL burrow.image="android-build"

ENV ANDROID_SDK_ROOT=/opt/android-sdk \
    GRADLE_USER_HOME=/gradle \
    HOME=/gradle \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Despite `_latest` in the name this is a fixed build number (11076708).
# Google publishes only a SHA-1 for it (repository2-3.xml); the SHA-256 below
# was taken once from a download checked against that SHA-1 and the listed
# size. Changing the URL means establishing this value again.
ARG CMDLINE_TOOLS_URL=https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
ARG CMDLINE_TOOLS_SHA256=2d2d50857e4eb553af5a6dc3ad507a17adf43d115264b1afc116f95c92e5e258
RUN mkdir -p ${ANDROID_SDK_ROOT}/cmdline-tools \
 && curl -sSL -o /tmp/tools.zip "${CMDLINE_TOOLS_URL}" \
 && echo "${CMDLINE_TOOLS_SHA256}  /tmp/tools.zip" | sha256sum -c - \
 && unzip -q /tmp/tools.zip -d ${ANDROID_SDK_ROOT}/cmdline-tools \
 && mv ${ANDROID_SDK_ROOT}/cmdline-tools/cmdline-tools ${ANDROID_SDK_ROOT}/cmdline-tools/latest \
 && rm /tmp/tools.zip

ENV PATH=${PATH}:${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin

# Build tools 36.0.0: the version AGP 9.4 uses (else it fetches them at
# every build). sdkmanager checks every download against the checksum in its repository
# XML. platform-tools has no version in its name, but AGP fetches it on
# every build when it is missing, so it is fetched once here instead. The
# libraries that end up in the APK are pinned by hash in
# gradle/verification-metadata.xml.
RUN yes | sdkmanager --licenses > /dev/null \
 && sdkmanager --install "platforms;android-37.0" "build-tools;36.0.0" "platform-tools" > /dev/null

# Gradle publishes a SHA-256 next to each distribution; copied here, not
# fetched at build time (a checksum from the same place as the file checks
# nothing).
ARG GRADLE_VERSION=9.8.0
ARG GRADLE_SHA256=bafd5ce9cfaea0fbccfdc8439a1ac42fbd4cd9c89dc9a988228d8a2639a58e6c
RUN curl -sSL -o /tmp/gradle.zip "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" \
 && echo "${GRADLE_SHA256}  /tmp/gradle.zip" | sha256sum -c - \
 && unzip -q /tmp/gradle.zip -d /opt \
 && rm /tmp/gradle.zip \
 && ln -s /opt/gradle-${GRADLE_VERSION}/bin/gradle /usr/local/bin/gradle

# The app's own WireGuard (android/wg) is Go, bound to Kotlin with gomobile,
# compiled with the NDK. The NDK comes checksummed through sdkmanager; Go
# with the SHA-256 from go.dev/dl; gomobile and gobind by version through
# the module proxy (checked against sum.golang.org).
ARG NDK_VERSION=30.0.16248370
ARG GO_VERSION=1.27.2
ARG GO_SHA256=ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5
ARG GOMOBILE_VERSION=v0.0.0-20260908204917-8b95e45f8d3e
RUN sdkmanager --install "ndk;${NDK_VERSION}" > /dev/null \
 && curl -sSL -o /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
 && echo "${GO_SHA256}  /tmp/go.tgz" | sha256sum -c - \
 && tar -C /usr/local -xzf /tmp/go.tgz \
 && rm /tmp/go.tgz \
 && GOPATH=/opt/gotools GOBIN=/usr/local/bin /usr/local/go/bin/go install \
      golang.org/x/mobile/cmd/gomobile@${GOMOBILE_VERSION} golang.org/x/mobile/cmd/gobind@${GOMOBILE_VERSION} \
 && rm -rf /opt/gotools
ENV ANDROID_NDK_HOME=${ANDROID_SDK_ROOT}/ndk/${NDK_VERSION} \
    ANDROID_HOME=${ANDROID_SDK_ROOT} \
    PATH=${PATH}:/usr/local/go/bin \
    GOPATH=/gradle/go \
    GOFLAGS=-modcacherw \
    GOTOOLCHAIN=local

# Runs as the host user, so build output is not owned by root.
RUN mkdir -p /gradle /out && chmod -R 777 /gradle /out ${ANDROID_SDK_ROOT}

# The debug key in the gradle volume: Java's user.home comes from passwd
# (/home/ubuntu, gone with the container), so each build had a new one and
# a debug build could not update the one before (scripts/android-test.sh).
ENV ANDROID_USER_HOME=/gradle/.android

WORKDIR /project

CMD ["sh", "-lc", "gradle --no-daemon testDebugUnitTest assembleRelease && cp app/build/outputs/apk/release/app-release.apk /out/burrow.apk && echo 'APK: artifacts/burrow.apk'"]
