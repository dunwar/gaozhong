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


# ========== v6: 红笔标记检测 + 标注图生成 ==========

def detect_red_marks(red_mask, min_area=50):
    """
    从红色 mask 中检测批改符号：✗ ×、✓ 勾、○ 圈、手写红字
    返回: [{ type: 'cross'|'tick'|'circle'|'text', bbox: [x,y,w,h], center: [cx,cy], area, confidence }]
    """
    import cv2
    # 膨胀让断开的线条连接
    kernel = np.ones((3, 3), np.uint8)
    dilated = cv2.dilate(red_mask, kernel, iterations=1)

    contours, hierarchy = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    marks = []

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area:
            continue

        x, y, w, h = cv2.boundingRect(cnt)
        cx, cy = x + w // 2, y + h // 2

        # 轮廓近似
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)
        hull = cv2.convexHull(cnt, returnPoints=False)
        hull_area = cv2.contourArea(cv2.convexHull(cnt))

        # 基础特征
        aspect_ratio = w / max(h, 1)
        solidity = area / max(hull_area, 1)
        extent = area / max(w * h, 1)

        # 圆形度: 4π*Area / Perimeter² — 完美圆=1
        circularity = (4 * np.pi * area) / max(peri * peri, 1)

        # 凸缺陷分析（用于检测交叉线和勾）
        defects = None
        if hull is not None and len(hull) > 3:
            try:
                defects = cv2.convexityDefects(cnt, hull)
            except:
                pass

        defect_count = len(defects) if defects is not None else 0

        mark_type = 'text'
        confidence = 0.5

        # ── 分类逻辑 ──
        if circularity > 0.55 and aspect_ratio > 0.5 and aspect_ratio < 2.0:
            # 高圆形度 → 圈（教师圈出答案）
            mark_type = 'circle'
            confidence = min(circularity, 1.0)
        elif defect_count >= 2 and solidity < 0.85:
            # 多个凸缺陷 + 非凸 → 交叉符号（✗）
            mark_type = 'cross'
            confidence = min(defect_count / 5, 1.0)
        elif defect_count >= 1 and aspect_ratio > 1.3 and solidity < 0.8:
            # 有凸缺陷 + 长形 + 非凸 → 勾（✓）
            mark_type = 'tick'
            confidence = 0.7
        elif w > 15 and h > 10 and solidity < 0.7:
            # 区域较大 + 形状不规则 → 手写红字
            mark_type = 'text'
            confidence = 0.6
        elif area < 200:
            # 小面积 → 可能是点或短划，归类为标记但不判定类型
            mark_type = 'text'
            confidence = 0.3

        marks.append({
            'type': mark_type,
            'bbox': [int(x), int(y), int(w), int(h)],
            'center': [int(cx), int(cy)],
            'area': int(area),
            'confidence': round(confidence, 3)
        })

    # 合并重叠标记（同一区域的多个检测合并为一个）
    merged = merge_overlapping_marks(marks)
    return merged


