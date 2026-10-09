# Builds the OAK camera hand models for more of the camera's cores (SHAVEs) than the 4 that
# geaxgx/depthai_hand_tracker's blobs use, from MediaPipe's own tflite models, with the same
# inputs, outputs and normalisation as those blobs (so HandTrackerEdge reads them unchanged):
#
#   palm_detection     MediaPipe v0.8.5 (geaxgx's: tag 0.8.0, the same 3877888 bytes), in BGR
#                      0-255, the model's RGB -1..1 made by the compiler
#   hand_landmark_*    MediaPipe v0.8.9 (geaxgx's: 18/10/2021, the same sizes), in BGR 0-255,
#                      the model's RGB 0..1 made by the compiler
#
# tflite -> ONNX (tf2onnx, planar input, outputs named as geaxgx's Model Optimizer named them)
# -> blob with Luxonis's blobconverter (OpenVINO 2021.4, as geaxgx's). Published on the
# oak-models-1 release; electron/oak.js FAST_MODELS downloads them, checked by SHA-256.
#
# Needs Python 3.11 with: tensorflow==2.15.1 tf2onnx==1.16.1 onnx==1.16.2 "numpy<2" blobconverter
#   python scripts/build-oak-models.py OUT_DIR [SHAVES...]     (SHAVES: 6 by default)
#
# On an OAK-D-PRO-W their outputs matched the 4-core blobs' exactly (the same camera frames into
# both), and 6 cores tracked fastest (8 were slower than 6: the models then wait for each other).
import os, shutil, subprocess, sys, urllib.request

import blobconverter
import onnx

MEDIAPIPE = "https://raw.githubusercontent.com/google/mediapipe/{tag}/mediapipe/modules/{path}"
MODELS = {
    # name: (tag, path, input, outputs renamed, Model Optimizer's normalisation)
    "palm_detection": ("v0.8.5", "palm_detection/palm_detection.tflite", "input", {},
                       ["--mean_values=[127.5,127.5,127.5]", "--scale_values=[127.5,127.5,127.5]", "--reverse_input_channels"]),
    "hand_landmark_full": ("v0.8.9", "hand_landmark/hand_landmark_full.tflite", "input_1",
                           {"Identity": "Identity_dense/BiasAdd/Add", "Identity_3": "Identity_3_dense/BiasAdd/Add"},
                           ["--scale_values=[255.0,255.0,255.0]", "--reverse_input_channels"]),
    "hand_landmark_lite": ("v0.8.9", "hand_landmark/hand_landmark_lite.tflite", "input_1",
                           {"Identity": "Identity_dense/BiasAdd/Add", "Identity_3": "Identity_3_dense/BiasAdd/Add"},
                           ["--scale_values=[255.0,255.0,255.0]", "--reverse_input_channels"]),
}


def to_onnx(work, name, tag, path, inp, rename):
    tfl = os.path.join(work, name + ".tflite")
    if not os.path.isfile(tfl):
        urllib.request.urlretrieve(MEDIAPIPE.format(tag=tag, path=path), tfl)
    raw = os.path.join(work, name + "_raw.onnx")
    subprocess.run([sys.executable, "-m", "tf2onnx.convert", "--tflite", tfl, "--output", raw, "--opset", "11",
                    "--inputs-as-nchw", inp], check=True, capture_output=True)
    m = onnx.load(raw)
    for old, new in rename.items():
        for node in m.graph.node:
            node.output[:] = [new if o == old else o for o in node.output]
            node.input[:] = [new if i == old else i for i in node.input]
            if new in node.output:
                node.name = new
        for o in m.graph.output:
            if o.name == old:
                o.name = new
    onnx.checker.check_model(m)
    out = os.path.join(work, name + ".onnx")
    onnx.save(m, out)
    return out


def main():
    out_dir = sys.argv[1]
    shaves = [int(s) for s in sys.argv[2:]] or [6]
    work = os.path.join(out_dir, "work")
    os.makedirs(work, exist_ok=True)
    for name, (tag, path, inp, rename, norm) in MODELS.items():
        model = to_onnx(work, name, tag, path, inp, rename)
        for n in shaves:
            blob = blobconverter.from_onnx(model=model, data_type="FP16", shaves=n, version="2021.4",
                                           optimizer_params=norm, compile_params=["-ip U8"],
                                           output_dir=os.path.join(work, "blobs"), use_cache=False)
            dest = os.path.join(out_dir, f"{name}_sh{n}.blob")
            shutil.copyfile(blob, dest)
            print(dest, os.path.getsize(dest))


if __name__ == "__main__":
    main()
