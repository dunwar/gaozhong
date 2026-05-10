#!/usr/bin/env python3
"""
gaozhong.online — 预处理 v7.1 极简版
只做两件事: 矫正+对比度 + 红笔突出图（非红笔区域极淡，红笔清晰）
"""
import base64, traceback, json, numpy as np
from flask import Flask, request, jsonify

app = Flask(__name__)

def b64_to_cv2(b64_str):
    if ',' in b64_str: b64_str = b64_str.split(',', 1)[1]
    np_arr = np.frombuffer(base64.b64decode(b64_str), np.uint8)
    import cv2; return cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

def cv2_to_b64(img, fmt='.jpg', quality=90):
    import cv2
    _, buf = cv2.imencode(fmt, img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return f'data:image/jpeg;base64,{base64.b64encode(buf).decode()}'

def enhance_contrast(img):
    import cv2
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    return cv2.cvtColor(cv2.merge([clahe.apply(l), a, b]), cv2.COLOR_LAB2BGR)

def deskew_image(img):
    import cv2
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours: return img
    largest = max(contours, key=cv2.contourArea)
    peri = cv2.arcLength(largest, True)
    approx = cv2.approxPolyDP(largest, 0.02 * peri, True)
    if len(approx) != 4: return img
    pts = approx.reshape(4, 2)
    rect = np.zeros((4, 2), dtype=np.float32)
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]; rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]; rect[3] = pts[np.argmax(diff)]
    w1, w2 = np.linalg.norm(rect[2]-rect[3]), np.linalg.norm(rect[1]-rect[0])
    h1, h2 = np.linalg.norm(rect[1]-rect[2]), np.linalg.norm(rect[3]-rect[0])
    max_w, max_h = int(max(w1, w2)), int(max(h1, h2))
    dst = np.array([[0,0],[max_w-1,0],[max_w-1,max_h-1],[0,max_h-1]], dtype=np.float32)
    M = cv2.getPerspectiveTransform(rect, dst)
    return cv2.warpPerspective(img, M, (max_w, max_h))

def red_highlighted_image(img):
    """生成红笔突出图: 红笔区域100%清晰, 非红区淡化到15%"""
    import cv2
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    m1 = cv2.inRange(hsv, np.array([0, 30, 40]), np.array([15, 255, 255]))
    m2 = cv2.inRange(hsv, np.array([155, 30, 40]), np.array([180, 255, 255]))
    red_mask = cv2.bitwise_or(m1, m2)
    # 膨胀让细红笔迹更明显
    kernel = np.ones((3, 3), np.uint8)
    red_mask = cv2.dilate(red_mask, kernel, iterations=2)

    # 非红区域淡化到15%
    result = img.copy().astype(np.float32)
    non_red = cv2.bitwise_not(red_mask)
    for c in range(3):
        result[:, :, c] = np.where(non_red > 0, result[:, :, c] * 0.15, result[:, :, c])
    result = np.clip(result, 0, 255).astype(np.uint8)

    red_signal = round(float(np.sum(red_mask > 0) / red_mask.size), 5)
    return result, red_mask, red_signal

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'service': 'gaozhong-preprocess', 'version': 'v7.1'})

@app.route('/preprocess', methods=['POST'])
def preprocess():
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({'status': 'error', 'error': '缺少image'}), 400
        img = b64_to_cv2(data['image'])
        if img is None or img.size == 0:
            return jsonify({'status': 'error', 'error': '无法解码'}), 400
        options = data.get('options', {})
        if options.get('deskew', True): img = deskew_image(img)
        img = enhance_contrast(img)
        highlighted, red_mask, red_signal = red_highlighted_image(img)
        result = {
            'corrected': cv2_to_b64(img),
            'red_highlighted': cv2_to_b64(highlighted, quality=85),
            'red_signal': red_signal
        }
        return jsonify({'status': 'ok', 'result': result,
            'image_size': {'width': img.shape[1], 'height': img.shape[0]}})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'error': str(e)}), 500

if __name__ == '__main__':
    print("gaozhong.online 预处理 v7.1\n端口:5001", flush=True)
    app.run(host='0.0.0.0', port=5001, debug=False)
