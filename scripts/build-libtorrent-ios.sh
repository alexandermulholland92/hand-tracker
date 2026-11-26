#!/bin/bash
# build-libtorrent-ios.sh — the Cluster app's own libtorrent on an iPhone, for a big download's pieces (the user,
# 2026-11-25: phones take pieces of a big download and send them to the device chosen to keep it), as the Android app's
# (scripts/build-libtorrent-android.js): libtorrent 2.0.16 with Boost 1.92's headers (no OpenSSL: its own crypto; no
# HTTPS trackers) and the part-runner both phone apps share (cluster/pieces-native), built for iPhones and for the
# simulator (64-bit ARM), each as one framework, ClusterPieces.framework (ios/pieces: its CMake project).
#   scripts/build-libtorrent-ios.sh <out folder>        (on a Mac with Xcode and CMake; the iPhone builds)
# Writes <out>/ios-arm64/ClusterPieces.framework and <out>/ios-arm64-simulator/ClusterPieces.framework.
# The sources: the same releases as Android's, their SHA-256 checked, kept in a cache folder (HT_LT_IOS_WORK, else
# ~/.cache/hand-tracker-libtorrent-ios). Licences: libtorrent BSD-3-Clause, Boost BSL-1.0: fine in the app (AGPL-3.0).
set -euo pipefail

OUT="$1"
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${HT_LT_IOS_WORK:-$HOME/.cache/hand-tracker-libtorrent-ios}
MIN_IOS=15.0
JOBS=$(sysctl -n hw.ncpu)
SRC="$WORK/src"
mkdir -p "$SRC"
cd "$SRC"

get() {
  local file=$1 url=$2 sha=$3
  if [ ! -f "$file" ] || [ "$(shasum -a 256 "$file" | cut -c1-64)" != "$sha" ]; then
    curl -fsSL --retry 3 -o "$file" "$url"
  fi
  [ "$(shasum -a 256 "$file" | cut -c1-64)" = "$sha" ] || { echo "$file isn't the one expected (its SHA-256 differs)."; exit 1; }
}
get libtorrent-rasterbar-2.0.16.tar.gz https://github.com/arvidn/libtorrent/releases/download/v2.0.16/libtorrent-rasterbar-2.0.16.tar.gz \
  8463b8d786141c3923dbf54ab34e5c3312af9913b591239cb0e30f66ead34b9b
get boost-1.92.0-b2-nodocs.tar.xz https://github.com/boostorg/boost/releases/download/boost-1.92.0/boost-1.92.0-b2-nodocs.tar.xz \
  ea7b982002cc9dfbe59b0b217b206f470dc75f3de0bb2973d844118934d82411
[ -f libtorrent-rasterbar-2.0.16/CMakeLists.txt ] || tar -xzf libtorrent-rasterbar-2.0.16.tar.gz
# (Boost: only its headers, all libtorrent needs since Boost 1.69)
[ -f boost-1.92.0/boost/version.hpp ] || tar -xJf boost-1.92.0-b2-nodocs.tar.xz boost-1.92.0/boost

build_slice() {
  local sdk=$1 slice=$2
  local build="$WORK/build-$slice" toolchain="$WORK/ios-$slice.cmake"
  rm -rf "$build"
  cat > "$toolchain" <<CMAKE
set(CMAKE_SYSTEM_NAME iOS)
set(CMAKE_OSX_SYSROOT $sdk)
set(CMAKE_OSX_ARCHITECTURES arm64)
set(CMAKE_OSX_DEPLOYMENT_TARGET $MIN_IOS)
set(CMAKE_MACOSX_BUNDLE OFF)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
CMAKE
  echo "== libtorrent for $slice"
  cmake -S "$ROOT/ios/pieces" -B "$build" -DCMAKE_TOOLCHAIN_FILE="$toolchain" -DCMAKE_BUILD_TYPE=Release -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    -DLT_SRC="$SRC/libtorrent-rasterbar-2.0.16" -DBOOST_INCLUDE="$SRC/boost-1.92.0" \
    -Dbuild_tests=OFF -Dbuild_examples=OFF -Dbuild_tools=OFF -Dpython-bindings=OFF -Dgnutls=OFF \
    -DCMAKE_DISABLE_FIND_PACKAGE_OpenSSL=ON -DCMAKE_DISABLE_FIND_PACKAGE_GnuTLS=ON -DCMAKE_DISABLE_FIND_PACKAGE_LibGcrypt=ON \
    > "$build.log" 2>&1 || { tail -60 "$build.log"; exit 1; }
  cmake --build "$build" --parallel "$JOBS" --target ClusterPieces >> "$build.log" 2>&1 ||
    { grep -E "error|Error" "$build.log" | tail -40; tail -20 "$build.log"; exit 1; }

  local fw="$OUT/$slice/ClusterPieces.framework"
  rm -rf "$fw"
  mkdir -p "$fw"
  cp "$build/ClusterPieces" "$fw/ClusterPieces"
  strip -x "$fw/ClusterPieces"
  local platform=iPhoneOS
  [ "$sdk" = iphonesimulator ] && platform=iPhoneSimulator
  cat > "$fw/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key><string>en</string>
	<key>CFBundleExecutable</key><string>ClusterPieces</string>
	<key>CFBundleIdentifier</key><string>com.handtracker.cluster.pieces</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleName</key><string>ClusterPieces</string>
	<key>CFBundlePackageType</key><string>FMWK</string>
	<key>CFBundleShortVersionString</key><string>2.0.16</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>CFBundleSupportedPlatforms</key><array><string>$platform</string></array>
	<key>MinimumOSVersion</key><string>$MIN_IOS</string>
</dict>
</plist>
PLIST
  echo "$(du -h "$fw/ClusterPieces" | cut -f1) $fw"
}

build_slice iphoneos ios-arm64
build_slice iphonesimulator ios-arm64-simulator
