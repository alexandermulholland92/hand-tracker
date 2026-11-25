#!/bin/bash
# build-ffmpeg-ios.sh — the Cluster app's own ffmpeg on an iPhone, for a job's conversions there (this iPhone as a
# member of the cluster: ClusterMember.swift): FFmpeg 8.0 with x264, built for iPhones and for the simulator (64-bit
# ARM), each as one framework, ClusterFFmpeg.framework. In it, FFmpeg's ffmpeg tool as a function the app calls again
# and again (ios/ffmpeg/ht_ffmpeg.c: each run as if in a process of its own).
#   scripts/build-ffmpeg-ios.sh <out folder>        (on a Mac with Xcode; the iPhone build, build-iphone.yml)
# Writes <out>/ios-arm64/ClusterFFmpeg.framework and <out>/ios-arm64-simulator/ClusterFFmpeg.framework.
# (Nothing found by itself: only zlib, x264 and threads, which the ffmpeg tool needs, so each build is the same.)
# The sources: FFmpeg's release tarball (its SHA-256 checked) and x264's stable branch at a set commit (checked by git),
# kept in a cache folder (HT_FFMPEG_IOS_WORK, else ~/.cache/hand-tracker-ffmpeg-ios). Licences: FFmpeg with x264 is
# GPL-2.0-or-later: fine in the app (AGPL-3.0).
set -euo pipefail

OUT="$1"
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${HT_FFMPEG_IOS_WORK:-$HOME/.cache/hand-tracker-ffmpeg-ios}
FFMPEG=ffmpeg-8.0
FFMPEG_SHA=b2751fccb6cc4c77708113cd78b561059b6fa904b24162fa0be2d60273d27b8e
X264=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
MIN_IOS=15.0
JOBS=$(sysctl -n hw.ncpu)
mkdir -p "$WORK"
cd "$WORK"

if [ ! -f $FFMPEG.tar.xz ] || [ "$(shasum -a 256 $FFMPEG.tar.xz | cut -c1-64)" != $FFMPEG_SHA ]; then
  curl -fsSL --retry 3 -o $FFMPEG.tar.xz https://ffmpeg.org/releases/$FFMPEG.tar.xz
fi
[ "$(shasum -a 256 $FFMPEG.tar.xz | cut -c1-64)" = $FFMPEG_SHA ] || { echo "$FFMPEG.tar.xz isn't the one expected (its SHA-256 differs)."; exit 1; }
if [ ! -d x264-src/.git ] || [ "$(git -C x264-src rev-parse HEAD)" != $X264 ]; then
  rm -rf x264-src
  git init -q x264-src
  git -C x264-src fetch -q --depth 1 https://code.videolan.org/videolan/x264.git $X264
  git -C x264-src checkout -q FETCH_HEAD
fi
[ "$(git -C x264-src rev-parse HEAD)" = $X264 ] || { echo "x264 isn't the commit expected."; exit 1; }

