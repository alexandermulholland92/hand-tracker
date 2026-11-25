#!/bin/bash
# build-transmission-ios.sh — the Cluster app's own Transmission on an iPhone, for the cluster's downloads there (this
# iPhone as a member of the cluster: ClusterMember.swift, downloads.py), as the Android app's
# (scripts/build-transmission-android.js): Transmission's library (libtransmission 4.1.4) with curl 8.23.0 and mbedTLS
# 3.6.8, built for iPhones and for the simulator (64-bit ARM), each as one framework, ClusterTransmission.framework
# (ios/transmission: its CMake project and ht_transmission.cpp, the app's way in).
#   scripts/build-transmission-ios.sh <out folder>        (on a Mac with Xcode and CMake; the iPhone build, build-iphone.yml)
# Writes <out>/ios-arm64/ClusterTransmission.framework and <out>/ios-arm64-simulator/ClusterTransmission.framework.
# The sources: the same releases as Android's, their SHA-256 checked, kept in a cache folder (HT_TR_IOS_WORK, else
# ~/.cache/hand-tracker-transmission-ios). Licences: Transmission GPL-2.0-or-later (with the OpenSSL exception),
# curl's own (MIT-like), mbedTLS Apache-2.0: fine in the app (AGPL-3.0).
set -euo pipefail

OUT="$1"
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${HT_TR_IOS_WORK:-$HOME/.cache/hand-tracker-transmission-ios}
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
get mbedtls-3.6.8.tar.bz2 https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.8/mbedtls-3.6.8.tar.bz2 \
  bc54b818e87f49c0b3281dd85d24adaede0e63b4e822e3fbd49c005a38b9595b
get curl-8.23.0.tar.xz https://github.com/curl/curl/releases/download/curl-8_23_0/curl-8.23.0.tar.xz \
  8dadd7d2536a314f982ad05a651b713f426bf7d02cc2c76cffb9796f2218e6c5
get transmission-4.1.4.tar.xz https://github.com/transmission/transmission/releases/download/4.1.4/transmission-4.1.4.tar.xz \
  86e7aa020cdf64826447034bc85f4d3b7c848d8c0891d9dc9b9fddfb2c805d22
for d in mbedtls-3.6.8 curl-8.23.0 transmission-4.1.4; do
  [ -d "$d" ] || tar -xf "$d".tar.*
done

# (NAT-PMP's gateway lookup, in Transmission's own copy of libnatpmp, needs net/route.h, which the iOS SDK leaves out:
# the macOS SDK's, the same system's)
EXTRA="$WORK/include-extra"
mkdir -p "$EXTRA/net"
cp "$(xcrun --sdk macosx --show-sdk-path)/usr/include/net/route.h" "$EXTRA/net/route.h"

