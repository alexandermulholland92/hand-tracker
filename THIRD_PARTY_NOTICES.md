# Third-party notices

Hand Tracker is licensed under the GNU AGPL v3.0 (see [LICENSE](LICENSE)). It includes, or is
adapted from, the following work under other licences, whose notices are kept here.

## depthai_hand_tracker

<https://github.com/geaxgx/depthai_hand_tracker>, by geaxgx. MIT licence.

- `oak/`: the Luxonis OAK camera tracking code (`HandTrackerEdge.py`, `HandTrackerBpfEdge.py`,
  `mediapipe_utils.py`, `FPS.py`, `template_manager_script_*.py`), copied from that repository
  (one unused import removed from `HandTrackerEdge.py` for NumPy 2, and a call added at the end
  of each pipeline for Hand Tracker's own additions). The camera models it uses are downloaded
  from the same repository during the OAK setup.
- Adapted from it: far-away hands (`far-hands.js`, after its Body Pre Focusing), the hand
  mouse's jitter filter and gesture actions (`pc-control.js`, after its `HandController` and
  mouse example), finger counting (Two, Three, Four), averaging handedness over a hand's
  track, and the real-size 3D view.

```
MIT License

Copyright (c) [2021] [geax]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## YOLOv8 (OAK cameras' Find objects, and the app's object finder)

The object finder an OAK camera runs with *Find objects* on: YOLOv8 nano by Ultralytics
(`yolov8n.pt`, trained on COCO), trained further for this app on more pictures of animals
(animals7: open collections of camera-trap and wildlife pictures, and the user's own), under the
GNU Affero General Public License v3.0 (<https://github.com/ultralytics/ultralytics/blob/main/LICENSE>).
Hand Tracker's `scripts/yolo-blob.py` makes it into the camera's model (its last layer as
Luxonis's luxonis/tools make it for depthai, Apache License 2.0), compiled with Luxonis's
blobconverter. It isn't part of the app: the desktop app downloads it from this project's
oak-models-3 release, checked against its checksum, the first time *Find objects* is turned on.

The app's own object finder (Sentry mode's animals on cameras that don't find objects themselves)
runs the same model, as Ultralytics' own exporter makes it for ONNX (`animals7.onnx`, its kinds in
`models/kinds.js`), under the same licence. It isn't part of the apps either: they download it
from this project's sentry-models-2 release, checked against its checksum, the first time it's
wanted. ONNX Runtime Web runs it (below).

## SSDLite with MobileNetV3 (Sentry mode's second look)

Sentry mode's second look (`nightlook5.onnx`, on this project's sentry-models-2 release,
downloaded with a checksum the first time it's wanted) is torchvision's SSDLite320 with a
MobileNetV3-Large backbone, from its COCO weights, trained further for this app to find people
and animals in black-and-white pictures. torchvision is by the PyTorch team under the BSD 3-Clause
licence (<https://github.com/pytorch/vision/blob/main/LICENSE>). ONNX Runtime Web runs it (below).

## MediaPipe

MediaPipe Hands and MediaPipe Pose (`@mediapipe/hands`, `@mediapipe/pose`, installed from npm),
by Google, under the Apache License 2.0 (see each package's own licence file). The Chrome
extension's copy of MediaPipe Hands is modified: in `hands_solution_wasm_bin.js` and
`hands_solution_simd_wasm_bin.js`, three of Emscripten's embind functions (`createNamedFunction`,
`craftInvokerFunction`, `__emval_get_method_caller`) are replaced by `scripts/build-extension.js`
with equivalents that don't evaluate code from text, which Chrome extensions may not do.

A Kinect's bodies use MediaPipe Tasks Vision (`@mediapipe/tasks-vision`, installed from npm) and
its pose and face landmarkers (`models/pose_landmarker_lite.task`, `models/face_landmarker.task`,
as published by Google), both by Google under the Apache License 2.0.

OAK cameras' 6-core hand models (`palm_detection_sh6.blob`, `hand_landmark_full_sh6.blob`,
`hand_landmark_lite_sh6.blob`, on this project's oak-models-1 release, downloaded with a checksum
the first time an OAK camera starts) are MediaPipe's palm detection (v0.8.5) and hand landmark
(v0.8.9) models by Google, under the Apache License 2.0, converted for the camera by
`scripts/build-oak-models.py`.

## ONNX Runtime Web

`onnxruntime-web` (installed from npm; its WebAssembly build: `ort.wasm.min.js`,
`ort-wasm-simd-threaded.mjs` and `.wasm`), by Microsoft, runs Sentry mode's object finder and second look. MIT licence.

```
MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## libfreenect and libfreenect2 (the Kinects' helpers)