# One slice: x264, then FFmpeg (its libraries, and the ffmpeg tool's own objects, as its own build makes them), then
# the framework: ht_ffmpeg.c with those, as one library that shows only ht_ffmpeg_*.
build_slice() {
  local sdk=$1 slice=$2 target
  if [ "$sdk" = iphonesimulator ]; then target=arm64-apple-ios$MIN_IOS-simulator; else target=arm64-apple-ios$MIN_IOS; fi
  local sysroot cc prefix flags
  sysroot=$(xcrun --sdk "$sdk" --show-sdk-path)
  cc=$(xcrun --sdk "$sdk" -f clang)
  prefix="$WORK/prefix-$slice"
  flags="-arch arm64 -target $target -isysroot $sysroot"
  rm -rf "$prefix"

  echo "== x264 for $slice"
  rm -rf "build-x264-$slice"
  cp -R x264-src "build-x264-$slice"
  (cd "build-x264-$slice" && CC="$cc" ./configure --host=aarch64-apple-darwin --sysroot="$sysroot" --prefix="$prefix" \
    --enable-static --enable-pic --disable-cli --disable-opencl \
    --extra-cflags="$flags" --extra-asflags="$flags" --extra-ldflags="$flags" > configure.log 2>&1 || { tail -40 configure.log; exit 1; }
   make -j"$JOBS" > make.log 2>&1 || { tail -40 make.log; exit 1; }
   make install > /dev/null)

  echo "== FFmpeg for $slice"
  rm -rf "build-ffmpeg-$slice"
  mkdir "build-ffmpeg-$slice"
  tar -xJf $FFMPEG.tar.xz -C "build-ffmpeg-$slice" --strip-components 1
  (cd "build-ffmpeg-$slice"
   # The ffmpeg tool as a function: its main, called by ht_ffmpeg.c in the library (where main is a function like
   # any other), and a way to ask a run to stop, as its own signal handler does (added to its own file, where that is).
   grep -Eq '^(static void )?sigterm_handler\(int sig\)$' fftools/ffmpeg.c || { echo "fftools/ffmpeg.c isn't as expected."; exit 1; }
   printf '\n/* The Cluster app (scripts/build-ffmpeg-ios.sh): a run asked to stop, as a signal would. */\nvoid ht_ffmpeg_tool_stop(void)\n{\n    sigterm_handler(SIGTERM);\n}\n' >> fftools/ffmpeg.c
   PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig" ./configure --prefix="$prefix" \
     --enable-cross-compile --target-os=darwin --arch=aarch64 --cc="$cc" --sysroot="$sysroot" \
     --extra-cflags="$flags -I$prefix/include" --extra-ldflags="$flags -L$prefix/lib" \
     --pkg-config=pkg-config --pkg-config-flags=--static \
     --enable-gpl --enable-libx264 --enable-pic --disable-autodetect --enable-pthreads --enable-zlib \
     --disable-doc --disable-ffplay --disable-ffprobe --disable-network --disable-avdevice --disable-debug \
     > configure.log 2>&1 || { tail -60 configure.log; tail -40 ffbuild/config.log; exit 1; }
   make -j"$JOBS" > make.log 2>&1 || { grep -E "error|Error" make.log | tail -40; tail -20 make.log; exit 1; }
   make install > /dev/null)

  echo "== ClusterFFmpeg.framework for $slice"
  local b="build-ffmpeg-$slice" libs objs fw
  "$cc" $flags -O2 -fPIC -I"$prefix/include" -c "$ROOT/ios/ffmpeg/ht_ffmpeg.c" -o "$b/ht_ffmpeg.o"
  objs=$(cd "$b" && find fftools -name '*.o' | sed "s|^|$b/|")
  libs=$(PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig" pkg-config --static --libs libavfilter libavformat libavcodec libswresample libswscale libavutil)
  printf '_ht_ffmpeg_init\n_ht_ffmpeg_run\n_ht_ffmpeg_cancel\n' > exports.txt
  fw="$OUT/$slice/ClusterFFmpeg.framework"
  rm -rf "$fw"
  mkdir -p "$fw"
  # shellcheck disable=SC2086
  "$cc" $flags -dynamiclib -install_name @rpath/ClusterFFmpeg.framework/ClusterFFmpeg \
    -Wl,-exported_symbols_list,exports.txt -Wl,-dead_strip \
    -o "$fw/ClusterFFmpeg" "$b/ht_ffmpeg.o" $objs $libs
  strip -x "$fw/ClusterFFmpeg"
  local platform=iPhoneOS
  [ "$sdk" = iphonesimulator ] && platform=iPhoneSimulator
  cat > "$fw/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key><string>en</string>
	<key>CFBundleExecutable</key><string>ClusterFFmpeg</string>
	<key>CFBundleIdentifier</key><string>com.handtracker.cluster.ffmpeg</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleName</key><string>ClusterFFmpeg</string>
	<key>CFBundlePackageType</key><string>FMWK</string>
	<key>CFBundleShortVersionString</key><string>8.0</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>CFBundleSupportedPlatforms</key><array><string>$platform</string></array>
	<key>MinimumOSVersion</key><string>$MIN_IOS</string>
</dict>
</plist>
PLIST
  echo "$(du -h "$fw/ClusterFFmpeg" | cut -f1) $fw"
}

build_slice iphoneos ios-arm64
build_slice iphonesimulator ios-arm64-simulator
