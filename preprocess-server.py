#!/usr/bin/env python3
"""
gaozhong.online — 试卷图片预处理微服务
============================================
接收 base64 试卷图片，输出：
  1. corrected_image  — 透视矫正后的原图
  2. red_marks        — 红色笔迹分离（批改标记）
  3. layout_boxes     — PaddleOCR 版面分析结果

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
    """分离红色笔迹（批改标记）"""
    import cv2
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    # 红色范围（HSV）：0-10（红1）和 160-180（红2）
    lower_red1 = np.array([0, 50, 50])
    upper_red1 = np.array([10, 255, 255])
    lower_red2 = np.array([160, 50, 50])
    upper_red2 = np.array([180, 255, 255])

    mask1 = cv2.inRange(hsv, lower_red1, upper_red1)
    mask2 = cv2.inRange(hsv, lower_red2, upper_red2)
    red_mask = cv2.bitwise_or(mask1, mask2)

    # 形态学增强（让细小红笔迹更明显）
    kernel = np.ones((2, 2), np.uint8)
    red_mask = cv2.morphologyEx(red_mask, cv2.MORPH_CLOSE, kernel)

    # 提取红色部分到白底
    red_only = np.full_like(img, 255)  # 白底
    red_only[red_mask > 0] = img[red_mask > 0]

    return red_only


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
        return None

    try:
        result = ocr.ocr(img, cls=False)
        if not result or not result[0]:
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

        # 3. 红色笔迹分离
        if options.get('red', True):
            red = separate_red_ink(img)
            result['red_marks'] = cv2_to_b64(red)

        # 4. 学生手写分离
        if options.get('blue', True):
            blue = separate_blue_ink(img)
            result['student_handwriting'] = cv2_to_b64(blue)

        # 5. 版面分析
        if options.get('layout', True):
            layout = extract_layout(img)
            if layout:
                result['layout'] = layout
                result['layout_count'] = len(layout)

        # 6. 矫正后原图
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
    print("gaozhong.online — 试卷预处理微服务")
    print("端口: 5001")
    print("健康检查: GET /health")
    print("预处理: POST /preprocess")
    print("=" * 60, flush=True)
    app.run(host='0.0.0.0', port=5001, debug=False)
