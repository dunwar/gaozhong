#!/usr/bin/env python3
"""
gaozhong.online — 预处理 v8.3
功能: 矫正+对比度 + 红笔突出图 + 连通域红笔区域检测 + 去红处理 + 页面准备 + TextIn
v8.3: 新增 /prepare-pages 端点 — 自动旋转+双页水平分割+页面排序
v8.2: 新增 /textin/* 端点 — TextIn OCR 集成
v8.1: 新增 /de-red 端点 — 用红笔 mask 擦除原图红笔墨水，输出干净图像供 OCR
"""
import base64, traceback, json, os, sys, numpy as np
from pathlib import Path
from flask import Flask, request, jsonify

# Ensure project root is on path so `from src.textin import ...` works
_project_root = Path(__file__).resolve().parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

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
    return jsonify({'status': 'ok', 'service': 'gaozhong-preprocess', 'version': 'v8.1'})

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

@app.route('/de-red', methods=['POST'])
def de_red():
    """
    v8.1 新接口：去红笔处理
    擦除原图中的红笔墨水（用 inpainting 填充背景色），输出干净图像。
    用于 OCR 前的预处理，避免红笔划线破坏文字形态。
    
    输入: { image: "base64...", options: { deskew: true } }
    输出: { status, result: { clean_image, red_signal } }
    """
    import cv2
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({'status': 'error', 'error': '缺少image'}), 400
        img = b64_to_cv2(data['image'])
        if img is None or img.size == 0:
            return jsonify({'status': 'error', 'error': '无法解码'}), 400
        
        options = data.get('options', {})
        if options.get('deskew', True):
            img = deskew_image(img)
        img = enhance_contrast(img)
        
        # 提取红笔 mask
        red_mask = extract_red_mask(img)
        
        # 膨胀 mask 2 像素，确保完全覆盖红笔记号边缘
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        red_mask_dilated = cv2.dilate(red_mask, kernel, iterations=1)
        
        # inpainting 填充：用周围像素色填充红笔区域
        clean = cv2.inpaint(img, red_mask_dilated, inpaintRadius=5, flags=cv2.INPAINT_TELEA)
        
        red_signal = round(float(np.sum(red_mask > 0) / red_mask.size), 5)
        
        result = {
            'clean_image': cv2_to_b64(clean),
            'red_signal': red_signal
        }
        return jsonify({'status': 'ok', 'result': result,
            'image_size': {'width': img.shape[1], 'height': img.shape[0]}})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'error': str(e)}), 500




@app.route('/layout-detect', methods=['POST'])
def layout_detect():
    """
    版面检测 — 基础单/双栏判断 + 文本块粗略定位（基于 OpenCV，无需 PaddleOCR）
    输入: { file_path: "/path/to/image.jpg", options: { min_score: 0.4 } }
    输出: { status, result: { blocks, total, label_counts, image_size } }
    注意: 此端点兼容 scanner-v3.mjs 的 detectLayout() 调用，不依赖 PaddleOCR
    """
    import cv2
    try:
        data = request.get_json()
        file_path = data.get('file_path', '') if data else ''
        # 也支持 base64 image 输入
        image_b64 = data.get('image', '') if data else ''

        img = None
        if file_path and Path(file_path).exists():
            img = cv2.imread(file_path)
        elif image_b64:
            img = b64_to_cv2(image_b64)
        else:
            return jsonify({'status': 'error', 'error': '缺少 file_path 或 image'}), 400

        if img is None or img.size == 0:
            return jsonify({'status': 'error', 'error': '无法读取图片'}), 400

        h, w = img.shape[:2]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        # 二值化
        _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        # 水平投影 — 检测文本行
        h_proj = np.sum(binary, axis=1)
        # 垂直投影 — 检测列
        v_proj = np.sum(binary, axis=0)

        # 简单双栏检测：垂直投影中段是否有明显谷底
        mid_start = int(w * 0.35)
        mid_end = int(w * 0.65)
        mid_region = v_proj[mid_start:mid_end]
        v_mean = float(np.mean(v_proj)) if v_proj.size > 0 else 1.0
        mid_mean = float(np.mean(mid_region)) if mid_region.size > 0 else v_mean
        # 注意: 必须用 bool() 转换 numpy.bool_，否则 jsonify 会报错
        is_dual_column = bool(mid_mean < v_mean * 0.3 and w > 600)

        # 构建粗略文本块（基于水平投影的行分组）
        threshold = float(np.mean(h_proj) * 0.3) if h_proj.size > 0 else 1.0
        rows = []
        in_row = False
        row_start = 0
        for y in range(h):
            if h_proj[y] > threshold and not in_row:
                in_row = True
                row_start = y
            elif h_proj[y] <= threshold and in_row:
                in_row = False
                if y - row_start > 8:  # 最小行高
                    rows.append((row_start, y))

        blocks = []
        for i, (y1, y2) in enumerate(rows[:50]):  # 最多50个块
            col_w = w // 2 if is_dual_column else w
            x1 = 0 if is_dual_column else 0
            if is_dual_column:
                # 粗略判断块在左栏还是右栏
                row_center_x = np.argmax(v_proj[:col_w]) if col_w > 0 else 0
            blocks.append({
                'label': 'text',
                'score': 0.8,
                'x1': int(x1),
                'y1': int(y1),
                'x2': int(x1 + col_w),
                'y2': int(y2),
                'w': int(col_w),
                'h': int(y2 - y1),
            })

        print(f"layout-detect: {w}x{h}, {len(blocks)} blocks, dual={is_dual_column}", flush=True)
        return jsonify({
            'status': 'ok',
            'result': {
                'blocks': blocks,
                'total': len(blocks),
                'label_counts': {'text': len(blocks)},
                'image_size': {'width': w, 'height': h},
                'is_dual_column': is_dual_column,
                'predict_ms': 0,
            }
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'error': str(e)}), 500


