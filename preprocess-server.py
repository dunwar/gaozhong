#!/usr/bin/env python3
"""
gaozhong.online — 预处理 v8.0
功能: 矫正+对比度 + 红笔突出图 + 连通域红笔区域检测
新增 /red-regions: 使用 connectedComponentsWithStats 提取红笔质心
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

def extract_red_mask(img):
    """HSV 红笔掩码提取 + 闭运算连接断笔"""
    import cv2
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    # 红色在 HSV 中绕 0°/360°，分两段
    m1 = cv2.inRange(hsv, np.array([0, 30, 40]), np.array([15, 255, 255]))
    m2 = cv2.inRange(hsv, np.array([155, 30, 40]), np.array([180, 255, 255]))
    mask = cv2.bitwise_or(m1, m2)
    # 3×3 闭运算：连接断笔（✗ 一笔断成两段 → 连成一个整体）
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    return mask

def extract_red_regions(img):
    """
    连通域检测提取红笔区域。
    返回: (regions列表, red_signal, page_area_stats)
    
    regions: [{ centroid: {x,y}, area, bbox: {x,y,w,h} }]
    page_area_stats: { median, mean, p75 } — 用于局部阈值判断
    """
    import cv2
    h, w = img.shape[:2]
    mask = extract_red_mask(img)
    
    # connectedComponentsWithStats 返回 (num_labels, labels, stats, centroids)
    # stats[0] 是背景，从 label=1 开始是各连通域
    num_labels, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
    
    # 过滤参数
    MIN_AREA = 15                          # 噪点
    MAX_AREA = w * 0.5 * h * 0.3           # 超过页面 15% = 装饰/边缘
    MAX_AREA_PX = min(MAX_AREA, 50000)     # 硬上限 50000px
    
    regions = []
    areas = []
    
    for label in range(1, num_labels):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area < MIN_AREA or area > MAX_AREA_PX:
            continue
        
        x = int(stats[label, cv2.CC_STAT_LEFT])
        y = int(stats[label, cv2.CC_STAT_TOP])
        bw = int(stats[label, cv2.CC_STAT_WIDTH])
        bh = int(stats[label, cv2.CC_STAT_HEIGHT])
        cx = float(centroids[label][0])
        cy = float(centroids[label][1])
        
        # 过滤贯穿页面的长横线（下划线/装饰线）
        if bw > w * 0.6 and bh < 8:
            continue
        
        regions.append({
            "centroid": {"x": round(cx, 1), "y": round(cy, 1)},
            "area": area,
            "bbox": {"x": x, "y": y, "w": bw, "h": bh}
        })
        areas.append(area)
    
    # 页面级统计（用于局部阈值）
    page_stats = {"median": 0, "mean": 0, "p75": 0, "count": len(areas)}
    if areas:
        arr = np.array(areas)
        page_stats["median"] = float(np.median(arr))
        page_stats["mean"] = round(float(np.mean(arr)), 1)
        page_stats["p75"] = float(np.percentile(arr, 75))
    
    red_signal = round(float(np.sum(mask > 0) / mask.size), 5)
    return regions, red_signal, page_stats

def red_highlighted_image(img):
    """生成红笔突出图: 红笔区域100%清晰, 非红区淡化到15%"""
    import cv2
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    m1 = cv2.inRange(hsv, np.array([0, 30, 40]), np.array([15, 255, 255]))
    m2 = cv2.inRange(hsv, np.array([155, 30, 40]), np.array([180, 255, 255]))
    red_mask = cv2.bitwise_or(m1, m2)
    kernel = np.ones((3, 3), np.uint8)
    red_mask = cv2.dilate(red_mask, kernel, iterations=2)

    result = img.copy().astype(np.float32)
    non_red = cv2.bitwise_not(red_mask)
    for c in range(3):
        result[:, :, c] = np.where(non_red > 0, result[:, :, c] * 0.15, result[:, :, c])
    result = np.clip(result, 0, 255).astype(np.uint8)

    red_signal = round(float(np.sum(red_mask > 0) / red_mask.size), 5)
    return result, red_mask, red_signal

# ═══════════ Endpoints ═══════════

@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'service': 'gaozhong-preprocess', 'version': 'v8.0'})

@app.route('/preprocess', methods=['POST'])
def preprocess():
    """现有接口：矫正 + 对比增强 + 红笔突出图"""
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

@app.route('/red-regions', methods=['POST'])
def red_regions():
    """
    v8.0 新接口：连通域红笔区域检测
    输入: { image: "base64...", options: { deskew, enhance } }
    输出: { status, result: { regions: [{centroid, area, bbox}], red_signal, page_stats, total_regions } }
    """
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({'status': 'error', 'error': '缺少image'}), 400
        img = b64_to_cv2(data['image'])
        if img is None or img.size == 0:
            return jsonify({'status': 'error', 'error': '无法解码'}), 400
        
        options = data.get('options', {})
        if options.get('deskew', True): img = deskew_image(img)
        if options.get('enhance', True): img = enhance_contrast(img)
        
        regions, red_signal, page_stats = extract_red_regions(img)
        
        result = {
            'regions': regions,
            'red_signal': red_signal,
            'page_stats': page_stats,
            'total_regions': len(regions),
            'image_size': {'width': img.shape[1], 'height': img.shape[0]}
        }
        return jsonify({'status': 'ok', 'result': result})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'error': str(e)}), 500

if __name__ == '__main__':
    print("gaozhong.online 预处理 v8.0\n端口:5002", flush=True)
    app.run(host='0.0.0.0', port=5002, debug=False)
