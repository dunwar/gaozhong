#!/usr/bin/env python3
"""
gaozhong.online — 红笔字符识别验证
Phase 0.2: 验证 PaddleOCR 对手写红笔文字的识别能力

测试：
  1. 红笔手写字母（A/B/C/D）识别
  2. 红笔手写单词/数字（fill-in answers）识别
  3. 红笔符号（✓✗）识别

用法: python3 scripts/test-red-ocr.py /app/data/papers/<sessionId>/page_1.jpg
"""

import cv2
import numpy as np
import sys
import os
import json
import importlib.metadata

# Monkey-patch for opencv-contrib-python dep check
orig_version = importlib.metadata.version
def patched_version(pkg):
    if pkg == 'opencv-contrib-python':
        return '4.10.0.84'
    return orig_version(pkg)
importlib.metadata.version = patched_version

from paddleocr import PaddleOCR

OUTPUT_DIR = 'output/red-ocr-test'

def hsv_extract_red(img_path):
    """提取红笔区域"""
    img = cv2.imread(img_path)
    if img is None: return None
    
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    
    # 红色 HSV 范围
    mask1 = cv2.inRange(hsv, np.array([0, 50, 50]), np.array([10, 255, 255]))
    mask2 = cv2.inRange(hsv, np.array([160, 50, 50]), np.array([180, 255, 255]))
    mask = cv2.bitwise_or(mask1, mask2)
    
    kernel = np.ones((2,2), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    
    # 红笔突出图（白底红字）
    red_overlay = np.ones_like(img) * 255
    red_overlay[mask > 0] = img[mask > 0]
    
    # 增强对比度
    gray = cv2.cvtColor(red_overlay, cv2.COLOR_BGR2GRAY)
    _, enhanced = cv2.threshold(gray, 240, 255, cv2.THRESH_BINARY_INV)
    
    # 反色为黑底红字 → 黑底白字（OCR 更好处理）
    inverted = cv2.bitwise_not(red_overlay)
    gray_inv = cv2.cvtColor(inverted, cv2.COLOR_BGR2GRAY)
    
    return {
        'img': img,
        'mask': mask,
        'red_overlay': red_overlay,
        'enhanced': enhanced,
        'inverted': inverted,
        'gray_inv': gray_inv,
        'basename': os.path.splitext(os.path.basename(img_path))[0]
    }

def detect_red_symbols(data):
    """检测红笔符号（✓✗ 几何分类改进版）"""
    mask = data['mask']
    
    kernel = np.ones((3,3), np.uint8)
    mask_dil = cv2.dilate(mask, kernel, iterations=1)
    
    contours, _ = cv2.findContours(mask_dil, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    symbols = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < 20: continue
        
        x, y, w, h = cv2.boundingRect(cnt)
        ar = w / max(h, 1)
        perimeter = cv2.arcLength(cnt, True)
        hull_area = cv2.contourArea(cv2.convexHull(cnt))
        solidity = area / hull_area if hull_area > 0 else 0
        circularity = 4 * np.pi * area / (perimeter * perimeter) if perimeter > 0 else 0
        
        rect = cv2.minAreaRect(cnt)
        extent = area / (rect[1][0] * rect[1][1]) if rect[1][0] > 0 else 0
        
        # 改进的分类逻辑
        stype = 'text_or_num'  # default: treat small compact regions as text
    
        if area < 100:
            if solidity < 0.4 and extent < 0.5 and 0.3 < ar < 3:
                stype = 'cross'  # ✗
            elif solidity > 0.7 and 0.5 < ar < 1.8:
                stype = 'dot_or_check'  # possibly ✓ or marker
        elif ar > 4 and area > 60:
            stype = 'underline'
        elif ar > 2.5 and solidity > 0.5:
            stype = 'underline'
        elif area > 150 and 0.2 < ar < 5 and solidity < 0.5:
            stype = 'cross_large'  # large ✗
        
        symbols.append({
            'id': len(symbols),
            'bbox': [int(x), int(y), int(w), int(h)],
            'area': int(area),
            'ar': round(ar, 2),
            'solidity': round(solidity, 2),
            'type': stype,
            'roi_base64': None
        })
    
    return symbols

def run_ocr(data, symbols, ocr):
    """在红笔通道上运行 PaddleOCR，提取手写红笔文字"""
    import base64
    
    # 使用增强后的红笔图（反色处理）
    img_for_ocr = data['red_overlay']
    
    # 保存临时图
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    tmp_path = f'{OUTPUT_DIR}/{data["basename"]}_red_for_ocr.jpg'
    cv2.imwrite(tmp_path, img_for_ocr)
    
    print(f'\nRunning PaddleOCR on red channel...')
    result = ocr.predict(tmp_path)
    
    texts = []
    if result and len(result) > 0:
        page = result[0]
        data_dict = page.json if isinstance(page.json, dict) else {}
        rec_texts = data_dict.get('res', {}).get('rec_texts', [])
        rec_scores = data_dict.get('res', {}).get('rec_scores', [])
        dt_polys = data_dict.get('res', {}).get('dt_polys', [])
        
        for i, text in enumerate(rec_texts):
            score = rec_scores[i] if i < len(rec_scores) else 0
            poly = dt_polys[i] if i < len(dt_polys) else []
            
            if text.strip():
                # 计算 bbox 中心用于与符号关联
                if poly:
                    x = int(min(p[0] for p in poly))
                    y = int(min(p[1] for p in poly))
                    w = int(max(p[0] for p in poly) - x)
                    h = int(max(p[1] for p in poly) - y)
                else:
                    x = y = w = h = 0
                
                texts.append({
                    'text': text.strip(),
                    'confidence': round(score, 3),
                    'bbox': [x, y, w, h]
                })
    
    return texts

def draw_results(data, symbols, texts, out_path):
    """绘制检测结果"""
    img = data['img'].copy()
    
    # 绘制符号
    colors = {
        'cross': (0, 0, 255),
        'cross_large': (0, 0, 200),
        'check': (0, 255, 0),
        'dot_or_check': (0, 180, 0),
        'underline': (255, 0, 0),
        'text_or_num': (255, 128, 0),
    }
    
    for s in symbols:
        c = colors.get(s['type'], (128, 128, 128))
        x, y, w, h = s['bbox']
        cv2.rectangle(img, (x, y), (x+w, y+h), c, 1)
        cv2.putText(img, s['type'][:9], (x, y-2), cv2.FONT_HERSHEY_SIMPLEX, 0.3, c, 1)
    
    # 绘制 OCR 结果
    for t in texts:
        if t['confidence'] > 0.5:
            x, y, w, h = t['bbox']
            label = f"{t['text']}({t['confidence']:.2f})"
            cv2.putText(img, label, (x, max(y-5, 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 0, 0), 1)
            if w > 0 and h > 0:
                cv2.rectangle(img, (x, y), (x+w, y+h), (0, 255, 0), 1)
    
    cv2.imwrite(out_path, img)
    print(f'Annotated: {out_path}')

def main():
    if len(sys.argv) < 2:
        print('Usage: python3 scripts/test-red-ocr.py <image_path>')
        sys.exit(1)
    
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    img_path = sys.argv[1]
    
    # 1. HSV 分离
    print(f'Processing: {img_path}')
    data = hsv_extract_red(img_path)
    if not data:
        print('Failed to process image')
        return
    
    # 保存分离结果
    cv2.imwrite(f'{OUTPUT_DIR}/{data["basename"]}_red.jpg', data['red_overlay'])
    
    # 2. 符号检测
    symbols = detect_red_symbols(data)
    print(f'Red symbols detected: {len(symbols)}')
    for s in symbols:
        if s['type'] in ('cross', 'cross_large', 'dot_or_check', 'text_or_num'):
            print(f'  [{s["id"]}] type={s["type"]} area={s["area"]} bbox={s["bbox"]}')
    
    # 3. OCR
    ocr = PaddleOCR(lang='en', use_doc_orientation_classify=False, use_doc_unwarping=False)
    texts = run_ocr(data, symbols, ocr)
    print(f'\nOCR texts on red channel: {len(texts)}')
    
    # 筛选有效红笔答案
    meaningful = []
    for t in texts:
        txt = t['text'].strip()
        if not txt: continue
        # 关注短文本（字母、数字、简短答案）
        if len(txt) <= 5:
            meaningful.append(t)
            print(f'  "{txt}" conf={t["confidence"]:.3f} [{t["bbox"]}]')
        elif t['confidence'] > 0.8:
            meaningful.append(t)
            print(f'  "{txt}" conf={t["confidence"]:.3f} (high conf)')
    
    # 4. 绘制
    draw_results(data, symbols, texts, f'{OUTPUT_DIR}/{data["basename"]}_result.jpg')
    
    # 5. 保存 JSON
    result = {
        'image': img_path,
        'symbols': [s for s in symbols if s['type'] in ('cross', 'cross_large', 'dot_or_check', 'text_or_num')],
        'ocr_texts': meaningful,
        'summary': {
            'total_symbols': len(symbols),
            'total_ocr': len(texts),
            'meaningful_ocr': len(meaningful)
        }
    }
    json_path = f'{OUTPUT_DIR}/{data["basename"]}_result.json'
    with open(json_path, 'w') as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    print(f'\nResults saved to {json_path}')
    print(json.dumps(result['summary'], indent=2))

if __name__ == '__main__':
    main()