def merge_overlapping_marks(marks, iou_threshold=0.3):
    """合并重叠的标记框（避免同一个 × 被当成多个符号）"""
    if len(marks) <= 1:
        return marks

    import cv2
    merged = []
    used = [False] * len(marks)

    for i in range(len(marks)):
        if used[i]:
            continue
        base = dict(marks[i])
        xi1, yi1 = base['bbox'][0], base['bbox'][1]
        xi2, yi2 = xi1 + base['bbox'][2], yi1 + base['bbox'][3]

        for j in range(i + 1, len(marks)):
            if used[j]:
                continue
            xj1, yj1 = marks[j]['bbox'][0], marks[j]['bbox'][1]
            xj2, yj2 = xj1 + marks[j]['bbox'][2], yj1 + marks[j]['bbox'][3]

            # 计算 IoU
            inter_x1 = max(xi1, xj1)
            inter_y1 = max(yi1, yj1)
            inter_x2 = min(xi2, xj2)
            inter_y2 = min(yi2, yj2)
            if inter_x1 < inter_x2 and inter_y1 < inter_y2:
                inter_area = (inter_x2 - inter_x1) * (inter_y2 - inter_y1)
                union_area = base['area'] + marks[j]['area'] - inter_area
                iou = inter_area / max(union_area, 1)
                if iou > iou_threshold:
                    # 合并：扩展 bbox，保持类型取最高置信度
                    base['bbox'][0] = min(xi1, xj1)
                    base['bbox'][1] = min(yi1, yj1)
                    base['bbox'][2] = max(xi2, xj2) - base['bbox'][0]
                    base['bbox'][3] = max(yi2, yj2) - base['bbox'][1]
                    base['center'][0] = base['bbox'][0] + base['bbox'][2] // 2
                    base['center'][1] = base['bbox'][1] + base['bbox'][3] // 2
                    base['area'] = base['bbox'][2] * base['bbox'][3]
                    if marks[j]['confidence'] > base['confidence']:
                        base['type'] = marks[j]['type']
                        base['confidence'] = marks[j]['confidence']
                    used[j] = True
        merged.append(base)
        used[i] = True

    return merged


def create_annotated_image(img, red_mask, marks):
    """
    生成标注图：
    - 蓝黑笔迹（学生手写）淡化到 35%
    - 印刷体区域保持 100%
    - 红笔标记用彩色框高亮（黄=✗, 绿=✓, 青=○, 品红=红字）
    - 白色背景打底
    """
    import cv2

    h, w = img.shape[:2]
    result = img.copy().astype(np.float32)

    # ── 构建蓝黑笔迹 mask（非红、非白色背景） ──
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # 白色背景区域（灰度 > 200）
    _, white_mask = cv2.threshold(gray, 210, 255, cv2.THRESH_BINARY)
    white_mask_inv = cv2.bitwise_not(white_mask)

    # 蓝黑笔迹 = 非白区域 - 红笔区域（已膨胀）
    blue_black_mask = cv2.bitwise_and(white_mask_inv, cv2.bitwise_not(red_mask))

    # 轻微形态学让蓝黑 mask 更干净
    kernel = np.ones((5, 5), np.uint8)
    blue_black_mask = cv2.morphologyEx(blue_black_mask, cv2.MORPH_CLOSE, kernel)

    # ── 蓝黑笔迹淡化（亮度×0.35）──
    for c in range(3):
        result[:, :, c] = np.where(blue_black_mask > 0, result[:, :, c] * 0.35, result[:, :, c])

    # ── 背景提亮（接近白色）──
    result = np.clip(result, 0, 255).astype(np.uint8)

    # ── 绘制红笔标记彩色框 ──
    color_map = {
        'cross':  (0, 230, 230),   # 黄色 (BGR) — ✗ 打叉
        'tick':   (0, 230, 100),   # 绿色 — ✓ 打勾
        'circle': (230, 230, 0),   # 青色 — ○ 圈选
        'text':   (230, 100, 230), # 品红 — 手写红字
    }
    label_map = {
        'cross': 'X', 'tick': 'V', 'circle': 'O', 'text': 'Tx'
    }

    for m in marks:
        x, y, bw, bh = m['bbox']
        color = color_map.get(m['type'], (200, 200, 200))
        label = label_map.get(m['type'], '?')

        # 画半透明填充框
        overlay = result.copy()
        pad = 4
        x1 = max(0, x - pad)
        y1 = max(0, y - pad)
        x2 = min(w, x + bw + pad)
        y2 = min(h, y + bh + pad)
        cv2.rectangle(overlay, (x1, y1), (x2, y2), color, -1)
        result = cv2.addWeighted(result, 0.7, overlay, 0.3, 0)

        # 画边框
        cv2.rectangle(result, (x1, y1), (x2, y2), color, 3)

        # 画标签
        label_size = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2)[0]
        lx = x1
        ly = y1 - 8 if y1 > 20 else y1 + bh + 20
        # 标签背景
        cv2.rectangle(result, (lx, ly - label_size[1] - 4), (lx + label_size[0] + 6, ly + 4), color, -1)
        cv2.putText(result, label, (lx + 3, ly), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)

    result = np.clip(result, 0, 255).astype(np.uint8)
    return result


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

        # 3. 红色笔迹分离 + 标记检测
        if options.get('red', True):
            red, red_mask = separate_red_ink(img)
            result['red_marks'] = cv2_to_b64(red)
            # 红笔信号强度
            red_pixels = np.sum(red_mask > 0)
            total_pixels = red_mask.size
            result['red_signal'] = round(red_pixels / total_pixels, 5) if total_pixels > 0 else 0
            # 红笔二值图
            import cv2
            red_binary = cv2.bitwise_not(red_mask)
            result['red_marks_binary'] = cv2_to_b64(cv2.cvtColor(red_binary, cv2.COLOR_GRAY2BGR))
            # v6: 红笔标记检测
            marks = detect_red_marks(red_mask)
            result['marks'] = marks
            result['mark_count'] = len(marks)
            # v6: 标注图生成（如果有标记）
            if marks:
                annotated = create_annotated_image(img, red_mask, marks)
                result['annotated'] = cv2_to_b64(annotated)

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


