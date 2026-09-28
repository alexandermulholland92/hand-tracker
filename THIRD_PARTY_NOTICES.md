# Third-party notices

Hand Tracker is licensed under the GNU AGPL v3.0 (see [LICENSE](LICENSE)). It includes, or is
adapted from, the following work under other licences, whose notices are kept here.

## depthai_hand_tracker

<https://github.com/geaxgx/depthai_hand_tracker>, by geaxgx. MIT licence.

- `oak/`: the Luxonis OAK camera tracking code (`HandTrackerEdge.py`, `HandTrackerBpfEdge.py`,
  `mediapipe_utils.py`, `FPS.py`, `template_manager_script_*.py`), copied from that repository
  (one unused import removed from `HandTrackerEdge.py` for NumPy 2). The camera models it uses
  are downloaded from the same repository during the OAK setup.
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

## MediaPipe

MediaPipe Hands and MediaPipe Pose (`@mediapipe/hands`, `@mediapipe/pose`, installed from npm),
by Google, under the Apache License 2.0 (see each package's own licence file).
