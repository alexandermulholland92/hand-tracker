#!/bin/bash
# get-ios-wheels.sh — NumPy and Pillow for the Cluster app's own Python on an iPhone (the animal model's jobs there:
# jobs_animals.py), as wheels built for iOS and for Python 3.13 (the app's: BeeWare's), for iPhones and the simulator
# (64-bit ARM); scripts/ios-variant.js --wheels puts them in the app.
#   scripts/get-ios-wheels.sh <out folder>
# NumPy: BeeWare's build for iOS (its package index, as BeeWare's own Briefcase uses; NumPy has none of its own);
# Pillow: its own, from PyPI. Each checked against its SHA-256. Licences: BSD (NumPy), MIT-CMU (Pillow).
set -euo pipefail

OUT="$1"
mkdir -p "$OUT"
cd "$OUT"
NUMPY=https://pypi.anaconda.org/beeware/simple/numpy/2.5.2.post1
PILLOW=https://files.pythonhosted.org/packages
while read -r sha url; do
  file=${url##*/}
  if [ ! -f "$file" ] || [ "$(shasum -a 256 "$file" | cut -c1-64)" != "$sha" ]; then
    curl -fsSL --retry 3 -o "$file" "$url"
  fi
  [ "$(shasum -a 256 "$file" | cut -c1-64)" = "$sha" ] || { echo "$file isn't the one expected (its SHA-256 differs)."; exit 1; }
  echo "$file"
done <<WHEELS
d451e3281b8e2709bb85c6857c83b3c1797f930971b6bbff7f57469d3958e16e $NUMPY/numpy-2.5.2.post1-cp313-cp313-ios_13_0_arm64_iphoneos.whl
154285250704dd82f8a5b53633eebe381f6eb56d232780291ac180e12a7ea0b1 $NUMPY/numpy-2.5.2.post1-cp313-cp313-ios_13_0_arm64_iphonesimulator.whl
e98b4f91f99b24b1da72e10621ba181f7281922384a7403094debb4199de6c00 $PILLOW/82/e2/9132d38df320e8099e2642d9fa538f18a7dfebf68a875a31725dc2a115aa/pillow-13.0.0-cp313-cp313-ios_13_0_arm64_iphoneos.whl
34fb3db1149c879343861831728c243c432d4a5afc8f1878ca7612ef8de2a033 $PILLOW/cb/be/436dac0996876f65ef1916ffb711c5ef4af2ebc57414b6f16642e07f6b47/pillow-13.0.0-cp313-cp313-ios_13_0_arm64_iphonesimulator.whl
WHEELS