# ═══════════════════════════════════════════════════════════════
# 页面准备端点 (v8.3) — 自动旋转 + 双页照片分割 + 页面排序
# ═══════════════════════════════════════════════════════════════

@app.route('/prepare-pages', methods=['POST'])
def prepare_pages():
    """
    页面准备：将手机拍摄的试卷照片转为独立页面
    0. 裁切背景 — 自动检测试卷边缘，裁掉桌面/背景
    1. 自动旋转 — 横拍竖版自动转正（宽>高且宽>1000时旋转90°）
    2. 水平分页 — 一张照片拍两页时，从中间切开为独立页面
    3. 页面排序 — 每张照片的右半页先（通常为奇数页），左半页后

    输入: {"images": ["base64...", ...]}
    输出: {
        "status":"ok",
        "pages": [
            {"index":0, "photoIndex":0, "side":"R", "image":"base64...", "width":1200, "height":1600},
            ...
        ],
        "total_pages": N
    }
    """
    def _crop_to_paper(img):
        """裁切掉试卷周围的背景（桌面等），只保留试卷区域"""
        import cv2
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        # 高斯模糊去噪
        blurred = cv2.GaussianBlur(gray, (5, 5), 0)
        # Canny 边缘检测
        edges = cv2.Canny(blurred, 30, 100)
        # 膨胀连接断边
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
        dilated = cv2.dilate(edges, kernel, iterations=2)
        # 找轮廓
        contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return img, False

        # 最大轮廓 ≈ 试卷边界
        largest = max(contours, key=cv2.contourArea)
        area = cv2.contourArea(largest)
        img_area = img.shape[0] * img.shape[1]

        # 面积 < 图像 25% → 可能不是试卷，不裁
        if area < img_area * 0.25:
            return img, False

        x, y, w, h = cv2.boundingRect(largest)

        # 适度边距（2% + 10px，保留试卷边缘不被误裁）
        mx = max(10, int(w * 0.02))
        my = max(10, int(h * 0.02))
        x1 = max(0, x - mx)
        y1 = max(0, y - my)
        x2 = min(img.shape[1], x + w + mx)
        y2 = min(img.shape[0], y + h + my)

        cropped = img[y1:y2, x1:x2]
        cropped_area = cropped.shape[0] * cropped.shape[1]

        # 裁切后面积变化 < 8% → 无需裁切（已经够紧）
        if cropped_area > img_area * 0.92:
            return img, False

        return cropped, True

    try:
        from PIL import Image
        import io

        data = request.get_json(force=True)
        if not data or 'images' not in data:
            return jsonify({'status': 'error', 'error': '缺少images数组'}), 400

        images_b64 = data['images']
        if not isinstance(images_b64, list) or len(images_b64) == 0:
            return jsonify({'status': 'error', 'error': 'images必须是数组'}), 400

        pages = []
        page_index = 0
        crop_count = 0

        for photo_idx, img_b64 in enumerate(images_b64):
            # 解码 base64
            img = b64_to_cv2(img_b64)
            if img is None or img.size == 0:
                continue

            orig_h, orig_w = img.shape[:2]

            # Step 0: Crop background — 裁掉桌面/背景，只留试卷
            img, cropped = _crop_to_paper(img)
            if cropped:
                crop_count += 1
                ch, cw = img.shape[:2]
                print(f"  Photo {photo_idx}: cropped {orig_w}x{orig_h} → {cw}x{ch}", flush=True)

            # Step 1: Auto-rotate (kimi 逻辑)
            # 手机横拍竖版试卷 → 宽>高且宽>1000 → 旋转90°使文字正立
            h, w = img.shape[:2]
            rotated = False
            if w > h and w > 1000:
                import cv2
                img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
                h, w = img.shape[:2]
                rotated = True
                print(f"  Photo {photo_idx}: auto-rotated 90° → {w}x{h}", flush=True)

            # Step 2: Horizontal split (kimi 逻辑)
            # 判断是否需要分页：宽高比接近 1.3~1.5（两张竖版A4并排）时进行中分
            aspect = w / h if h > 0 else 1
            if 1.2 <= aspect <= 1.6 and w > 800:
                # 水平中分：左右各为独立页面
                mid = w // 2
                # R = 右半页（通常为奇数页，页码较小）
                # L = 左半页（通常为偶数页，页码较大）
                right_half = img[:, mid:, :]
                left_half = img[:, :mid, :]

                for side, half in [('R', right_half), ('L', left_half)]:
                    b64 = cv2_to_b64(half)
                    hh, hw = half.shape[:2]
                    pages.append({
                        'index': page_index,
                        'photoIndex': photo_idx,
                        'side': side,
                        'image': b64,
                        'width': hw,
                        'height': hh,
                        'rotated': rotated,
                        'split': True
                    })
                    page_index += 1
                print(f"  Photo {photo_idx}: split → page {page_index-2}(R) + page {page_index-1}(L)", flush=True)
            else:
                # 单页照片，不需要分割
                b64 = cv2_to_b64(img)
                pages.append({
                    'index': page_index,
                    'photoIndex': photo_idx,
                    'side': 'full',
                    'image': b64,
                    'width': w,
                    'height': h,
                    'rotated': rotated,
                    'split': False
                })
                page_index += 1
                print(f"  Photo {photo_idx}: single page (aspect={aspect:.2f})", flush=True)

        split_count = sum(1 for p in pages if p['split'])
        rotated_count = sum(1 for p in pages if p['rotated'])

        print(f"prepare-pages: {len(images_b64)} photos → {len(pages)} pages"
              f" ({crop_count} cropped, {split_count} split, {rotated_count} rotated)", flush=True)

        return jsonify({
            'status': 'ok',
            'pages': pages,
            'total_pages': len(pages),
            'stats': {
                'photos': len(images_b64),
                'pages': len(pages),
                'cropped': crop_count,
                'split': split_count,
                'rotated': rotated_count
            }
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'error': str(e)}), 500


