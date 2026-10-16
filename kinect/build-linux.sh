#!/bin/bash
# Builds kinect/bin/linux-<arch>/kinect2-helper (kinect2-helper.cpp) for this computer's processor:
# libfreenect2 at a fixed commit with kinect/libfreenect2.patch, and GLFW 3.4 for its OpenGL depth
# processing, both linked in (with libusb, TurboJPEG and the C++ library), so the helper needs
# nothing on the computer beyond what every Linux desktop has (libc, libudev, ALSA's libasound;
# GLFW finds X11 or Wayland, and OpenGL, as it runs). GitHub's Linux job runs it on an Intel
# and an ARM computer (.github/workflows/build-apps.yml).
#
#   kinect/build-linux.sh [--cpu-only] [--work DIR]
#
# Needs: a C++ compiler, cmake, git, pkg-config, and libusb-1.0, TurboJPEG, ALSA and udev's
# headers (Debian: libusb-1.0-0-dev libturbojpeg0-dev libasound2-dev libudev-dev); for OpenGL,
# X11's, Wayland's and xkbcommon's too (libx11-dev libxrandr-dev libxinerama-dev libxcursor-dev
# libxi-dev libwayland-dev libxkbcommon-dev wayland-protocols libgl-dev). SYSROOT=<dir>: headers
# and libraries unpacked there (apt-get download + dpkg-deb -x) rather than installed.
set -euo pipefail

LIBFREENECT2_COMMIT=fd64c5d9b214df6f6a55b4419357e51083f15d93
GLFW_COMMIT=7b6aead9fb88b3623e3b3725ebb42670cbe4c579 # 3.4

here="$(cd "$(dirname "$0")" && pwd)"
cpu_only=0
work="${TMPDIR:-/tmp}/kinect-build"
while [ $# -gt 0 ]; do
  case "$1" in
    --cpu-only) cpu_only=1 ;;
    --work) work="$2"; shift ;;
    *) echo "Unknown option $1" >&2; exit 1 ;;
  esac
  shift
done
case "$(uname -m)" in
  x86_64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "Not a 64-bit Intel or ARM computer" >&2; exit 1 ;;
