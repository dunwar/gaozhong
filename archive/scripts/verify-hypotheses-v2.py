#!/usr/bin/env python3
"""
假设验证 v2: 精确的红笔符号检测
改进: 面积过滤、位置上下文、多特征分类
"""
import cv2
import numpy as np
import json
import os

IMAGE_PATH = '/app/data/papers/4a96c145/page_1.jpg'
OUTPUT_DIR = '/home/node/.openclaw/workspace/www/gaozhong.online/output/hypothesis-verify'
os.makedirs(OUTPUT_DIR, exist_ok=True)

def hsv_separate_red(img):
    """HSV 红色分离 - 宽松但会后续过滤"""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    m1 = cv2.inRange(hsv, np.array([0, 30, 30]), np.array([15, 255, 255]))
    m2 = cv2.inRange(hsv, np.array([150, 30, 30]), np.array([180, 255, 255]))
    return cv2.bitwise_or(m1, m2)

def classify_symbol_v2(contour):
    """改进的分类器：使用更多几何特征"""
    x, y, w, h = cv2.boundingRect(contour)
    area = cv2.contourArea(contour)
    peri = cv2.arcLength(contour, True)
    
    if area < 40 or area > 3000:
        return None, 0, {}
    
    # 最小外接矩形
    rect = cv2.minAreaRect(contour)
    rw, rh = rect[1]
    if rw == 0 or rh == 0:
        return None, 0, {}
    
    # 特征
    aspect = max(rw, rh) / max(min(rw, rh), 1)
    bbox_area = w * h
    fill_ratio = area / bbox_area if bbox_area > 0 else 0
    extent = area / (rw * rh) if rw * rh > 0 else 0  # 轮廓面积 / 旋转矩形面积
    solidity = area / cv2.contourArea(cv2.convexHull(contour)) if cv2.contourArea(cv2.convexHull(contour)) > 0 else 0
    
    # 圆形度
    circularity = 4 * np.pi * area / (peri * peri) if peri > 0 else 0
    
    # 凸包缺陷
    hull = cv2.convexHull(contour, returnPoints=False)
    defects = None
    try:
        defects = cv2.convexityDefects(contour, hull)
    except:
        pass
    
    num_defects = 0
    max_depth = 0
    if defects is not None and len(defects) > 0:
        num_defects = len(defects)
        for d in defects:
            _, _, _, depth = d[0]
            if depth / 256.0 > max_depth:
                max_depth = depth / 256.0
    
    features = {
        'area': int(area), 'aspect': round(aspect, 2),
        'fill_ratio': round(fill_ratio, 3), 'extent': round(extent, 3),
        'solidity': round(solidity, 3), 'circularity': round(circularity, 3),
        'defects': num_defects, 'max_depth': round(max_depth, 3)
    }
    
    # === 排除规则 ===
    # 长条状 → 下划线/删除线
    if aspect > 5 and fill_ratio < 0.3:
        return 'underline', 0, features
    if aspect > 4 and area < 150:
        return 'underline', 0, features
    
    # 高度圆形 → 圈/O 符号
    if circularity > 0.7 and aspect < 1.5:
        return 'circle', 0, features
    
    # 太扁或太窄
    if aspect > 4:
        return 'line', 0, features
    
    # === 分类逻辑 ===
    cross_score = 0
    check_score = 0
    
    # ✗ 线索：两个笔画交叉 → 低填充率 + 凸包缺陷
    if fill_ratio < 0.25:
        cross_score += 3
    if num_defects >= 3:
        cross_score += 3
    if max_depth > 0.25:
        cross_score += 2
    if solidity < 0.7:
        cross_score += 2
    if 0.7 < aspect < 2.5 and fill_ratio < 0.22:
        cross_score += 2
    
    # ✓ 线索：单笔画弯曲 → 较高填充率 + 细长
    if fill_ratio > 0.18:
        check_score += 2
    if 1.5 < aspect < 4.0:
        check_score += 2
    if solidity > 0.65:
        check_score += 2
    if num_defects <= 2:
        check_score += 1
    if extent > 0.4:
        check_score += 1
    
    # 决策
    if cross_score >= 5 and cross_score > check_score:
        return 'cross', cross_score, features
    elif check_score >= 5 and check_score > cross_score:
        return 'check', check_score, features
    elif cross_score >= 3 or check_score >= 3:
        return 'uncertain', min(cross_score, check_score), features
    else:
        return None, 0, features