# ═══════════════════════════════════════════════════════════════
# TextIn 集成端点 (v8.2) — 基于 Kimi 项目的 TextIn API 管线
# ═══════════════════════════════════════════════════════════════

def _get_textin_credentials():
    """读取 TextIn 凭证：环境变量 → .env 文件回退"""
    app_id = os.environ.get('TEXTIN_APP_ID', '')
    secret = os.environ.get('TEXTIN_SECRET_CODE', '')
    # 环境变量未设时，尝试读 .env 文件
    if not (app_id and secret):
        env_file = Path(__file__).resolve().parent / '.env'
        if env_file.exists():
            try:
                for line in env_file.read_text(encoding='utf-8').splitlines():
                    line = line.strip()
                    if not line or line.startswith('#'):
                        continue
                    if line.startswith('TEXTIN_APP_ID='):
                        app_id = app_id or line.split('=', 1)[1].strip().strip('"').strip("'")
                    elif line.startswith('TEXTIN_SECRET_CODE='):
                        secret = secret or line.split('=', 1)[1].strip().strip('"').strip("'")
                if app_id and secret:
                    print(f"TextIn: loaded credentials from .env (app_id={app_id[:8]}...)", flush=True)
            except Exception as e:
                print(f"TextIn: failed to read .env: {e}", flush=True)
    return app_id, secret

@app.route('/textin/ping', methods=['GET'])
def textin_ping():
    """TextIn 服务状态检查"""
    app_id, secret = _get_textin_credentials()
    configured = bool(app_id and secret)
    return jsonify({
        'status': 'ok' if configured else 'not_configured',
        'textin_configured': configured,
        'app_id_prefix': app_id[:8] + '...' if configured else '',
        'credential_source': 'env' if os.environ.get('TEXTIN_APP_ID') else ('.env' if configured else 'none')
    })