The Kinect for Xbox 360's helper on Linux and the Mac (`kinect/kinect360-helper`, built by
`kinect/build-kinect360.sh`) has libfreenect 0.7.5 linked into it
(<https://github.com/OpenKinect/libfreenect>), and the Kinect for Xbox One's helper on Linux
(`kinect/kinect2-helper`, built by `kinect/build-linux.sh`) has libfreenect2 linked into it, at a
fixed commit with a small change of this project's (`kinect/libfreenect2.patch`)
(<https://github.com/OpenKinect/libfreenect2>). Both are by the OpenKinect Project, copyright (c)
2010 and (c) 2014 individual OpenKinect contributors (see each repository's CONTRIB file), and
offered under the Apache License 2.0 or the GNU General Public License 2.0; Hand Tracker uses them
under the Apache License 2.0 (<https://www.apache.org/licenses/LICENSE-2.0>).

## libusb

Both helpers have libusb 1.0 linked into them (<https://libusb.info>): on Linux the computer's own
static copy where it has one (Debian's and Ubuntu's `libusb-1.0-0-dev`), on the Mac v1.0.27, built
from its source by `kinect/build-kinect360.sh`. It's under the GNU Lesser General Public License
2.1 (<https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html>). The helpers' own source and the
scripts that build them are in `kinect/`, so either can be built again with a changed libusb.

## libjpeg-turbo (TurboJPEG)

Both helpers have libjpeg-turbo's TurboJPEG linked into them (<https://libjpeg-turbo.org>): on
Linux the computer's own static copy where it has one (`libturbojpeg0-dev`), on the Mac 3.0.4,
built from its source by `kinect/build-kinect360.sh`. This software is based in part on the work
of the Independent JPEG Group. TurboJPEG is under the Modified (3-clause) BSD License:

```
Copyright (C)2009-2023 D. R. Commander.  All Rights Reserved.
Copyright (C)2015 Viktor Szathmáry.  All Rights Reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

- Redistributions of source code must retain the above copyright notice,
  this list of conditions and the following disclaimer.
- Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.
- Neither the name of the libjpeg-turbo Project nor the names of its
  contributors may be used to endorse or promote products derived from this
  software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS",
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT HOLDERS OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

## GLFW

The Kinect for Xbox One's helper on Linux has GLFW 3.4 linked into it, for libfreenect2's depth
worked out with the graphics chip (<https://www.glfw.org>), built from its source by
`kinect/build-linux.sh`. zlib licence:

```
Copyright (c) 2002-2006 Marcus Geelnard

Copyright (c) 2006-2019 Camilla Löwy

This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would
   be appreciated but is not required.

2. Altered source versions must be plainly marked as such, and must not
   be misrepresented as being the original software.

3. This notice may not be removed or altered from any source
   distribution.
```

## Microsoft's Kinect software (not included)

None of Microsoft's Kinect software is part of Hand Tracker. On Windows the Kinects' helpers
(`kinect/KinectHelper.cs`, `kinect/Kinect360Helper.cs`) use Microsoft's Kinect for Windows
Runtime 2.0 or 1.8, which the person installs from Microsoft. On Linux and the Mac, a Kinect for
Xbox 360's audio firmware (Microsoft's `audios.bin`) is the person's own copy, chosen under its ⚙;
libfreenect's `src/fwfetcher.py` can take it out of Microsoft's Xbox 360 system update.
