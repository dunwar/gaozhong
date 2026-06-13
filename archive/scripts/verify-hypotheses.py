#!/usr/bin/env python3
"""
验证两个核心假设：
假设1: OpenCV 轮廓分析能区分 ✓✗ (目标 ≥85%)
假设2: PaddleOCR 能识别手写英文答案 (目标 ≥70%)

试卷: yingyu34 (4a96c145/page_1.jpg)
"""
import cv2
import numpy as np
import json
import os
import sys

IMAGE_PATH = '/app/data/papers/4a96c145/page_1.jpg'
OUTPUT_DIR = '/home/node/.openclaw/workspace/www/gaozhong.online/output/hypothesis-verify'
os.makedirs(OUTPUT_DIR, exist_ok=True)

def hsv_separate_channels(img):
    """HSV 颜色分离：红笔通道 + 黑蓝通道"""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    
    # 红色在 HSV 中有两个区间（0-15 和 150-180），S 阈值降到 30（实际红笔 S 低至 19）
    lower_red1 = np.array([0, 30, 30])
    upper_red1 = np.array([15, 255, 255])
    lower_red2 = np.array([150, 30, 30])
    upper_red2 = np.array([180, 255, 255])
    
    mask_red1 = cv2.inRange(hsv, lower_red1, upper_red1)
    mask_red2 = cv2.inRange(hsv, lower_red2, upper_red2)
    red_mask = cv2.bitwise_or(mask_red1, mask_red2)
    
    # 黑蓝通道 = 非红色
    blackblue_mask = cv2.bitwise_not(red_mask)
    
    # 生成分离图
    red_only = cv2.bitwise_and(img, img, mask=red_mask)
    blackblue_only = cv2.bitwise_and(img, img, mask=blackblue_mask)
    
    return red_mask, red_only, blackblue_only

def classify_symbol(contour):
    """根据轮廓几何特征分类 ✓ 或 ✗ 或 其他"""
    x, y, w, h = cv2.boundingRect(contour)
    area = cv2.contourArea(contour)
    peri = cv2.arcLength(contour, True)
    
    if area < 20:  # 太小，噪声
        return None, 0
    
    # 凸包分析
    hull = cv2.convexHull(contour)
    hull_area = cv2.contourArea(hull)
    if hull_area == 0:
        return None, 0
    
    solidity = area / hull_area
    
    # 最小外接矩形（旋转）
    rect = cv2.minAreaRect(contour)
    box = cv2.boxPoints(rect)
    box = np.int32(box)
    rect_w, rect_h = rect[1]
    if rect_w == 0 or rect_h == 0:
        return None, 0
    
    aspect_ratio = max(rect_w, rect_h) / min(rect_w, rect_h)
    
    # 轮廓的极端点（用于检测勾的特征）
    # ✓ 的特征：左低右高、有一个向上的弯曲
    # ✗ 的特征：两条交叉线
    
    # === ✗ (cross) 检测 ===
    # 方法1: 轮廓面积 vs 边界框面积比 — ✗ 是两条线交叉，填充率低
    bbox_area = w * h
    fill_ratio = area / bbox_area if bbox_area > 0 else 0
    
    # 方法2: 凸包缺陷分析 — ✗ 有较大的凹陷（交叉点）
    try:
        defects = cv2.convexityDefects(contour, cv2.convexHull(contour, returnPoints=False))
        num_defects = len(defects) if defects is not None else 0
        
        # 找最深缺陷
        max_defect_depth = 0
        if defects is not None:
            for d in defects:
                _, _, _, depth = d[0]
                depth_ratio = depth / 256.0
                if depth_ratio > max_defect_depth:
                    max_defect_depth = depth_ratio
    except:
        num_defects = 0
        max_defect_depth = 0
    
    # 方法3: Hu 矩形状匹配
    moments = cv2.moments(contour)
    hu = cv2.HuMoments(moments)
    
    # === 分类逻辑 ===
    cross_score = 0
    check_score = 0
    
    # ✗ 的线索
    if fill_ratio < 0.25:
        cross_score += 2
    if num_defects >= 3:
        cross_score += 2
    if max_defect_depth > 0.3:
        cross_score += 2
    if aspect_ratio > 2.5 and fill_ratio < 0.3:
        cross_score += 1  # 细长+低填充 → 可能是交叉线
    if 0.7 < aspect_ratio < 2.5 and fill_ratio < 0.2:
        cross_score += 2  # 近似正方形但填充极低 → 交叉
    
    # ✓ 的线索
    if aspect_ratio > 2.0 and fill_ratio > 0.15:
        check_score += 2  # 细长但有填充 → 可能是勾
    if solidity > 0.7:
        check_score += 1  # 高凸性 → 更像单笔画的勾
    if 0.3 < fill_ratio < 0.5 and num_defects <= 2:
        check_score += 1
    if 1.5 < aspect_ratio < 4.0 and solidity > 0.65:
        check_score += 1
    
    if cross_score > check_score and cross_score >= 3:
        return 'cross', max(cross_score, 1)
    elif check_score > cross_score and check_score >= 3:
        return 'check', max(check_score, 1)
    elif cross_score > 0 or check_score > 0:
        return 'uncertain', min(cross_score, check_score)
    else:
        return None, 0

