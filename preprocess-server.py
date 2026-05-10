#!/usr/bin/env python3
"""
gaozhong.online — 试卷图片预处理微服务 v7
============================================
v7: 废除红笔符号检测和标注图生成，改为区域裁剪。
    用 PaddleOCR 检测文本区域 → 分组为题目块 → 检查各块有无红笔 → 裁剪输出

依赖: paddleocr, opencv-python, pillow, flask, numpy
端口: 5001
"""

import io
import sys
import base64
import traceback
import json
import numpy as np

from flask import Flask, request, jsonify
from PIL import Image

app = Flask(__name__)

# ========== 懒加载模型（首次调用时加载） ==========
_ocr_model = None
_paddle_ocr_available = False

def get_ocr():
    """懒加载 PaddleOCR 模型"""
    global _ocr_model, _paddle_ocr_available
    if _ocr_model is None:
        try:
            from paddleocr import PaddleOCR
            _ocr_model = PaddleOCR(use_angle_cls=True, lang='ch')
            _paddle_ocr_available = True
            print("[preprocess] PaddleOCR 模型加载成功", flush=True)
        except Exception as e:
            print(f"[preprocess] PaddleOCR 不可用: {e}，将仅做图像处理", flush=True)
            _ocr_model = None
    return _ocr_model


# ========== OpenCV 图像处理 ==========

def b64_to_cv2(b64_str):
    """base64 → OpenCV BGR (numpy array)"""
    # 去掉 data:image/xxx;base64, 前缀
    if ',' in b64_str:
        b64_str = b64_str.split(',', 1)[1]
    img_data = base64.b64decode(b64_str)
    np_arr = np.frombuffer(img_data, np.uint8)
    import cv2
    return cv2.imdecode(np_arr, cv2.IMREAD_COLOR)


def cv2_to_b64(img, fmt='.jpg', quality=90):
    """OpenCV BGR → base64 data URL"""
    import cv2
    _, buf = cv2.imencode(fmt, img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    b64 = base64.b64encode(buf).decode('utf-8')
    return f'data:image/jpeg;base64,{b64}'


def enhance_contrast(img):
    """对比度增强 — CLAHE 算法"""
    import cv2
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    l = clahe.apply(l)
    lab = cv2.merge([l, a, b])
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


def deskew_image(img):
    """透视矫正 — 检测试卷边缘并矫正"""
    import cv2
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # 找轮廓
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return img  # 没找到轮廓，返回原图

    # 取最大轮廓（试卷边界）
    largest = max(contours, key=cv2.contourArea)
    peri = cv2.arcLength(largest, True)
    approx = cv2.approxPolyDP(largest, 0.02 * peri, True)

    if len(approx) != 4:
        return img  # 不是四边形，不矫正

    # 排序四个角点：左上、右上、右下、左下
    pts = approx.reshape(4, 2)
    rect = np.zeros((4, 2), dtype=np.float32)
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]  # 左上
    rect[2] = pts[np.argmax(s)]  # 右下
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]  # 右上
    rect[3] = pts[np.argmax(diff)]  # 左下

    # 计算输出尺寸
    w1 = np.linalg.norm(rect[2] - rect[3])
    w2 = np.linalg.norm(rect[1] - rect[0])
    h1 = np.linalg.norm(rect[1] - rect[2])
    h2 = np.linalg.norm(rect[3] - rect[0])
    max_w = int(max(w1, w2))
    max_h = int(max(h1, h2))

    dst = np.array([
        [0, 0], [max_w - 1, 0],
        [max_w - 1, max_h - 1], [0, max_h - 1]
    ], dtype=np.float32)

    M = cv2.getPerspectiveTransform(rect, dst)
    return cv2.warpPerspective(img, M, (max_w, max_h))


def separate_red_ink(img):
    """分离红色笔迹（批改标记）— 增强版
    扩大 HSV 红色范围，覆盖深红/橙红/粉红，形态学膨胀使 × 更清晰
    """
    import cv2
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    # 红色范围 1：0-15°（含橙红），降低饱和度下限以捕捉浅色红笔
    lower_red1 = np.array([0, 30, 40])
    upper_red1 = np.array([15, 255, 255])
    # 红色范围 2：155-180°（含粉红/紫红），同样降低饱和度
    lower_red2 = np.array([155, 30, 40])
    upper_red2 = np.array([180, 255, 255])

    mask1 = cv2.inRange(hsv, lower_red1, upper_red1)
    mask2 = cv2.inRange(hsv, lower_red2, upper_red2)
    red_mask = cv2.bitwise_or(mask1, mask2)

    # 形态学：先闭运算（补空洞），再膨胀（让细线/× 更粗更清晰）
    kernel_close = np.ones((3, 3), np.uint8)
    red_mask = cv2.morphologyEx(red_mask, cv2.MORPH_CLOSE, kernel_close)
    kernel_dilate = np.ones((2, 2), np.uint8)
    red_mask = cv2.dilate(red_mask, kernel_dilate, iterations=1)

    # 提取红色部分到白底
    red_only = np.full_like(img, 255)  # 白底
    red_only[red_mask > 0] = img[red_mask > 0]

    return red_only, red_mask


