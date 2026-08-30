#!/usr/bin/env python3
"""
gaozhong.online — 预处理 v8.4
功能: 矫正+对比度 + 红笔突出图 + 连通域红笔区域检测 + 去红处理 + 页面准备 + TextIn
v8.4: prepare-pages 内容感知 — 旋转前判文字方向(投影方差)，分割前判书缝白带(≥5%)
v8.3: 新增 /prepare-pages 端点 — 自动旋转+双页水平分割+页面排序
v8.2: 新增 /textin/* 端点 — TextIn OCR 集成
v8.1: 新增 /de-red 端点 — 用红笔 mask 擦除原图红笔墨水，输出干净图像供 OCR
"""
import base64, traceback, json, os, sys, re, numpy as np
from pathlib import Path

# ═══════════════════════════════════════════════════════════════
# 加载 .env 文件到 os.environ (启动时执行一次)
# ═══════════════════════════════════════════════════════════════
def _load_dotenv():
    """从 .env 文件加载环境变量（不覆盖已有的）"""
    env_file = Path(__file__).resolve().parent / '.env'
    if not env_file.exists():
        return
    try:
        for line in env_file.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, val = line.partition('=')
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key and not os.environ.get(key):  # 不覆盖已有环境变量
                os.environ[key] = val
    except Exception as e:
        print(f"preprocess-server: failed to load .env: {e}", flush=True)

_load_dotenv()
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
    return jsonify({'status': 'ok', 'service': 'gaozhong-preprocess', 'version': 'v8.4'})

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
# 双栏切分端点 (v4.6) — 检测并切分双栏试卷页面
# ═══════════════════════════════════════════════════════════════

@app.route('/split-columns', methods=['POST'])
def split_columns():
    """
    双栏页面切分：检测双栏 → 找到中线 → 切分为左右半页
    输入: {"image": "base64...", "options": {}}
    输出: {
        "status":"ok",
        "result": {
            "is_dual_column": true/false,
            "midline_x": 650,
            "left_image": "base64...",
            "right_image": "base64...",
            "left_size": {"width":650,"height":1700},
            "right_size": {"width":630,"height":1700}
        }
    }
    """
    import cv2
    import base64 as b64
    try:
        data = request.get_json(force=True)
        if not data or 'image' not in data:
            return jsonify({'status': 'error', 'error': '缺少image'}), 400

        img = b64_to_cv2(data['image'])
        if img is None or img.size == 0:
            return jsonify({'status': 'error', 'error': '无法解码图片'}), 400

        h, w = img.shape[:2]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        # 二值化
        _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

        # 垂直投影 — 找双栏中线（谷底）
        v_proj = np.sum(binary, axis=0).astype(float)

        # 在中段 30%-70% 范围找最小值位置作为中线
        mid_start = int(w * 0.30)
        mid_end = int(w * 0.70)
        if mid_end <= mid_start:
            return jsonify({
                'status': 'ok',
                'result': {'is_dual_column': False, 'midline_x': w // 2,
                           'left_image': None, 'right_image': None,
                           'left_size': None, 'right_size': None}
            })

        mid_region = v_proj[mid_start:mid_end]
        v_mean = float(np.mean(v_proj))
        mid_min_val = float(np.min(mid_region))
        mid_min_idx = int(np.argmin(mid_region)) + mid_start

        # 判断是否双栏：中段最小值低于平均值 30%
        is_dual = bool(mid_min_val < v_mean * 0.3 and w > 600)

        if not is_dual:
            print(f"split-columns: {w}x{h}, single-column (mid_min={mid_min_val:.0f}, v_mean={v_mean:.0f})", flush=True)
            return jsonify({
                'status': 'ok',
                'result': {'is_dual_column': False, 'midline_x': int(mid_min_idx),
                           'left_image': None, 'right_image': None,
                           'left_size': None, 'right_size': None}
            })

        # 以中线为界，左右各留 5px 缓冲（避免切到文字）
        midline = mid_min_idx
        buffer = 5
        left_img = img[:, :midline - buffer] if midline - buffer > 0 else img[:, :midline]
        right_img = img[:, midline + buffer:] if midline + buffer < w else img[:, midline:]

        lh, lw = left_img.shape[:2]
        rh, rw = right_img.shape[:2]

        # 编码为 base64
        def img_to_base64(cv_img):
            _, buf = cv2.imencode('.jpg', cv_img, [cv2.IMWRITE_JPEG_QUALITY, 92])
            return 'data:image/jpeg;base64,' + b64.b64encode(buf).decode('utf-8')

        print(f"split-columns: {w}x{h}, dual-column, midline={midline}, "
              f"left={lw}x{lh}, right={rw}x{rh}", flush=True)

        return jsonify({
            'status': 'ok',
            'result': {
                'is_dual_column': True,
                'midline_x': int(midline),
                'left_image': img_to_base64(left_img),
                'right_image': img_to_base64(right_img),
                'left_size': {'width': lw, 'height': lh},
                'right_size': {'width': rw, 'height': rh},
            }
        })
    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'error': str(e)}), 500


