# Builds the OAK cameras' object finder (oak_bridge.py DETECT_MODEL) from a YOLOv8 model: COCO's
# YOLOv8 nano (Ultralytics, AGPL-3.0), or one trained further on more pictures. As Luxonis's
# tools (luxonis/tools, yolov8_exporter.py) make it for depthai's YoloDetectionNetwork, but for
# OpenVINO 2021.4 like the hands' models (one pipeline's models share a version; Luxonis's own
# yolov8n_coco_640x352.blob is 2022.1):
#
#   the Detect head swapped for one whose outputs depthai reads as YOLOv6 R2's: at each of the 3
#   scales, the box (its distances from the cell, after DFL), the best kind's score, then each
#   kind's (sigmoid)
#   -> ONNX (opset 12, 640 x 352 in, simplified) -> blob with Luxonis's blobconverter (FP16, the
#   picture in BGR 0-255, the model's RGB 0..1 made by the compiler)
#
# Published on the oak-models-2 release; electron/oak.js DETECT_MODEL downloads it, checked by
# SHA-256.
#
# Needs Python 3.12 with: torch ultralytics onnx onnxsim blobconverter
#   python scripts/yolo-blob.py OUT_DIR [MODEL.pt] [SHAVES]     (yolov8n.pt, 6 by default)
import os, shutil, sys

import blobconverter
import onnx
import onnxsim
import torch
import torch.nn as nn
import torch.nn.functional as F
from ultralytics import YOLO
from ultralytics.nn.modules import Detect

SIZE = (640, 352)  # w, h: the colour picture's shape (16:9) near enough, in multiples of 32
OUTPUTS = ["output1_yolov6r2", "output2_yolov6r2", "output3_yolov6r2"]


class DepthaiDetect(nn.Module):
    """YOLOv8's Detect head as depthai's YOLO decoding reads it (Luxonis's DetectV8, use_rvc2)."""

    def __init__(self, old):
        super().__init__()
        self.nc, self.nl, self.reg_max, self.stride = old.nc, old.nl, old.reg_max, old.stride
        self.cv2, self.cv3, self.f, self.i = old.cv2, old.cv3, old.f, old.i
        # DFL: each side's distance as the expected bin, a 1x1 convolution over the softmax
        self.proj = nn.Conv2d(self.reg_max, 1, 1, bias=False).requires_grad_(False)
        self.proj.weight.data[:] = torch.arange(self.reg_max, dtype=torch.float).view(1, self.reg_max, 1, 1)

    def forward(self, x):
        out = []
        for i in range(self.nl):
            box = self.cv2[i](x[i])
            b, _, h, w = box.shape
            box = box.view(b, 4, self.reg_max, h * w).permute(0, 2, 1, 3)
            box = self.proj(F.softmax(box, dim=1))[:, 0].reshape(b, 4, h, w)
            cls = self.cv3[i](x[i]).sigmoid()
            conf, _ = cls.max(1, keepdim=True)
            out.append(torch.cat([box, conf, cls], 1))
        return out


def to_onnx(work, weights):
    model = YOLO(weights).model.float().cpu().eval()
    model.fuse()
    if not isinstance(model.model[-1], Detect):
        raise SystemExit(f"{weights} isn't a detection model")
    model.model[-1] = DepthaiDetect(model.model[-1])
    names = model.names
    raw = os.path.join(work, "yolo_raw.onnx")
    torch.onnx.export(model, torch.zeros(1, 3, SIZE[1], SIZE[0]), raw, opset_version=12, do_constant_folding=True,
                      input_names=["images"], output_names=OUTPUTS, dynamo=False)
    m, ok = onnxsim.simplify(onnx.load(raw))
    if not ok:
        raise SystemExit("The simplified ONNX model couldn't be checked")
    out = os.path.join(work, "yolo.onnx")
    onnx.save(m, out)
    return out, [names[k] for k in sorted(names)]


def main():
    out_dir = sys.argv[1]
    weights = sys.argv[2] if len(sys.argv) > 2 else "yolov8n.pt"
    shaves = int(sys.argv[3]) if len(sys.argv) > 3 else 6
    work = os.path.join(out_dir, "work")
    os.makedirs(work, exist_ok=True)
    model, labels = to_onnx(work, weights)
    blob = blobconverter.from_onnx(model=model, data_type="FP16", shaves=shaves, version="2021.4",
                                   optimizer_params=["--scale_values=[255.0,255.0,255.0]", "--reverse_input_channels"],
                                   compile_params=["-ip U8"], output_dir=os.path.join(work, "blobs"), use_cache=False)
    name = os.path.splitext(os.path.basename(weights))[0].replace("yolov8n", "yolov8n_coco")
    dest = os.path.join(out_dir, f"{name}_{SIZE[0]}x{SIZE[1]}_2021.4_{shaves}shave.blob")
    shutil.copyfile(blob, dest)
    print(dest, os.path.getsize(dest))
    print(len(labels), "kinds:", ", ".join(labels))


if __name__ == "__main__":
    main()
