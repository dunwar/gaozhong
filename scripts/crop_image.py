#!/usr/bin/env python
"""按 bbox 裁剪题目图 — ImageMagick 缺失时的兜底（Windows 开发机；生产 Docker 有 convert）。

用法: python crop_image.py <src> <x> <y> <w> <h> <out>
"""
import sys

import cv2
import numpy as np


def imread_unicode(path):
    # cv2.imread 在 Windows 下无法处理非 ASCII 路径，用 np.fromfile + imdecode 兜底
    try:
        data = np.fromfile(path, dtype=np.uint8)
        return cv2.imdecode(data, cv2.IMREAD_COLOR)
    except Exception:
        return None


def imwrite_unicode(path, img):
    ok, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 75])
    if not ok:
        return False
    try:
        buf.tofile(path)
        return True
    except Exception:
        return False


def main():
    if len(sys.argv) != 7:
        sys.exit(2)
    src = sys.argv[1]
    x, y, w, h = (int(v) for v in sys.argv[2:6])
    out = sys.argv[6]

    img = imread_unicode(src)
    if img is None:
        sys.exit(1)
    H, W = img.shape[:2]

    x1 = max(0, x)
    y1 = max(0, y)
    x2 = min(W, x + max(8, w))
    y2 = min(H, y + max(8, h))
    if x2 <= x1 or y2 <= y1:
        sys.exit(1)

    crop = img[y1:y2, x1:x2]
    if crop.shape[1] > 900:
        scale = 900 / crop.shape[1]
        crop = cv2.resize(crop, (900, max(1, int(crop.shape[0] * scale))), interpolation=cv2.INTER_AREA)

    sys.exit(0 if imwrite_unicode(out, crop) else 1)


if __name__ == '__main__':
    main()