esac
triplet="$(gcc -dumpmachine)"
jobs="$(nproc 2>/dev/null || echo 2)"
mkdir -p "$work"
rm -rf "$work/glfw-build" "$work/libfreenect2-build" # (a fresh start: nothing cached from a build before)
sysroot="${SYSROOT:-}"
cmake_extra=()
cflags=()
if [ -n "$sysroot" ]; then
  export PKG_CONFIG_SYSROOT_DIR="$sysroot"
  export PKG_CONFIG_PATH="$sysroot/usr/lib/$triplet/pkgconfig:$sysroot/usr/share/pkgconfig"
  export TurboJPEG_ROOT="$sysroot/usr"
  cflags+=("-I$sysroot/usr/include" "-I$sysroot/usr/include/$triplet")
  cmake_extra+=("-DCMAKE_C_FLAGS=-I$sysroot/usr/include" "-DCMAKE_CXX_FLAGS=-I$sysroot/usr/include" "-DCMAKE_INCLUDE_PATH=$sysroot/usr/include"
    "-DCMAKE_LIBRARY_PATH=$sysroot/usr/lib/$triplet")
  export PATH="$sysroot/usr/bin:$PATH" # (wayland-scanner, for GLFW)
  # (A -dev package's libfoo.so points at the computer's own libfoo.so.N, not unpacked there.)
  for so in "$sysroot/usr/lib/$triplet"/*.so; do
    if [ -L "$so" ] && [ ! -e "$so" ] && [ -e "/usr/lib/$triplet/$(readlink "$so")" ]; then ln -sf "/usr/lib/$triplet/$(readlink "$so")" "$so"; fi
  done
fi

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

# GLFW (static), for libfreenect2's OpenGL depth processing. (With a SYSROOT, installed into it,
# where its pkg-config file's paths point.)
glfw_root="$work/glfw-install"
if [ "$cpu_only" = 0 ]; then
  fetch https://github.com/glfw/glfw.git "$GLFW_COMMIT" "$work/glfw"
  prefix="$glfw_root"
  [ -n "$sysroot" ] && prefix=/opt/hand-tracker-glfw && glfw_root="$sysroot$prefix"
  cmake -S "$work/glfw" -B "$work/glfw-build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
    -DGLFW_BUILD_EXAMPLES=OFF -DGLFW_BUILD_TESTS=OFF -DGLFW_BUILD_DOCS=OFF -DGLFW_BUILD_X11=ON -DGLFW_BUILD_WAYLAND=ON \
    -DCMAKE_INSTALL_PREFIX="$prefix" "${cmake_extra[@]}" > "$work/glfw-cmake.log"
  cmake --build "$work/glfw-build" -j "$jobs" > "$work/glfw-build.log"
  DESTDIR="${sysroot}" cmake --install "$work/glfw-build" > /dev/null
  export PKG_CONFIG_PATH="$glfw_root/lib/pkgconfig:$glfw_root/lib64/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
fi

# libfreenect2 (static), patched.
fetch https://github.com/OpenKinect/libfreenect2.git "$LIBFREENECT2_COMMIT" "$work/libfreenect2"
git -C "$work/libfreenect2" apply "$here/libfreenect2.patch"
opengl=ON
[ "$cpu_only" = 1 ] && opengl=OFF
cmake -S "$work/libfreenect2" -B "$work/libfreenect2-build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
  -DENABLE_CXX11=ON -DENABLE_OPENGL=$opengl -DENABLE_OPENCL=OFF -DENABLE_CUDA=OFF -DENABLE_VAAPI=OFF -DENABLE_TEGRAJPEG=OFF \
  -DBUILD_EXAMPLES=OFF -DBUILD_OPENNI2_DRIVER=OFF -DCMAKE_INSTALL_PREFIX="$work/libfreenect2-install" "${cmake_extra[@]}" > "$work/libfreenect2-cmake.log"
cmake --build "$work/libfreenect2-build" -j "$jobs" > "$work/libfreenect2-build.log"
cmake --install "$work/libfreenect2-build" > /dev/null
if [ "$cpu_only" = 0 ] && ! grep -q "^#define LIBFREENECT2_WITH_OPENGL_SUPPORT" "$work/libfreenect2-install/include/libfreenect2/config.h"; then
  echo "libfreenect2 was built without OpenGL (see $work/libfreenect2-cmake.log)" >&2
  exit 1
fi

# A library linked in when there's a static copy of it, else from the computer.
lib() { # name (as in lib<name>.a)
  for d in "$sysroot/usr/lib/$triplet" "/usr/lib/$triplet" /usr/lib /usr/local/lib; do
    if [ -f "$d/lib$1.a" ]; then echo "$d/lib$1.a"; return; fi
  done
  echo "-l$1"
}
libs=("$work/libfreenect2-install/lib/libfreenect2.a")
includes=("-I$work/libfreenect2-install/include")
if [ "$cpu_only" = 0 ]; then
  glfw_lib="$(ls "$glfw_root"/lib*/libglfw3.a | head -1)"
  libs+=("$glfw_lib")
  includes+=("-I$glfw_root/include")
fi
libs+=("$(lib usb-1.0)" "$(lib turbojpeg)" -l:libudev.so.1 -l:libasound.so.2 -lpthread -ldl -lrt -lm)

out="$here/bin/linux-$arch"
mkdir -p "$out"
g++ -O2 -std=c++17 -Wall -Wno-unused-result "${cflags[@]}" "${includes[@]}" "$here/kinect2-helper.cpp" -o "$out/kinect2-helper" \
  "${libs[@]}" -L"/usr/lib/$triplet" -static-libstdc++ -static-libgcc -Wl,--as-needed
strip "$out/kinect2-helper"
echo "Built $out/kinect2-helper (OpenGL depth processing: $([ "$cpu_only" = 0 ] && echo yes || echo no))"
ldd "$out/kinect2-helper" | sed 's/^/  /'
"$out/kinect2-helper" --check | strings | head -1
"$out/kinect2-helper" --selftest | strings | head -1