def separate_blue_ink(img):
    """分离蓝色/黑色笔迹（学生手写作答）"""
    import cv2
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    # 蓝色范围（HSV）：100-140
    lower_blue = np.array([90, 30, 30])
    upper_blue = np.array([140, 255, 255])
    blue_mask = cv2.inRange(hsv, lower_blue, upper_blue)

    # 低饱和度（黑色/灰色）
    lower_black = np.array([0, 0, 0])
    upper_black = np.array([180, 50, 100])
    black_mask = cv2.inRange(hsv, lower_black, upper_black)

    # 合并蓝+黑
    answer_mask = cv2.bitwise_or(blue_mask, black_mask)

    # 排除红笔（已在红色遮罩中的）
    red_mask = cv2.inRange(hsv, np.array([0, 50, 50]), np.array([10, 255, 255]))
    red_mask2 = cv2.inRange(hsv, np.array([160, 50, 50]), np.array([180, 255, 255]))
    answer_mask = cv2.bitwise_and(answer_mask, cv2.bitwise_not(cv2.bitwise_or(red_mask, red_mask2)))

    answer_only = np.full_like(img, 255)
    answer_only[answer_mask > 0] = img[answer_mask > 0]

    return answer_only


def extract_layout(img):
    """PaddleOCR 版面分析 — 检测文本区域"""
    import cv2
    ocr = get_ocr()
    if ocr is None:
        print("[preprocess] PaddleOCR 未加载，跳过版面分析", flush=True)
        return None

    try:
        # BGR → RGB（PaddleOCR 3.x 可能需要 RGB 输入）
        img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        result = ocr.ocr(img_rgb, cls=False)
        if not result or not result[0]:
            print(f"[preprocess] PaddleOCR 无检测结果 | img shape={img.shape}, dtype={img.dtype}", flush=True)
            return []

        boxes = []
        for line in result[0]:
            bbox = line[0]  # [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
            text = line[1][0]
            confidence = line[1][1]

            # 取包围盒
            xs = [p[0] for p in bbox]
            ys = [p[1] for p in bbox]
            boxes.append({
                'x': int(min(xs)), 'y': int(min(ys)),
                'width': int(max(xs) - min(xs)),
                'height': int(max(ys) - min(ys)),
                'text': text,
                'confidence': round(float(confidence), 3)
            })

        return boxes
    except Exception as e:
        print(f"[preprocess] 版面分析失败: {e}", flush=True)
        return None


# ========== v7: 题目区域裁剪 ==========

def crop_question_regions(img, red_mask):
    """
    用 PaddleOCR 版面分析定位题目区域，检查各区域是否有红笔，裁剪输出。
    返回: [{ bbox: [x,y,w,h], has_red: bool, red_ratio: float, base64: str }]
    """
    import cv2
    layout = extract_layout(img)

    # 如果 PaddleOCR 不可用，回退到均匀切片
    if not layout:
        print("[preprocess] PaddleOCR 未加载，使用均匀切片", flush=True)
        return fallback_grid_crop(img, red_mask)

    # 按 Y 坐标分组文本块 → 题目区域
    blocks = sorted(layout, key=lambda b: b['y'])
    groups = []
    current = None
    GAP_THRESHOLD = 30  # Y 间距阈值

    for b in blocks:
        if b['confidence'] < 0.3:
            continue
        if not current:
            current = {'y_min': b['y'], 'y_max': b['y'] + b['height'],
                       'x_min': b['x'], 'x_max': b['x'] + b['width']}
        elif abs(b['y'] - current['y_max']) < GAP_THRESHOLD:
            current['y_max'] = max(current['y_max'], b['y'] + b['height'])
            current['x_min'] = min(current['x_min'], b['x'])
            current['x_max'] = max(current['x_max'], b['x'] + b['width'])
        else:
            groups.append(current)
            current = {'y_min': b['y'], 'y_max': b['y'] + b['height'],
                       'x_min': b['x'], 'x_max': b['x'] + b['width']}
    if current:
        groups.append(current)

    # 为每个区域添加 padding，裁剪，检查红笔
    h, w = img.shape[:2]
    regions = []
    for g in groups:
        pad = 8
        x1 = max(0, g['x_min'] - pad)
        y1 = max(0, g['y_min'] - pad)
        x2 = min(w, g['x_max'] + pad)
        y2 = min(h, g['y_max'] + pad)
        if x2 - x1 < 50 or y2 - y1 < 20:
            continue  # 跳过太小的区域

        # 检查该区域有无红笔
        region_mask = red_mask[y1:y2, x1:x2] if red_mask is not None else np.zeros((y2-y1, x2-x1), dtype=np.uint8)
        red_pixels = np.sum(region_mask > 0)
        total = region_mask.size if region_mask.size > 0 else 1
        red_ratio = round(red_pixels / total, 5)

        # 裁剪原图该区域
        crop = img[y1:y2, x1:x2]
        b64 = cv2_to_b64(crop, quality=80)

        regions.append({
            'bbox': [int(x1), int(y1), int(x2 - x1), int(y2 - y1)],
            'has_red': bool(red_ratio > 0.001),
            'red_ratio': float(red_ratio),
            'base64': b64
        })

    # 如果没有检测到任何区域，回退到网格
    if not regions:
        regions = fallback_grid_crop(img, red_mask)

    return regions


