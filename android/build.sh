#!/bin/sh
# Builds Weft Telefón into app/build/outputs/apk/release/app-release.apk (on asus: the Android SDK is in ~/Android/Sdk).
# Gets what is missing on its own: the SDK platform and build tools, and Gradle into ~/.cache/weft-gradle.
# One build without daemons and with a 1 GB heap (gradle.properties), so it leaves nothing running.
# `build.sh publish` also copies the APK to ~/matrix-spike/connect/state/weft-telefon.apk, where Weft offers it.
set -eu
cd "$(dirname "$0")"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
GRADLE_VERSION=8.10.2
GRADLE="$HOME/.cache/weft-gradle/gradle-$GRADLE_VERSION/bin/gradle"
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
[ -d "$ANDROID_HOME/platforms/android-35" ] && [ -d "$ANDROID_HOME/build-tools/35.0.0" ] ||
  yes | "$SDKMANAGER" --install "platforms;android-35" "build-tools;35.0.0" >/dev/null
if [ ! -x "$GRADLE" ]; then
  mkdir -p "$HOME/.cache/weft-gradle"
  curl -fsSL -o "$HOME/.cache/weft-gradle/gradle.zip" "https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"
  unzip -q -o "$HOME/.cache/weft-gradle/gradle.zip" -d "$HOME/.cache/weft-gradle"
  rm "$HOME/.cache/weft-gradle/gradle.zip"
fi
echo "sdk.dir=$ANDROID_HOME" > local.properties
nice -n 10 "$GRADLE" --no-daemon --console=plain -q assembleRelease
APK=app/build/outputs/apk/release/app-release.apk
ls -l "$APK"
if [ "${1:-}" = publish ]; then
  cp "$APK" "$HOME/matrix-spike/connect/state/weft-telefon.apk.new"
  mv "$HOME/matrix-spike/connect/state/weft-telefon.apk.new" "$HOME/matrix-spike/connect/state/weft-telefon.apk"
  echo "published to ~/matrix-spike/connect/state/weft-telefon.apk"
fi