@app.route('/detect-marks', methods=['POST'])
def detect_marks():
    """
    检测红笔批改标记
    输入: { "image": "base64..." }
    输出: { "status": "ok", "marks": [{ type, bbox, center, area, confidence }], "count": N }
    """
    import cv2
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({'status': 'error', 'error': '缺少 image 字段'}), 400
        img = b64_to_cv2(data['image'])
        if img is None or img.size == 0:
            return jsonify({'status': 'error', 'error': '无法解码图片'}), 400

        # 矫正 + 对比度
        img = deskew_image(img)
        img = enhance_contrast(img)

        # 红笔分离 + 检测
        red, red_mask = separate_red_ink(img)
        marks = detect_red_marks(red_mask)

        return jsonify({
            'status': 'ok',
            'marks': marks,
            'count': len(marks),
            'red_signal': round(np.sum(red_mask > 0) / red_mask.size, 5),
            'image_size': {'width': img.shape[1], 'height': img.shape[0]}
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'error': str(e)}), 500


@app.route('/annotate', methods=['POST'])
def annotate():
    """
    生成标注图：蓝黑笔迹淡化 + 红笔标记彩色高亮框
    输入: { "image": "base64..." }
    输出: { "status": "ok", "annotated": "base64...", "marks": [...] }
    """
    import cv2
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({'status': 'error', 'error': '缺少 image 字段'}), 400
        img = b64_to_cv2(data['image'])
        if img is None or img.size == 0:
            return jsonify({'status': 'error', 'error': '无法解码图片'}), 400

        # 矫正 + 对比度
        img = deskew_image(img)
        img = enhance_contrast(img)

        # 红笔分离 + 检测
        red, red_mask = separate_red_ink(img)
        marks = detect_red_marks(red_mask)

        # 生成标注图
        annotated = create_annotated_image(img, red_mask, marks)

        return jsonify({
            'status': 'ok',
            'annotated': cv2_to_b64(annotated, quality=85),
            'marks': marks,
            'mark_count': len(marks),
            'image_size': {'width': img.shape[1], 'height': img.shape[0]}
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'error': str(e)}), 500


if __name__ == '__main__':
    print("=" * 60)
    print("gaozhong.online — 试卷预处理微服务 v6")
    print("端口: 5001")
    print("健康检查: GET /health")
    print("预处理: POST /preprocess")
    print("标记检测: POST /detect-marks")
    print("标注图: POST /annotate")
    print("=" * 60, flush=True)
    app.run(host='0.0.0.0', port=5001, debug=False)