def detect_red_symbols(red_mask):
    """在红笔通道上检测 ✓✗ 符号"""
    # 形态学操作：闭运算连接断笔，开运算去噪
    kernel_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    kernel_open = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    
    # 先闭后开
    closed = cv2.morphologyEx(red_mask, cv2.MORPH_CLOSE, kernel_close)
    cleaned = cv2.morphologyEx(closed, cv2.MORPH_OPEN, kernel_open)
    
    # 轮廓检测
    contours, hierarchy = cv2.findContours(cleaned, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    symbols = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        area = cv2.contourArea(contour)
        
        # 过滤太小的区域（噪声）
        if area < 30:
            continue
        
        # 过滤太大的区域（可能是大片红笔涂改）
        if area > 5000:
            continue
        
        # 过滤不合理长宽比的水平/垂直线（可能是下划线/删除线）
        if (w > h * 5 or h > w * 5) and area < 200:
            continue
        
        sym_type, confidence = classify_symbol(contour)
        if sym_type:
            symbols.append({
                'type': sym_type,
                'confidence': confidence,
                'x': int(x), 'y': int(y),
                'w': int(w), 'h': int(h),
                'area': int(area),
                'cx': int(x + w//2),
                'cy': int(y + h//2)
            })
    
    return symbols, cleaned

def run_paddleocr_on_red(red_only, symbols):
    """在红笔通道上运行 PaddleOCR，识别手写文字"""
    try:
        from paddleocr import PaddleOCR
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            ocr = PaddleOCR(lang='en')
    except Exception as e:
        print(f"PaddleOCR init failed: {str(e)[:100]}, skipping OCR test")
        return []
    
    # 转为灰度图
    gray = cv2.cvtColor(red_only, cv2.COLOR_BGR2GRAY)
    
    # 对每个符号区域附近的文字做 OCR
    results = []
    
    for sym in symbols:
        # 扩展检测区域（符号附近通常有批改文字）
        x1 = max(0, sym['x'] - 30)
        y1 = max(0, sym['y'] - 20)
        x2 = min(gray.shape[1], sym['x'] + sym['w'] + 30)
        y2 = min(gray.shape[0], sym['y'] + sym['h'] + 20)
        
        crop = gray[y1:y2, x1:x2]
        if crop.size == 0:
            continue
        
        # PaddleOCR 识别
        try:
            ocr_result = ocr.ocr(crop, det=False, cls=False)
            if ocr_result and ocr_result[0]:
                text = ocr_result[0][0][0]
                conf = ocr_result[0][0][1]
                results.append({
                    'symbol_at': f"({sym['cx']},{sym['cy']})",
                    'symbol_type': sym['type'],
                    'text': text,
                    'ocr_confidence': round(conf, 2),
                    'region': f"({x1},{y1})-({x2},{y2})"
                })
        except Exception as e:
            pass
    
    return results

def main():
    print('=' * 60)
    print('  假设验证: OpenCV 符号检测 + PaddleOCR 手写识别')
    print('  试卷: yingyu34')
    print('=' * 60)
    
    img = cv2.imread(IMAGE_PATH)
    if img is None:
        print(f'ERROR: Cannot read {IMAGE_PATH}')
        sys.exit(1)
    
    h, w = img.shape[:2]
    print(f'\n📷 图片尺寸: {w}×{h}')
    
    # ====== 步骤1: HSV 颜色分离 ======
    print('\n--- 步骤1: HSV 颜色分离 ---')
    red_mask, red_only, blackblue_only = hsv_separate_channels(img)
    red_pixels = cv2.countNonZero(red_mask)
    total_pixels = red_mask.shape[0] * red_mask.shape[1]
    print(f'红笔像素: {red_pixels} / {total_pixels} ({100*red_pixels/total_pixels:.1f}%)')
    
    # 保存分离图
    cv2.imwrite(os.path.join(OUTPUT_DIR, '1_red_mask.png'), red_mask)
    cv2.imwrite(os.path.join(OUTPUT_DIR, '2_red_only.jpg'), red_only)
    cv2.imwrite(os.path.join(OUTPUT_DIR, '3_blackblue_only.jpg'), blackblue_only)
    
    # ====== 步骤2: OpenCV 符号检测 ======
    print('\n--- 步骤2: OpenCV 符号检测 ---')
    symbols, cleaned_mask = detect_red_symbols(red_mask)
    
    crosses = [s for s in symbols if s['type'] == 'cross']
    checks = [s for s in symbols if s['type'] == 'check']
    uncertain = [s for s in symbols if s['type'] == 'uncertain']
    
    print(f'检测到 ✗ (cross):  {len(crosses)} 个')
    print(f'检测到 ✓ (check):  {len(checks)} 个')
    print(f'不确定:          {len(uncertain)} 个')
    print(f'总计符号:        {len(symbols)} 个')
    
    # 详细列表
    print('\n✗ (cross) 详情:')
    for s in crosses:
        print(f'  ({s["cx"]:4d},{s["cy"]:4d}) {s["w"]:3d}×{s["h"]:3d} area={s["area"]:4d} conf={s["confidence"]}')
    
    print('\n✓ (check) 详情:')
    for s in checks:
        print(f'  ({s["cx"]:4d},{s["cy"]:4d}) {s["w"]:3d}×{s["h"]:3d} area={s["area"]:4d} conf={s["confidence"]}')
    
    print('\n❓ 不确定:')
    for s in uncertain:
        print(f'  ({s["cx"]:4d},{s["cy"]:4d}) {s["w"]:3d}×{s["h"]:3d} area={s["area"]:4d} conf={s["confidence"]}')
    
    # 生成标注图
    annotated = img.copy()
    for s in crosses:
        cv2.rectangle(annotated, (s['x'], s['y']), (s['x']+s['w'], s['y']+s['h']), (0, 0, 255), 2)
        cv2.putText(annotated, f'X{crosses.index(s)+1}', (s['x']-5, s['y']-5), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 255), 1)
    for s in checks:
        cv2.rectangle(annotated, (s['x'], s['y']), (s['x']+s['w'], s['y']+s['h']), (0, 255, 0), 2)
        cv2.putText(annotated, f'V{checks.index(s)+1}', (s['x']-5, s['y']-5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 0), 1)
    for s in uncertain:
        cv2.rectangle(annotated, (s['x'], s['y']), (s['x']+s['w'], s['y']+s['h']), (255, 255, 0), 2)
        cv2.putText(annotated, f'?{uncertain.index(s)+1}', (s['x']-5, s['y']-5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 0), 1)
    
    cv2.imwrite(os.path.join(OUTPUT_DIR, '4_symbols_annotated.jpg'), annotated)
    
    # ====== 步骤3: PaddleOCR 手写识别 ======
    print('\n--- 步骤3: PaddleOCR 手写识别 ---')
    ocr_results = run_paddleocr_on_red(red_only, symbols[:20])  # 前20个符号
    
    if ocr_results:
        print(f'PaddleOCR 识别到 {len(ocr_results)} 个文本:')
        for r in ocr_results:
            print(f'  符号类型={r["symbol_type"]} @ {r["symbol_at"]}: "{r["text"]}" [{r["ocr_confidence"]:.2f}]')
    else:
        print('PaddleOCR 未识别到任何手写文本')
    
    # ====== 保存结果 ======
    result = {
        'image': IMAGE_PATH,
        'image_size': f'{w}x{h}',
        'red_pixels_pct': round(100*red_pixels/total_pixels, 1),
        'crosses': len(crosses),
        'checks': len(checks),
        'uncertain': len(uncertain),
        'total_symbols': len(symbols),
        'cross_list': [{k: v for k, v in s.items()} for s in crosses],
        'check_list': [{k: v for k, v in s.items()} for s in checks],
        'uncertain_list': [{k: v for k, v in s.items()} for s in uncertain],
        'ocr_results': ocr_results
    }
    
    with open(os.path.join(OUTPUT_DIR, 'verify-result.json'), 'w') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    
    print(f'\n💾 结果已保存: {OUTPUT_DIR}/')
    print(f'   - 1_red_mask.png       红笔通道掩码')
    print(f'   - 2_red_only.jpg       红笔分离图')
    print(f'   - 3_blackblue_only.jpg 黑蓝分离图')
    print(f'   - 4_symbols_annotated.jpg  符号标注图')
    print(f'   - verify-result.json   结构化结果')

if __name__ == '__main__':
    main()
