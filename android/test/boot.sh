#!/usr/bin/env bash
# Starts a fresh API 35 emulator and keeps it running (the container is the
# emulator's lifetime). scripts/android-test.sh drives it with adb.
set -euo pipefail
mkdir -p "$ANDROID_AVD_HOME"
echo no | avdmanager create avd --force --name burrow-test --package 'system-images;android-35;google_apis;x86_64' --device pixel_6 > /scratch/avd.log 2>&1
exec emulator -avd burrow-test -no-window -no-audio -no-boot-anim -no-snapshot -wipe-data \
  -gpu swiftshader_indirect -accel on -memory 3072 -cores 2
