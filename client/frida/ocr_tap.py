#!/usr/bin/env python3
"""OCR screenshot tapper for the Idoly Pride E2E drive.

Usage:
  python3 ocr_tap.py                 # just OCR + print detected text/boxes
  python3 ocr_tap.py --tap TEXT ...  # tap center of first box whose text contains any TEXT
  python3 ocr_tap.py --tap TEXT --wait N   # poll up to N seconds for TEXT then tap

Uses rapidocr_onnxruntime on an `adb exec-out screencap -p` PNG.
"""
import subprocess, sys, time, argparse, io
import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

SERIAL = None  # default device
_ocr = RapidOCR()


def screencap() -> np.ndarray:
    cmd = ["adb"]
    if SERIAL:
        cmd += ["-s", SERIAL]
    cmd += ["exec-out", "screencap", "-p"]
    png = subprocess.run(cmd, capture_output=True).stdout
    img = Image.open(io.BytesIO(png)).convert("RGB")
    return np.array(img)


def run_ocr(img):
    res, _ = _ocr(img)
    out = []
    if res:
        for box, text, conf in res:
            try:
                conf = float(conf)
            except Exception:
                conf = 0.0
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            cx, cy = int(sum(xs) / 4), int(sum(ys) / 4)
            out.append({"text": text, "cx": cx, "cy": cy, "conf": conf})
    return out


def tap(x, y):
    cmd = ["adb"]
    if SERIAL:
        cmd += ["-s", SERIAL]
    cmd += ["shell", "input", "tap", str(x), str(y)]
    subprocess.run(cmd)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tap", nargs="*", default=None)
    ap.add_argument("--wait", type=float, default=0)
    ap.add_argument("--interval", type=float, default=3.0)
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    deadline = time.time() + args.wait
    while True:
        img = screencap()
        items = run_ocr(img)
        hits = []
        if args.tap:
            for it in items:
                if any(t.lower() in it["text"].lower() for t in args.tap):
                    hits.append(it)
        print(f"# {len(items)} boxes; {len(hits)} tap-hits")
        for it in items:
            print(f"  [{it['conf']:.2f}] ({it['cx']:4d},{it['cy']:4d}) {it['text']!r}")
        if hits and not args.dry:
            it = hits[0]
            print(f"TAP {it['text']!r} @ ({it['cx']},{it['cy']})")
            tap(it["cx"], it["cy"])
            return 0
        if time.time() >= deadline:
            print("no tap target within wait window")
            return 1
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