def fallback_grid_crop(img, red_mask):
    """PaddleOCR 不可用时的均匀网格切片"""
    import cv2
    h, w = img.shape[:2]
    # 按行切片：每 100px 高一个区域
    regions = []
    row_h = 120
    overlap = 20
    y = 0
    while y < h:
        y1 = y
        y2 = min(h, y + row_h)
        region_mask = red_mask[y1:y2, 0:w] if red_mask is not None else np.zeros((y2-y1, w), dtype=np.uint8)
        red_pixels = np.sum(region_mask > 0)
        total = region_mask.size if region_mask.size > 0 else 1
        red_ratio = round(red_pixels / total, 5)

        if w > 300 and y2 - y1 > 30:  # 跳过太窄的切片
            crop = img[y1:y2, 0:w]
            b64 = cv2_to_b64(crop, quality=80)
            regions.append({
                'bbox': [0, int(y1), int(w), int(y2 - y1)],
                'has_red': bool(red_ratio > 0.001),
                'red_ratio': float(red_ratio),
                'base64': b64
            })
        y += row_h - overlap

    return regions


# ========== API 接口 ==========

@app.route('/health', methods=['GET'])
def health():
    ocr_ok = get_ocr() is not None
    return jsonify({
        'status': 'ok',
        'service': 'gaozhong-preprocess',
        'paddleocr': ocr_ok,
        'features': ['deskew', 'contrast', 'red_separation', 'blue_separation', 'layout_analysis']
    })


@app.route('/preprocess', methods=['POST'])
def preprocess():
    """
    输入: { "image": "data:image/jpeg;base64,...", "options": { "deskew": true, "red": true, "blue": true, "layout": true } }
    输出: { "status": "ok", "result": { "corrected": "...", "red_marks": "...", "student_handwriting": "...", "layout": [...] } }
    """
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({'status': 'error', 'error': '缺少 image 字段'}), 400

        options = data.get('options', {})
        img = b64_to_cv2(data['image'])
        if img is None or img.size == 0:
            return jsonify({'status': 'error', 'error': '无法解码图片'}), 400

        result = {}

        # 1. 透视矫正
        if options.get('deskew', True):
            img = deskew_image(img)

        # 2. 对比度增强（总是做）
        img = enhance_contrast(img)

        # 3. 红色笔迹分离 + 区域裁剪
        if options.get('red', True):
            red, red_mask = separate_red_ink(img)
            result['red_marks'] = cv2_to_b64(red)
            result['red_signal'] = round(float(np.sum(red_mask > 0) / red_mask.size), 5) if red_mask.size > 0 else 0
            # v7: 裁剪题目区域
            regions = crop_question_regions(img, red_mask)
            result['regions'] = regions
            result['region_count'] = len(regions)
            result['regions_with_red'] = int(sum(1 for r in regions if r['has_red']))

        # 4. 学生手写分离（保留，供复核使用）
        if options.get('blue', True):
            blue = separate_blue_ink(img)
            result['student_handwriting'] = cv2_to_b64(blue)

        # 5. 矫正后原图
        result['corrected'] = cv2_to_b64(img)

        return jsonify({
            'status': 'ok',
            'result': result,
            'image_size': {'width': img.shape[1], 'height': img.shape[0]}
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'error': str(e)}), 500


if __name__ == '__main__':
    print("=" * 60)
    print("gaozhong.online — 试卷预处理微服务 v7")
    print("端口: 5001")
    print("预处理(裁剪区域): POST /preprocess")
    print("=" * 60, flush=True)
    app.run(host='0.0.0.0', port=5001, debug=False)
