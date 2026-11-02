#!/bin/bash
# Builds the Kinect for Xbox 360's helper (kinect360-helper.cpp) for this computer: on Linux
# kinect/bin/linux-<arch>/kinect360-helper for its processor; on a Mac kinect/bin/mac-arm64/ and
# kinect/bin/mac-x64/kinect360-helper (Apple silicon and Intel, each built on its own). libfreenect
# at a fixed release (with its audio, for the Kinect's microphones), linked in with libusb and
# TurboJPEG (on a Mac both built here too, for each processor), so the helper needs nothing on the
# computer beyond what every Linux desktop has (libc, libudev) or a Mac has. GitHub's Linux job runs
# it on an Intel and an ARM computer, and its Mac job on a Mac (.github/workflows/build-apps.yml).
#
#   kinect/build-kinect360.sh [--work DIR]
#
# Needs: a C/C++ compiler, cmake, git; on Linux libusb-1.0's and TurboJPEG's headers (Debian:
# libusb-1.0-0-dev libturbojpeg0-dev libudev-dev); on a Mac autoconf, automake, libtool (Homebrew).
set -euo pipefail

LIBFREENECT_COMMIT=09a1f098040d00e6070c18174904547ec31d2774 # v0.7.5
LIBUSB_COMMIT=d52e355daa09f17ce64819122cb067b8a2ee0d4b # v1.0.27 (Mac)
LIBJPEG_TURBO_COMMIT=f29eda648547b36aa594c4116c7764a6c8a079b9 # 3.0.4 (Mac)

here="$(cd "$(dirname "$0")" && pwd)"
work="${TMPDIR:-/tmp}/kinect360-build"
while [ $# -gt 0 ]; do
  case "$1" in
    --work) work="$2"; shift ;;
    *) echo "Unknown option $1" >&2; exit 1 ;;
  esac
  shift
done
mkdir -p "$work"
jobs="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"

fetch() { # repo commit dir
  if [ ! -d "$3/.git" ]; then
    git clone -q "$1" "$3"
  fi
  git -C "$3" fetch -q origin "$2" 2>/dev/null || true
  git -C "$3" checkout -q -f "$2"
  git -C "$3" reset -q --hard "$2"
  git -C "$3" clean -q -fdx
  test "$(git -C "$3" rev-parse HEAD)" = "$2"
}
fetch https://github.com/OpenKinect/libfreenect.git "$LIBFREENECT_COMMIT" "$work/libfreenect"

# libfreenect (static) for one processor, against libusb found by CMake (or the given one).
freenect() { # build-dir install-dir [cmake args...]
  local build="$1" install="$2"
  shift 2
  rm -rf "$build"
  cmake -S "$work/libfreenect" -B "$build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    -DBUILD_AUDIO=ON -DBUILD_EXAMPLES=OFF -DBUILD_FAKENECT=OFF -DBUILD_C_SYNC=OFF -DBUILD_CPP=OFF -DBUILD_CV=OFF -DBUILD_PYTHON=OFF \
    -DBUILD_PYTHON2=OFF -DBUILD_PYTHON3=OFF -DBUILD_OPENNI2_DRIVER=OFF -DBUILD_REDIST_PACKAGE=OFF -DCMAKE_INSTALL_PREFIX="$install" "$@" > "$build.cmake.log"
  cmake --build "$build" -j "$jobs" > "$build.log"
  cmake --install "$build" > /dev/null
}