@app.route('/textin/erase', methods=['POST'])
def textin_erase():
    """
    TextIn 手写擦除 — 用深度学习 GAN 去除手写笔迹
    输入: {"image": "base64..."}
    输出: {"status":"ok", "result":{"clean_image":"base64..."}}
    """
    try:
        from src.textin.client import TextInClient
        import tempfile

        app_id, secret = _get_textin_credentials()
        if not app_id or not secret:
            return jsonify({'status': 'error', 'error': 'TextIn 未配置（设置 TEXTIN_APP_ID / TEXTIN_SECRET_CODE 或 .env）'}), 503

        data = request.get_json(force=True)
        if not data or 'image' not in data:
            return jsonify({'status': 'error', 'error': '缺少image'}), 400

        img = b64_to_cv2(data['image'])
        if img is None or img.size == 0:
            return jsonify({'status': 'error', 'error': '无法解码'}), 400

        # 保存到临时文件供 TextIn API 读取
        with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
            import cv2
            cv2.imwrite(tmp.name, img)
            tmp_path = tmp.name

        try:
            client = TextInClient(app_id, secret, timeout=60)
            result = client.erase_handwriting(tmp_path)

            if result.success and result.image_data:
                # 将擦除后的图像编码为 base64
                clean_b64 = base64.b64encode(result.image_data).decode()
                return jsonify({
                    'status': 'ok',
                    'result': {
                        'clean_image': f'data:image/jpeg;base64,{clean_b64}',
                        'width': result.width,
                        'height': result.height
                    }
                })
            else:
                return jsonify({'status': 'error', 'error': f'擦除失败: {result.message}'}), 500
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'error': str(e)}), 500

@app.route('/textin/ocr', methods=['POST'])
def textin_ocr():
    """
    TextIn OCR + 题目解析 — 完整管线
    输入: {"image": "base64...", "options": {"subject": "英语"}}
    输出: {"status":"ok", "result": {"questions":[...], "passages":[...], "engine":"textin-xparse-v2"}}

    流程: 加载图片 → TextIn xParse 识别 → 11阶段题目解析 → 输出 gaozhong 兼容格式
    失败自动回退 (由调用方 scanner-v3.mjs 处理)
    """
    try:
        from src.textin.client import TextInClient
        from src.textin.parser import parse_xparse_result
        import tempfile

        app_id, secret = _get_textin_credentials()
        if not app_id or not secret:
            return jsonify({"status": "error", "error": "TextIn 未配置（设置 TEXTIN_APP_ID / TEXTIN_SECRET_CODE 或 .env）"}), 503

        data = request.get_json(force=True)
        if not data or 'image' not in data:
            return jsonify({'status': 'error', 'error': '缺少image'}), 400

        img = b64_to_cv2(data['image'])
        if img is None or img.size == 0:
            return jsonify({'status': 'error', 'error': '无法解码'}), 400

        options = data.get('options', {})
        subject = options.get('subject', '英语')

        img_h, img_w = img.shape[:2]

        # 保存到临时文件供 TextIn API 读取
        with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
            import cv2
            cv2.imwrite(tmp.name, img)
            tmp_path = tmp.name

        try:
            client = TextInClient(app_id, secret, timeout=60)
            parse_result = client.parse_document(tmp_path)

            if not parse_result.success:
                return jsonify({
                    'status': 'error',
                    'error': f'TextIn xParse 失败: {parse_result.message}'
                }), 500

            # 提取 xParse detail 数组
            detail_items = parse_result.raw_json.get('detail', [])

            if not detail_items:
                # 尝试其他响应字段
                for key in ['elements', 'lines', 'text_blocks']:
                    if key in parse_result.raw_json:
                        detail_items = parse_result.raw_json[key]
                        break

            print(f"TextIn OCR: {len(detail_items)} detail items from xParse", flush=True)

            # 11阶段题目解析
            result = parse_xparse_result(
                detail_items,
                image_size={'width': img_w, 'height': img_h},
                subject=subject
            )

            # 提取手写区域坐标（供 Phase 2 交叉验证）
            handwritten_regions = []
            for item in detail_items:
                tags = item.get('tags', [])
                if 'handwritten' in tags:
                    pos = item.get('position', [])
                    if pos and len(pos) >= 8:
                        xs = [pos[i] for i in range(0, len(pos), 2)]
                        ys = [pos[i] for i in range(1, len(pos), 2)]
                        bbox = {
                            'x': int(min(xs)),
                            'y': int(min(ys)),
                            'w': int(max(xs) - min(xs)),
                            'h': int(max(ys) - min(ys))
                        }
                        handwritten_regions.append({
                            'text': item.get('text', '')[:50],
                            'bbox': bbox,
                            'confidence': item.get('confidence', 0)
                        })

            result['handwritten_regions'] = handwritten_regions
            print(f"TextIn: {len(handwritten_regions)} handwritten regions detected", flush=True)

            return jsonify({
                'status': 'ok',
                'result': result
            })
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'error': str(e)}), 500

if __name__ == '__main__':
    print("gaozhong.online 预处理 v8.3 + TextIn + 分页\n端口:5002", flush=True)
    app.run(host='0.0.0.0', port=5002, debug=False, threaded=True)
