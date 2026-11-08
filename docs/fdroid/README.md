# F-Droid

The app builds from source with the Gradle wrapper in `android/` and only
free libraries (AndroidX, sshj, BouncyCastle, ZXing, UnifiedPush and
wireguard-go). Store texts (English and Dutch) and screenshots (English,
which F-Droid shows for Dutch too) are in
`android/fastlane/metadata/android/`, which F-Droid reads from the
repository.

To submit (a release tag `vX.Y.Z` is what F-Droid builds):

1. Fork [fdroiddata](https://gitlab.com/fdroid/fdroiddata) on GitLab.
2. Copy `docs/fdroid/io.github.r31l4nd.burrow.yml` (the repository's address and
   the latest release's version) to `metadata/`. Its
   toolchain (Node, Go, gomobile, NDK) is the one `android/Dockerfile` and
   `scripts/node.sh` build with; the gate's pins step
   (`scripts/fdroid-check.sh`) fails when they drift apart.
3. Check it: `fdroid lint io.github.r31l4nd.burrow` and `fdroid build -v -l io.github.r31l4nd.burrow`.
4. Open a merge request.

F-Droid signs its builds with its own key: an app installed from F-Droid
cannot be updated with an APK from a Burrow server, and the other way round.