build_slice() {
  local sdk=$1 slice=$2
  local prefix="$WORK/prefix-$slice" build="$WORK/build-$slice" toolchain="$WORK/ios-$slice.cmake"
  rm -rf "$prefix" "$build"
  # (one toolchain file for all of it: Transmission's bundled libraries are CMake projects of their own, given it too)
  cat > "$toolchain" <<CMAKE
set(CMAKE_SYSTEM_NAME iOS)
set(CMAKE_OSX_SYSROOT $sdk)
set(CMAKE_OSX_ARCHITECTURES arm64)
set(CMAKE_OSX_DEPLOYMENT_TARGET $MIN_IOS)
# (their programs plain programs, not iOS apps: CMake makes any program an app for iOS unless told, and the bundled
# libraries install theirs, natpmpc and upnpc, as programs)
set(CMAKE_MACOSX_BUNDLE OFF)
set(CMAKE_C_FLAGS_INIT "-I$EXTRA")
set(CMAKE_CXX_FLAGS_INIT "-I$EXTRA")
list(APPEND CMAKE_FIND_ROOT_PATH "$prefix")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
CMAKE
  local common=(-DCMAKE_TOOLCHAIN_FILE="$toolchain" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix"
    -DCMAKE_PREFIX_PATH="$prefix" -DCMAKE_POSITION_INDEPENDENT_CODE=ON)
  local inc="$prefix/include" lib="$prefix/lib"

  echo "== mbedTLS for $slice"
  cmake -S mbedtls-3.6.8 -B "$build/mbedtls" "${common[@]}" -DENABLE_TESTING=OFF -DENABLE_PROGRAMS=OFF \
    -DUSE_SHARED_MBEDTLS_LIBRARY=OFF -DUSE_STATIC_MBEDTLS_LIBRARY=ON -DGEN_FILES=OFF > "$build-mbedtls.log" 2>&1 || { tail -40 "$build-mbedtls.log"; exit 1; }
  cmake --build "$build/mbedtls" --parallel "$JOBS" >> "$build-mbedtls.log" 2>&1 || { grep -E "error" "$build-mbedtls.log" | tail -30; exit 1; }
  cmake --install "$build/mbedtls" > /dev/null

  echo "== curl for $slice"
  cmake -S curl-8.23.0 -B "$build/curl" "${common[@]}" -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC_LIBS=ON -DBUILD_CURL_EXE=OFF \
    -DBUILD_LIBCURL_DOCS=OFF -DBUILD_MISC_DOCS=OFF -DENABLE_CURL_MANUAL=OFF -DBUILD_TESTING=OFF -DBUILD_EXAMPLES=OFF \
    -DCURL_USE_PKGCONFIG=OFF -DCURL_USE_MBEDTLS=ON -DCURL_USE_OPENSSL=OFF -DCURL_USE_LIBPSL=OFF -DUSE_LIBIDN2=OFF -DUSE_APPLE_IDN=OFF \
    -DCURL_USE_LIBSSH2=OFF -DCURL_BROTLI=OFF -DCURL_ZSTD=OFF -DCURL_ZLIB=OFF -DUSE_NGHTTP2=OFF -DCURL_DISABLE_LDAP=ON \
    -DCURL_CA_BUNDLE=none -DCURL_CA_PATH=none -DMBEDTLS_INCLUDE_DIR="$inc" -DMBEDTLS_LIBRARY="$lib/libmbedtls.a" \
    -DMBEDX509_LIBRARY="$lib/libmbedx509.a" -DMBEDCRYPTO_LIBRARY="$lib/libmbedcrypto.a" > "$build-curl.log" 2>&1 || { tail -60 "$build-curl.log"; exit 1; }
  cmake --build "$build/curl" --parallel "$JOBS" >> "$build-curl.log" 2>&1 || { grep -E "error" "$build-curl.log" | tail -30; exit 1; }
  cmake --install "$build/curl" > /dev/null

  echo "== Transmission for $slice"
  cmake -S "$ROOT/ios/transmission" -B "$build/transmission" "${common[@]}" -DTR_SRC="$SRC/transmission-4.1.4" \
    -DENABLE_DAEMON=OFF -DENABLE_GTK=OFF -DENABLE_QT=OFF -DENABLE_MAC=OFF -DENABLE_UTILS=OFF -DENABLE_CLI=OFF -DENABLE_TESTS=OFF \
    -DENABLE_NLS=OFF -DINSTALL_DOC=OFF -DINSTALL_WEB=OFF -DREBUILD_WEB=OFF -DRUN_CLANG_TIDY=OFF -DWITH_CRYPTO=mbedtls \
    -DWITH_SYSTEMD=OFF -DWITH_APPINDICATOR=OFF -DWITH_KQUEUE=OFF \
    -DUSE_SYSTEM_EVENT2=OFF -DUSE_SYSTEM_DEFLATE=OFF -DUSE_SYSTEM_DHT=OFF -DUSE_SYSTEM_MINIUPNPC=OFF -DUSE_SYSTEM_NATPMP=OFF \
    -DUSE_SYSTEM_UTP=OFF -DUSE_SYSTEM_B64=OFF -DUSE_SYSTEM_PSL=OFF \
    -DCURL_INCLUDE_DIR="$inc" -DCURL_LIBRARY="$lib/libcurl.a" \
    -DMBEDTLS_INCLUDE_DIR="$inc" -DMBEDTLS_LIBRARY="$lib/libmbedtls.a" -DMBEDCRYPTO_LIBRARY="$lib/libmbedcrypto.a" \
    > "$build-transmission.log" 2>&1 || { tail -60 "$build-transmission.log"; exit 1; }
  cmake --build "$build/transmission" --parallel "$JOBS" --target ClusterTransmission >> "$build-transmission.log" 2>&1 ||
    { grep -E "error|Error" "$build-transmission.log" | tail -40; tail -20 "$build-transmission.log"; exit 1; }

  local fw="$OUT/$slice/ClusterTransmission.framework"
  rm -rf "$fw"
  mkdir -p "$fw"
  cp "$build/transmission/ClusterTransmission" "$fw/ClusterTransmission"
  strip -x "$fw/ClusterTransmission"
  local platform=iPhoneOS
  [ "$sdk" = iphonesimulator ] && platform=iPhoneSimulator
  cat > "$fw/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key><string>en</string>
	<key>CFBundleExecutable</key><string>ClusterTransmission</string>
	<key>CFBundleIdentifier</key><string>com.handtracker.cluster.transmission</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleName</key><string>ClusterTransmission</string>
	<key>CFBundlePackageType</key><string>FMWK</string>
	<key>CFBundleShortVersionString</key><string>4.1.4</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>CFBundleSupportedPlatforms</key><array><string>$platform</string></array>
	<key>MinimumOSVersion</key><string>$MIN_IOS</string>
</dict>
</plist>
PLIST
  echo "$(du -h "$fw/ClusterTransmission" | cut -f1) $fw"
}

build_slice iphoneos ios-arm64
build_slice iphonesimulator ios-arm64-simulator