def detect_symbols(red_mask, min_area=40, max_area=3000):
    """检测并分类红笔符号"""
    # 形态学：闭运算连接断笔
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    closed = cv2.morphologyEx(red_mask, cv2.MORPH_CLOSE, kernel)
    
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    symbols = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        area = cv2.contourArea(c)
        
        if area < min_area or area > max_area:
            continue
        
        sym_type, conf, feats = classify_symbol_v2(c)
        if sym_type in ('cross', 'check', 'uncertain'):
            symbols.append({
                'type': sym_type,
                'confidence': conf,
                'x': int(x), 'y': int(y), 'w': int(w), 'h': int(h),
                'area': int(area),
                'cx': int(x + w//2), 'cy': int(y + h//2),
                'features': feats
            })
    
    return symbols, closed

def find_option_regions(img):
    """用 OCR 思路找选项 A/B/C/D 区域（通过印刷体识别间接定位）"""
    # 简单方法：在图片上找 "A. " "B. " "C. " "D. " 文本区域
    # 这里使用 PaddleOCR 的替代方案：用像素密度寻找文本块
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    
    # 找到所有文本块的轮廓
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    # 筛选小轮廓（单个字母/数字大小的区域）
    text_regions = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        area = cv2.contourArea(c)
        if 30 < area < 500 and 5 < w < 50 and 5 < h < 50:
            text_regions.append((x, y, w, h))
    
    return text_regions

def match_symbols_to_options(symbols, text_regions, distance_threshold=50):
    """将红笔符号匹配到最近的选项区域"""
    matched = []
    for sym in symbols:
        sx, sy = sym['cx'], sym['cy']
        nearest = None
        nearest_dist = distance_threshold
        
        for (tx, ty, tw, th) in text_regions:
            tcx, tcy = tx + tw//2, ty + th//2
            dist = np.sqrt((sx - tcx)**2 + (sy - tcy)**2)
            if dist < nearest_dist:
                nearest_dist = dist
                nearest = (tcx, tcy)
        
        sym['nearest_text'] = nearest
        sym['text_distance'] = round(nearest_dist, 1) if nearest else None
        matched.append(sym)
    
    return matched

def main():
    print('=' * 60)
    print('  假设验证 v2: 精确红笔符号检测')
    print('  试卷: yingyu34')
    print('=' * 60)
    
    img = cv2.imread(IMAGE_PATH)
    h, w = img.shape[:2]
    print(f'\n📷 图片: {w}×{h}')
    
    # 步骤1: HSV 分离
    red_mask = hsv_separate_red(img)
    red_px = cv2.countNonZero(red_mask)
    print(f'红笔像素: {red_px} ({100*red_px/(w*h):.1f}%)')
    
    # 步骤2: 符号检测
    symbols, cleaned = detect_symbols(red_mask)
    
    crosses = [s for s in symbols if s['type'] == 'cross']
    checks = [s for s in symbols if s['type'] == 'check']
    uncertain = [s for s in symbols if s['type'] == 'uncertain']
    
    print(f'\n检测结果:')
    print(f'  ✗ cross:     {len(crosses)}')
    print(f'  ✓ check:     {len(checks)}')
    print(f'  ? uncertain: {len(uncertain)}')
    print(f'  总计:        {len(symbols)}')
    
    # 步骤3: 找选项区域
    text_regions = find_option_regions(img)
    symbols_matched = match_symbols_to_options(symbols, text_regions)
    
    near_option = [s for s in symbols_matched if s['text_distance'] is not None and s['text_distance'] < 30]
    print(f'\n距选项文字 <30px 的符号: {len(near_option)}')
    
    # 详细列出
    print('\n--- ✗ cross 列表 ---')
    for i, s in enumerate(crosses):
        f = s['features']
        near = f" 距文字{s['text_distance']}px" if s['text_distance'] else ''
        print(f"  X{i+1}: ({s['cx']:4d},{s['cy']:4d}) {s['w']:2d}×{s['h']:2d} "
              f"area={s['area']:4d} fill={f['fill_ratio']:.2f} def={f['defects']} "
              f"depth={f['max_depth']:.2f} sol={f['solidity']:.2f}{near}")
    
    print('\n--- ✓ check 列表 ---')
    for i, s in enumerate(checks):
        f = s['features']
        near = f" 距文字{s['text_distance']}px" if s['text_distance'] else ''
        print(f"  V{i+1}: ({s['cx']:4d},{s['cy']:4d}) {s['w']:2d}×{s['h']:2d} "
              f"area={s['area']:4d} fill={f['fill_ratio']:.2f} def={f['defects']} "
              f"depth={f['max_depth']:.2f} sol={f['solidity']:.2f}{near}")
    
    # 生成标注图
    annotated = img.copy()
    for s in crosses:
        cv2.rectangle(annotated, (s['x'], s['y']), (s['x']+s['w'], s['y']+s['h']), (0, 0, 255), 2)
        cv2.putText(annotated, f"X{crosses.index(s)+1}", (s['x']-5, max(s['y']-5, 10)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 0, 255), 1)
    for s in checks:
        cv2.rectangle(annotated, (s['x'], s['y']), (s['x']+s['w'], s['y']+s['h']), (0, 255, 0), 2)
        cv2.putText(annotated, f"V{checks.index(s)+1}", (s['x']-5, max(s['y']-5, 10)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 255, 0), 1)
    for s in uncertain:
        cv2.rectangle(annotated, (s['x'], s['y']), (s['x']+s['w'], s['y']+s['h']), (255, 200, 0), 2)
    
    cv2.imwrite(os.path.join(OUTPUT_DIR, '5_symbols_v2.jpg'), annotated)
    print(f'\n💾 标注图: {OUTPUT_DIR}/5_symbols_v2.jpg')
    
    # 保存结果
    result = {
        'image_size': f'{w}x{h}',
        'red_px_pct': round(100*red_px/(w*h), 1),
        'crosses': len(crosses), 'checks': len(checks), 'uncertain': len(uncertain),
        'cross_list': [{k: v for k, v in s.items() if k != 'features'} for s in crosses],
        'check_list': [{k: v for k, v in s.items() if k != 'features'} for s in checks],
        'uncertain_list': [{k: v for k, v in s.items() if k != 'features'} for s in uncertain]
    }
    with open(os.path.join(OUTPUT_DIR, 'verify-v2.json'), 'w') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

if __name__ == '__main__':
    main()