if [ "$(uname -s)" = Darwin ]; then
  fetch https://github.com/libusb/libusb.git "$LIBUSB_COMMIT" "$work/libusb"
  fetch https://github.com/libjpeg-turbo/libjpeg-turbo.git "$LIBJPEG_TURBO_COMMIT" "$work/libjpeg-turbo"
  (cd "$work/libusb" && ./bootstrap.sh > /dev/null 2>&1)
  for pair in arm64:arm64 x86_64:x64; do
    cpu="${pair%%:*}" name="${pair##*:}"
    prefix="$work/mac-$name"
    rm -rf "$prefix" "$work/libusb-$name"
    # libusb, static, for this processor.
    mkdir -p "$work/libusb-$name"
    (cd "$work/libusb-$name" && "$work/libusb/configure" --host="$cpu-apple-darwin" --prefix="$prefix" --disable-shared --enable-static \
      CC="clang -arch $cpu -mmacosx-version-min=11.0" > configure.log && make -j "$jobs" > make.log && make install > /dev/null)
    # TurboJPEG, static (without its hand-written SIMD, which needs NASM for Intel).
    rm -rf "$work/jpeg-$name"
    cmake -S "$work/libjpeg-turbo" -B "$work/jpeg-$name" -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES="$cpu" -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 \
      -DENABLE_SHARED=OFF -DENABLE_STATIC=ON -DWITH_SIMD=OFF -DWITH_TURBOJPEG=ON -DCMAKE_INSTALL_PREFIX="$prefix" > "$work/jpeg-$name.cmake.log"
    cmake --build "$work/jpeg-$name" -j "$jobs" > "$work/jpeg-$name.log"
    cmake --install "$work/jpeg-$name" > /dev/null
    # (libfreenect makes its shared library too, whatever BUILD_SHARED_LIBS says: with the static
    # libusb in it, that needs the frameworks libusb uses)
    freenect "$work/libfreenect-$name" "$prefix" -DCMAKE_OSX_ARCHITECTURES="$cpu" -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0 \
      -DLIBUSB_1_INCLUDE_DIR="$prefix/include/libusb-1.0" -DLIBUSB_1_LIBRARY="$prefix/lib/libusb-1.0.a" -DCMAKE_PREFIX_PATH="$prefix" \
      -DCMAKE_SHARED_LINKER_FLAGS="-framework IOKit -framework CoreFoundation -framework Security -lobjc"
    out="$here/bin/mac-$name"
    mkdir -p "$out"
    clang++ -arch "$cpu" -mmacosx-version-min=11.0 -O2 -std=c++17 -Wall -DKINECT360_WITH_AUDIO -I"$prefix/include" -I"$prefix/include/libfreenect" \
      "$here/kinect360-helper.cpp" -o "$out/kinect360-helper" "$prefix/lib/libfreenect.a" "$prefix/lib/libusb-1.0.a" "$prefix/lib/libturbojpeg.a" \
      -framework IOKit -framework CoreFoundation -framework Security -lobjc
    strip "$out/kinect360-helper"
    echo "Built $out/kinect360-helper ($cpu)"
    otool -L "$out/kinect360-helper" | sed 's/^/  /'
    # (the processor this Mac is runs its own check; the other's, through Rosetta where it has it)
    if [ "$(uname -m)" = "$cpu" ] || arch -x86_64 /usr/bin/true 2>/dev/null; then
      if [ "$(uname -m)" = "$cpu" ]; then run=("$out/kinect360-helper"); else run=(arch -x86_64 "$out/kinect360-helper"); fi
      "${run[@]}" --check | strings | head -1
      "${run[@]}" --selftest | grep -a -q '"ok":true'
    fi
  done
  exit 0
fi

case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "Not a 64-bit Intel or ARM computer" >&2; exit 1 ;;
esac
triplet="$(gcc -dumpmachine)"
freenect "$work/libfreenect-build" "$work/libfreenect-install"
# A library linked in when there's a static copy of it, else from the computer.
lib() { # name (as in lib<name>.a)
  for d in "/usr/lib/$triplet" /usr/lib /usr/local/lib; do
    if [ -f "$d/lib$1.a" ]; then echo "$d/lib$1.a"; return; fi
  done
  echo "-l$1"
}
inst="$work/libfreenect-install"
out="$here/bin/linux-$arch"
mkdir -p "$out"
g++ -O2 -std=c++17 -Wall -Wno-unused-result -DKINECT360_WITH_AUDIO -I"$inst/include" -I"$inst/include/libfreenect" -I/usr/include/libusb-1.0 \
  "$here/kinect360-helper.cpp" -o "$out/kinect360-helper" "$(ls "$inst"/lib*/libfreenect.a | head -1)" "$(lib usb-1.0)" "$(lib turbojpeg)" \
  -l:libudev.so.1 -lpthread -ldl -lrt -lm -L"/usr/lib/$triplet" -static-libstdc++ -static-libgcc -Wl,--as-needed
strip "$out/kinect360-helper"
echo "Built $out/kinect360-helper"
ldd "$out/kinect360-helper" | sed 's/^/  /'
"$out/kinect360-helper" --check | strings | head -1
"$out/kinect360-helper" --selftest | grep -a -q '"ok":true'
