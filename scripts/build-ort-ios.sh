#!/bin/bash
# build-ort-ios.sh — the Cluster app's own ONNX Runtime on an iPhone, for the animal model's jobs there (this iPhone as a
# member of the cluster: ClusterMember.swift, phonetools.py): ONNX Runtime 1.27.0 (as the Android app's), built for
# iPhones and for the simulator (64-bit ARM), each as one framework, ClusterORT.framework: Microsoft's own iOS library
# with ios/ort/ht_ort.c, the app's Python's way in (ctypes), the only thing it shows.
#   scripts/build-ort-ios.sh <out folder>        (on a Mac with Xcode; the iPhone build, build-iphone.yml)
# Writes <out>/ios-arm64/ClusterORT.framework and <out>/ios-arm64-simulator/ClusterORT.framework.
# The library: Microsoft's NuGet package of ONNX Runtime (Microsoft.ML.OnnxRuntime), whose iOS part is the static
# library its iOS pod has (the pod's own download address no longer answers as itself), checked against the SHA-512
# NuGet publishes for it; kept in a cache folder (HT_ORT_IOS_WORK, else ~/.cache/hand-tracker-ort-ios). Licence: MIT.
set -euo pipefail

OUT="$1"
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${HT_ORT_IOS_WORK:-$HOME/.cache/hand-tracker-ort-ios}
VERSION=1.27.0
PKG=microsoft.ml.onnxruntime.$VERSION.nupkg
SHA512=AcPWohC2OuJDNSIJxbrkUdowJ6FVwxo2nXz0sLTOcHCVSBg0zab3jZuuMpq6wWa4d2KEmjdF6KsGsUvgRSihxg==
MIN_IOS=15.1 # (ONNX Runtime's own)
mkdir -p "$WORK"
cd "$WORK"

sum() { python3 -c 'import base64, hashlib, sys; print(base64.b64encode(hashlib.sha512(open(sys.argv[1], "rb").read()).digest()).decode())' "$1"; }
if [ ! -f "$PKG" ] || [ "$(sum "$PKG")" != "$SHA512" ]; then
  curl -fsSL --retry 3 -o "$PKG" "https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/$VERSION/$PKG"
fi
[ "$(sum "$PKG")" = "$SHA512" ] || { echo "$PKG isn't the one expected (its SHA-512 differs)."; exit 1; }
rm -rf nupkg xcf
mkdir nupkg xcf
unzip -q "$PKG" 'runtimes/ios/native/onnxruntime.xcframework.zip' 'build/native/include/*' -d nupkg
unzip -q nupkg/runtimes/ios/native/onnxruntime.xcframework.zip -d xcf
XCF=$(find xcf -maxdepth 3 -name onnxruntime.xcframework -type d | head -1)
[ -n "$XCF" ] || { echo "No onnxruntime.xcframework in the package."; exit 1; }

# The xcframework's library for iPhones (no variant) or for the simulator (its Info.plist says which folder).
library_of() {
  plutil -convert json -o - "$XCF/Info.plist" | python3 -c '
import json, sys
want = sys.argv[1]
for l in json.load(sys.stdin)["AvailableLibraries"]:
    if l.get("SupportedPlatform") == "ios" and l.get("SupportedPlatformVariant", "") == want and "arm64" in l.get("SupportedArchitectures", []):
        print(l["LibraryIdentifier"] + "/" + l["LibraryPath"])
        break
' "$1"
}

build_slice() {
  local sdk=$1 slice=$2 variant=$3 target
  if [ "$sdk" = iphonesimulator ]; then target=arm64-apple-ios$MIN_IOS-simulator; else target=arm64-apple-ios$MIN_IOS; fi
  local sysroot cc lib fw flags
  sysroot=$(xcrun --sdk "$sdk" --show-sdk-path)
  cc=$(xcrun --sdk "$sdk" -f clang)
  flags="-arch arm64 -target $target -isysroot $sysroot"
  lib="$XCF/$(library_of "$variant")/onnxruntime"
  [ -f "$lib" ] || { echo "No ONNX Runtime for $slice in the package ($lib)."; exit 1; }
  echo "== ClusterORT.framework for $slice (from $(lipo -info "$lib" 2>&1 | tail -1))"
  # shellcheck disable=SC2086
  "$cc" $flags -O2 -fPIC -I nupkg/build/native/include -c "$ROOT/ios/ort/ht_ort.c" -o "ht_ort-$slice.o"
  printf '_ht_ort_open\n_ht_ort_describe\n_ht_ort_run\n_ht_ort_output\n_ht_ort_release\n_ht_ort_free\n_ht_ort_close\n' > exports.txt
  fw="$OUT/$slice/ClusterORT.framework"
  rm -rf "$fw"
  mkdir -p "$fw"
  # (all of the library, as Microsoft's own packages link it: its parts register themselves as they load)
  # shellcheck disable=SC2086
  "$cc" $flags -dynamiclib -install_name @rpath/ClusterORT.framework/ClusterORT \
    -Wl,-exported_symbols_list,exports.txt -Wl,-dead_strip \
    -o "$fw/ClusterORT" "ht_ort-$slice.o" -Wl,-force_load,"$lib" -lc++ -lobjc -framework Foundation -weak_framework CoreML
  strip -x "$fw/ClusterORT"
  local platform=iPhoneOS
  [ "$sdk" = iphonesimulator ] && platform=iPhoneSimulator
  cat > "$fw/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key><string>en</string>
	<key>CFBundleExecutable</key><string>ClusterORT</string>
	<key>CFBundleIdentifier</key><string>com.handtracker.cluster.ort</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleName</key><string>ClusterORT</string>
	<key>CFBundlePackageType</key><string>FMWK</string>
	<key>CFBundleShortVersionString</key><string>$VERSION</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>CFBundleSupportedPlatforms</key><array><string>$platform</string></array>
	<key>MinimumOSVersion</key><string>$MIN_IOS</string>
</dict>
</plist>
PLIST
  echo "$(du -h "$fw/ClusterORT" | cut -f1) $fw"
}

build_slice iphoneos ios-arm64 ""
build_slice iphonesimulator ios-arm64-simulator simulator
