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

## MobileNet-SSD (OAK cameras' Find objects)

The object finder an OAK camera runs with *Find objects* on: MobileNet-SSD, trained on PASCAL
VOC, from the OpenVINO Open Model Zoo (`mobilenet-ssd`), compiled for OAK cameras by Luxonis
(`mobilenet-ssd_openvino_2021.4_5shave.blob`, as listed in depthai-python's examples). It isn't
part of Hand Tracker: the desktop app downloads it from Luxonis, checked against its published
checksum, the first time *Find objects* is turned on. Apache License 2.0
(<https://raw.githubusercontent.com/openvinotoolkit/open_model_zoo/master/LICENSE>).

## MediaPipe

MediaPipe Hands and MediaPipe Pose (`@mediapipe/hands`, `@mediapipe/pose`, installed from npm),
by Google, under the Apache License 2.0 (see each package's own licence file).

Sentry mode's "Ignore pets and animals" uses MediaPipe Tasks Vision (`@mediapipe/tasks-vision`,
installed from npm) and its EfficientDet-Lite0 object detector trained on COCO
(`models/efficientdet_lite0.tflite`, as published by Google for MediaPipe's object detector), both
by Google under the Apache License 2.0.

OAK cameras' 6-core hand models (`palm_detection_sh6.blob`, `hand_landmark_full_sh6.blob`,
`hand_landmark_lite_sh6.blob`, on this project's oak-models-1 release, downloaded with a checksum
the first time an OAK camera starts) are MediaPipe's palm detection (v0.8.5) and hand landmark
(v0.8.9) models by Google, under the Apache License 2.0, converted for the camera by
`scripts/build-oak-models.py`.