# ═══════════════════════════════════════════════════════════════
# 页面准备端点 (v8.3) — 自动旋转 + 双页照片分割 + 页面排序
# ═══════════════════════════════════════════════════════════════

def _text_is_sideways(img):
    """横版图里的文字是否横躺（需旋转90°扶正）。
    原理: 正立文本的行结构 → 逐行墨迹投影方差 >> 逐列投影方差；横躺则相反。
    实测分离度: 正向 rv/cv=3.2~4.8，横躺 rv/cv=0.27，阈值1.2留足余量。
    仅对横版图调用；180°翻转不在此处理（TextIn/VL 可容忍）。
    v8.4: 修复"正向横版扫描件被误旋转90°"——旧逻辑只看宽>高就转。"""
    import cv2
    sw = 600
    sc = sw / img.shape[1]
    small = cv2.resize(img, (sw, max(1, int(img.shape[0] * sc))))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    bw = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                               cv2.THRESH_BINARY_INV, 15, 10)
    row_var = float(np.var(bw.sum(axis=1)))
    col_var = float(np.var(bw.sum(axis=0)))
    return col_var > row_var * 1.2


def _central_gutter_width(img):
    """中央书缝白带宽度（占图宽%）。
    双页并排照片: 中缝=左页右边距+物理空隙+右页左边距，白带≥5%；
    单张横版页(双栏试卷): 栏距窄(<5%)或中央有墨迹。
    v8.4: 防止旋转修复后，横版单页落入 1.2~1.6 宽高比区间被错切两半。"""
    import cv2
    sw = 800
    sc = sw / img.shape[1]
    small = cv2.resize(img, (sw, max(1, int(img.shape[0] * sc))))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    bw = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                               cv2.THRESH_BINARY_INV, 15, 10)
    prof = bw.sum(axis=0) / 255.0
    if prof.max() > 0:
        prof = prof / prof.max()
    lo, hi = int(sw * 0.40), int(sw * 0.60)
    best = cur = 0
    for v in prof[lo:hi]:
        cur = cur + 1 if v < 0.02 else 0
        best = max(best, cur)
    return best / sw * 100.0


@app.route('/prepare-pages', methods=['POST'])
def prepare_pages():
    """
    页面准备：将手机拍摄的试卷照片转为独立页面
    0. 裁切背景 — 自动检测试卷边缘，裁掉桌面/背景
    1. 自动旋转 — 横版且文字横躺才转正（v8.4 投影方差判别，不再只看宽高比）
    2. 水平分页 — 双页并排(宽高比1.2~1.6 + 中央书缝白带≥5%)才从中间切开
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

            # Step 1: Auto-rotate (v8.4 内容感知)
            # 仅当横版且文字确实横躺（投影方差判别）才旋转；
            # 修复: 正向横版扫描件(1707x1280等)曾被无条件旋转，下游crop/VL全变横躺
            h, w = img.shape[:2]
            rotated = False
            if w > h and w > 1000:
                import cv2
                if _text_is_sideways(img):
                    img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
                    h, w = img.shape[:2]
                    rotated = True
                    print(f"  Photo {photo_idx}: auto-rotated 90° → {w}x{h}", flush=True)
                else:
                    print(f"  Photo {photo_idx}: landscape but text upright, no rotation ({w}x{h})", flush=True)

            # Step 2: Horizontal split (v8.4 加书缝判别)
            # 宽高比 1.2~1.6 且中央有书缝白带(≥5%)才是真正的双页并排；
            # 单张横版页(双栏排版)同样落在该宽高比区间，但中缝有墨迹/栏距<5%
            aspect = w / h if h > 0 else 1
            gutter = _central_gutter_width(img) if (1.2 <= aspect <= 1.6 and w > 800) else 0.0
            if 1.2 <= aspect <= 1.6 and w > 800 and gutter >= 5.0:
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
                print(f"  Photo {photo_idx}: single page (aspect={aspect:.2f}, gutter={gutter:.1f}%)", flush=True)

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

@app.route('/textin/ocr-merged', methods=['POST'])
def textin_ocr_merged():
    """
    TextIn OCR (逐页) + LLM 全试卷合并解析
    输入: {"images": ["base64...", ...], "options": {"subject": "英语"}}
    输出: {"status":"ok", "result": {"questions":[...], "engine":"textin-llm-merged"}}

    流程: 逐页 TextIn OCR → 合并所有 detail items → LLM 全试卷解析
    """
    try:
        from src.textin.client import TextInClient
        from src.textin.llm_parser import parse_by_sections, parse_all_pages_llm
        import cv2, tempfile

        app_id, secret = _get_textin_credentials()
        if not app_id or not secret:
            return jsonify({"status": "error", "error": "TextIn 未配置"}), 503

        data = request.get_json(force=True)
        if not data or 'images' not in data:
            return jsonify({'status': 'error', 'error': '缺少images数组'}), 400

        images_b64 = data['images']
        if not isinstance(images_b64, list) or len(images_b64) == 0:
            return jsonify({'status': 'error', 'error': 'images必须是数组'}), 400

        options = data.get('options', {})
        subject = options.get('subject', '英语')

        client = TextInClient(app_id, secret, timeout=60)
        all_detail_items = []
        merged_hw_regions = []  # v8.4: 手写区域（带 pageIndex，供 Phase 2 交叉验证）
        temp_files = []

        # Phase 1: TextIn OCR per page (parallelizable, sequential for now)
        for pi, img_b64 in enumerate(images_b64):
            img = b64_to_cv2(img_b64)
            if img is None or img.size == 0:
                return jsonify({'status': 'error', 'error': f'Page {pi+1} 无法解码'}), 400

            with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
                cv2.imwrite(tmp.name, img)
                tmp_path = tmp.name
                temp_files.append(tmp_path)

            parse_result = client.parse_document(tmp_path)
            if not parse_result.success:
                return jsonify({'status': 'error', 'error': f'Page {pi+1} TextIn失败: {parse_result.message}'}), 500

            detail_items = parse_result.raw_json.get('detail', [])
            if not detail_items:
                for key in ['elements', 'lines', 'text_blocks']:
                    if key in parse_result.raw_json:
                        detail_items = parse_result.raw_json[key]
                        break

            # 提取手写区域坐标（与 /textin/ocr 相同逻辑，附 pageIndex）
            for item in detail_items:
                tags = item.get('tags', [])
                if 'handwritten' in tags:
                    pos = item.get('position', [])
                    if pos and len(pos) >= 8:
                        xs = [pos[i] for i in range(0, len(pos), 2)]
                        ys = [pos[i] for i in range(1, len(pos), 2)]
                        merged_hw_regions.append({
                            'text': item.get('text', '')[:50],
                            'bbox': {
                                'x': int(min(xs)), 'y': int(min(ys)),
                                'w': int(max(xs) - min(xs)), 'h': int(max(ys) - min(ys))
                            },
                            'confidence': item.get('confidence', 0),
                            'pageIndex': pi + 1
                        })

            all_detail_items.append(detail_items)
            print(f"TextIn OCR-merged P{pi+1}: {len(detail_items)} detail items", flush=True)

        # Clean up temp files
        for tmp_path in temp_files:
            Path(tmp_path).unlink(missing_ok=True)

        if not all_detail_items or all(len(d) == 0 for d in all_detail_items):
            return jsonify({'status': 'error', 'error': '所有页面均无 detail items'}), 500

        total_items = sum(len(d) for d in all_detail_items)
        print(f"TextIn OCR-merged: {len(all_detail_items)} pages, {total_items} total items, "
              f"{len(merged_hw_regions)} handwritten regions, starting LLM...", flush=True)

        # Phase 2: LLM section-based parsing (★ v2.0)
        # Tries section-aware parsing first, falls back to full-paper, then regex
        result = parse_by_sections(all_detail_items, subject=subject)
        if not result:
            print("TextIn OCR-merged: section-based LLM failed, trying full-paper fallback...", flush=True)
            result = parse_all_pages_llm(all_detail_items, subject=subject)

        if not result:
            # Last resort: per-page regex parsing
            print("TextIn OCR-merged: LLM failed, falling back to per-page regex", flush=True)
            from src.textin.parser import parse_xparse_result
            all_questions = []
            for pi, items in enumerate(all_detail_items):
                page_result = parse_xparse_result(items, subject=subject)
                all_questions.extend(page_result.get('questions', []))
            result = {
                'questions': all_questions,
                'passages': [],
                'engine': 'textin-regex-fallback',
                'image_size': {},
                'raw_count': len(all_questions),
                'page_status': ['regex'] * len(all_detail_items),  # v2.9 ①: 全 regex 页
            }

        result['handwritten_regions'] = merged_hw_regions
        result['detail_count'] = total_items
        # v2.9 ①: 页级状态与每页 item 数（llm_parser 已带 page_status，兜底补 ok）
        result.setdefault('page_status', ['ok'] * len(all_detail_items))
        result['page_item_counts'] = [len(d) for d in all_detail_items]

        return jsonify({
            'status': 'ok',
            'result': result
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'error': str(e)}), 500


# ═══════════════════════════════════════════════════════════════════
# v5.0 识别主力: TextIn v3 智能抽取 + 本地五层完善（exam_pipeline）
# 离线验收: 高一下 94/95 (98.9%) / 澜大 29/29，零幻觉
# ═══════════════════════════════════════════════════════════════════
@app.route('/exam/extract', methods=['POST'])
def exam_extract():
    """整卷识别主力端点（替代 LLM 解析）。

    输入: {"images": ["base64..."], "options": {"subject": "英语"}}
    流程: 每页 v3 entity_extraction(dewarp) + xParse OCR(detail items, L2/L3用)
          → run_refinement (L1题号修复/L2缺失恢复/L3学生答案/L4bbox/L5校验)
    输出: 与 /textin/ocr-merged 同形状（questions/handwritten_regions/page_status...）
    """
    try:
        from src.textin.client import TextInClient
        from src.textin import exam_pipeline as ep
        import base64 as _b64
        import tempfile

        app_id, secret = _get_textin_credentials()
        if not app_id or not secret:
            return jsonify({'status': 'error', 'error': 'TextIn 未配置'}), 503

        data = request.get_json(force=True)
        images_b64 = data.get('images') or []
        if not isinstance(images_b64, list) or len(images_b64) == 0:
            return jsonify({'status': 'error', 'error': '缺少images数组'}), 400

        client = TextInClient(app_id, secret, timeout=180)
        questions = []
        ocr_items_by_page = {}
        hw_regions = []
        page_status = []
        page_item_counts = []
        temp_files = []

        for pi, img_b64 in enumerate(images_b64):
            raw = img_b64.split(',')[-1] if ',' in img_b64 else img_b64

            # v8.5 方向解耦（坐标实证修正版）:
            # - v3 智能抽取: 横版页提交竖版副本(旋转90°CW)抽取质量显著更好(P1 21题 vs 10题);
            #   v3 服务端会自动转正并**直接返回正向横版帧坐标**(Q43锚点实证: 返回(65,77)恰为
            #   原图左上角Q43区), 故不做任何坐标变换。
            # - xParse OCR: 提交横版原图, 返回坐标即横版帧, 与 _cropSrc/红笔质心同帧。
            _img = None
            _port = None
            try:
                import cv2
                _img = cv2.imdecode(np.frombuffer(_b64.b64decode(raw), dtype=np.uint8), cv2.IMREAD_COLOR)
                if _img is not None and _img.shape[1] > _img.shape[0]:
                    _port = cv2.rotate(_img, cv2.ROTATE_90_CLOCKWISE)
                    print(f"Exam P{pi+1}: landscape {_img.shape[1]}x{_img.shape[0]} → portrait copy for v3", flush=True)
            except Exception as _e:
                _img = None
                print(f"Exam P{pi+1}: orientation precheck failed ({_e}), submit as-is", flush=True)

            def _to_b64(arr, quality=92, trim=0):
                """ndarray → jpeg b64（quality/trim 扰动用于 v3 多次采样不同抽取）"""
                import cv2
                a = arr
                if trim > 0 and a.shape[0] > 40 and a.shape[1] > 40:
                    ty, tx = int(a.shape[0] * trim), int(a.shape[1] * trim)
                    a = a[ty:-ty, tx:-tx]
                return _b64.b64encode(
                    cv2.imencode('.jpg', a, [cv2.IMWRITE_JPEG_QUALITY, quality])[1].tobytes()
                ).decode()

            # v8.6: v3 双发扰动采样（相同字节相同结果，需扰动输入）
            if _port is not None:
                variants = [_to_b64(_port, 92), _to_b64(_port, 88)]
            else:
                variants = [raw]

            # 1) xParse OCR（横版原图 — 返回坐标即横版帧，与v3自动转正坐标同帧）
            try:
                with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as tmp:
                    tmp.write(_b64.b64decode(raw))
                    temp_files.append(tmp.name)
                parse_result = client.parse_document(tmp.name)
                items = parse_result.raw_json.get('detail', []) if parse_result.success else []
            except Exception as ocr_err:
                print(f"Exam P{pi+1}: OCR error {ocr_err}", flush=True)
                items = []
            ocr_items_by_page[pi + 1] = items
            page_item_counts.append(len(items))
            # handwritten regions（与 ocr-merged 相同形状）
            for it in items:
                if 'handwritten' in (it.get('tags') or []):
                    pos = it.get('position') or []
                    if len(pos) >= 8:
                        xs = [pos[k] for k in range(0, len(pos), 2)]
                        ys = [pos[k] for k in range(1, len(pos), 2)]
                        hw_regions.append({
                            'text': (it.get('text') or '')[:50],
                            'bbox': {'x': int(min(xs)), 'y': int(min(ys)),
                                     'w': int(max(xs) - min(xs)), 'h': int(max(ys) - min(ys))},
                            'pageIndex': pi + 1
                        })

            # 2) v3 智能抽取（dewarp=1）— v8.6 双发取优 + OCR可信度选择
            #    v3 单次尝试是抽签: 好则全对(21题/真题号)，坏则整页丢题(5题)或
            #    伪造顺序题号(实测 P2 真Q24-42 被标成 11-22)。
            #    选择器: 可信度 = v3题号命中本页OCR印刷题号集合的比例；
            #    可信度≥0.6 的尝试中取题数最多者，全不可信则退回题数最多。
            def _v3_attempt(variant_b64):
                # 注: v3 返回坐标已在正向(自动转正)帧，直接使用，不做变换
                v3x = ep.call_v3_extract(variant_b64, app_id, secret, timeout=180)
                return ep.parse_v3_page(v3x, pi + 1) if v3x else []

            # OCR 印刷题号集合: 题号常与选项A粘连("1.A.at ease")或带噪声前缀("CD75.A...")
            ocr_num_tokens = set()
            for it in items:
                m2 = re.match(r'^[A-Za-z]{0,3}\s*(\d{1,3})\s*[.、]', (it.get('text') or '').strip())
                if m2:
                    ocr_num_tokens.add(int(m2.group(1)))

            def _cred(qs):
                if not qs:
                    return 0.0
                hit = sum(1 for q in qs if q.get('questionNumber') in ocr_num_tokens)
                return hit / len(qs)

            # 前页已选题号最大值 — 伪造尝试的题号会大量重叠前页(实测 P2 伪造11-22
            # 重叠 P1 的 1-21 共11题)，真题号是顺延的(24-42 零重叠)
            _prev_max = max((q.get('questionNumber') or 0 for q in questions), default=0)

            def _ovl_ratio(a):
                if not a or not _prev_max:
                    return 0.0
                nums = [q.get('questionNumber') or 0 for q in a]
                return sum(1 for n in nums if 0 < n <= _prev_max) / len(nums)

            def _pick(cands):
                sane = [a for a in cands if _ovl_ratio(a) <= 0.34]
                pool = sane if sane else cands
                good = [a for a in pool if _cred(a) >= 0.6]
                pool2 = good if good else pool
                return max(pool2, key=lambda a: (len(a), round(_cred(a), 2)))

            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
                futs = [ex.submit(_v3_attempt, v) for v in variants[:2]]
                attempts = [f.result() for f in futs]
            page_qs = _pick(attempts)

            expect_min = max(6, len(items) // 8)
            if 0 < len(page_qs) < expect_min:
                print(f"Exam P{pi+1}: v3 低产出 {len(page_qs)} < 预期 {expect_min}，第三变体...", flush=True)
                third = _to_b64(_port if _port is not None else _img, 92, trim=0.01) if (_port is not None or _img is not None) else variants[0]
                attempts.append(_v3_attempt(third))
                page_qs = _pick(attempts)
            _best_cred = _cred(page_qs)
            print(f"Exam P{pi+1}: v3 attempts={[len(a) for a in attempts]} cred={[round(_cred(a),2) for a in attempts]} → pick {len(page_qs)} (cred={_best_cred:.2f})", flush=True)
            if page_qs:
                questions.extend(page_qs)
                page_status.append('ok')
                print(f"Exam P{pi+1}: v3 extract {len(page_qs)} questions", flush=True)
            else:
                page_status.append('v3_failed')
                print(f"Exam P{pi+1}: v3 extract FAILED", flush=True)

        for tf in temp_files:
            Path(tf).unlink(missing_ok=True)

        # 3) 五层完善
        stats = ep.run_refinement(questions, ocr_items_by_page)
        print(f"Exam refinement: qnFixes={stats['qnFixes']} recovered={stats['recovered']} "
              f"answers={stats['answersAttached']} bboxes={stats['bboxesBuilt']}/{len(questions)}", flush=True)

        # 4) 转输出形状（去内部字段）
        out_qs = []
        for q in questions:
            out_qs.append({
                'questionNumber': q['questionNumber'],
                'questionType': q.get('questionType', 'choice'),
                'questionText': q.get('questionText', ''),
                'options': q.get('options', {}),
                'passageText': q.get('passageText', ''),
                'studentAnswer': q.get('studentAnswer', ''),
                'bbox': q.get('bbox') or q.get('qnBbox') or {'x': 0, 'y': 0, 'w': 0, 'h': 0},
                'pageIndex': q.get('pageIndex', 1),
                'confidence': q.get('confidence', 'high'),
                '_qnCorrected': bool(q.get('_qnCorrected')),
                '_source': q.get('_source', 'textin-v3'),
            })

        return jsonify({
            'status': 'ok',
            'result': {
                'questions': out_qs,
                'passages': [],
                'engine': 'textin-v3-exam+refine-v5',
                'image_size': {},
                'raw_count': len(out_qs),
                'handwritten_regions': hw_regions,
                'detail_count': sum(page_item_counts),
                'page_status': page_status,
                'page_item_counts': page_item_counts,
                'qn_corrections': stats['qnFixes'],
            }
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({'status': 'error', 'error': str(e)}), 500


@app.route('/textin/ocr', methods=['POST'])
def textin_ocr():
    """
    TextIn OCR + 题目解析 — 单页管线（向后兼容）
    输入: {"image": "base64...", "options": {"subject": "英语"}}
    输出: {"status":"ok", "result": {"questions":[...], "passages":[...], "engine":"..."}}

    流程: 加载图片 → TextIn 识别 → LLM/regex 题目解析
    """
    try:
        from src.textin.client import TextInClient
        from src.textin.parser import parse_xparse_result
        from src.textin.llm_parser import parse_with_llm_fallback
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

            print(f"TextIn OCR: {len(detail_items)} detail items", flush=True)

            # LLM 题目解析 (v4.7) — LLM 优先, regex 回退
            result = parse_with_llm_fallback(
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
            result['detail_count'] = len(detail_items)
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
