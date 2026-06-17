#!/usr/bin/env python3
"""
gaozhong.online — 红笔字符识别验证 v2
改进: 更强的对比增强 + 黑化红笔区域 + 中文OCR兜底
"""

import cv2
import numpy as np
import sys, os, json, importlib.metadata, base64

orig_version = importlib.metadata.version
def patched_version(pkg):
    if pkg == 'opencv-contrib-python': return '4.10.0.84'
    return orig_version(pkg)
importlib.metadata.version = patched_version
from paddleocr import PaddleOCR

OUT = 'output/red-ocr-test'

def process(img_path):
    img = cv2.imread(img_path)
    if img is None: return None
    h, w = img.shape[:2]
    basename = os.path.splitext(os.path.basename(img_path))[0]
    os.makedirs(OUT, exist_ok=True)

    # --- HSV red extraction ---
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    m1 = cv2.inRange(hsv, np.array([0, 40, 30]), np.array([12, 255, 255]))
    m2 = cv2.inRange(hsv, np.array([155, 40, 30]), np.array([180, 255, 255]))
    mask = cv2.bitwise_or(m1, m2)
    k = np.ones((2,2), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k)

    # --- 方案A: 黑化红笔区域（白底黑字）---
    gray_img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # 红色区域→黑色, 背景→白色
    black_red = np.ones_like(gray_img) * 255
    black_red[mask > 0] = 0
    cv2.imwrite(f'{OUT}/{basename}_black_red.jpg', black_red)
    
    # --- 方案B: 增强对比（红色变深色）---
    enhanced = gray_img.copy()
    enhanced[mask > 0] = np.clip(enhanced[mask > 0].astype(int) - 60, 0, 255).astype(np.uint8)
    cv2.imwrite(f'{OUT}/{basename}_enhanced.jpg', enhanced)

    # --- 方案C: 红色区域独立提取（clip + 放大）---
    red_only = np.ones_like(gray_img) * 255
    red_area = gray_img[mask > 0]
    if len(red_area) > 0:
        # 红色区域转为深色
        red_dark = 255 - red_area
        red_only[mask > 0] = np.clip(red_dark * 2, 0, 255)
    cv2.imwrite(f'{OUT}/{basename}_red_amplified.jpg', red_only)

    # --- 方案D: 形态学膨胀后黑化 ---
    dilated = cv2.dilate(mask, np.ones((3,3), np.uint8), iterations=2)
    bold_red = np.ones_like(gray_img) * 255
    bold_red[dilated > 0] = 0
    cv2.imwrite(f'{OUT}/{basename}_bold_red.jpg', bold_red)

    return {
        'mask': mask, 'dilated': dilated,
        'black_red': black_red, 'enhanced': enhanced,
        'red_amplified': red_only, 'bold_red': bold_red,
        'basename': basename, 'img': img
    }

def test_ocr(data, variant_name, ocr_img, ocr_eng, ocr_ch):
    """对一种预处理方案跑 OCR"""
    path = f'{OUT}/{data["basename"]}_{variant_name}.jpg'
    cv2.imwrite(path, ocr_img)

    # Try English OCR
    res_eng = ocr_eng.predict(path)
    eng_texts = extract_texts(res_eng)

    # Try Chinese OCR (handles both)
    res_ch = ocr_ch.predict(path)
    ch_texts = extract_texts(res_ch)
    
    return {
        'variant': variant_name,
        'eng_texts': eng_texts,
        'ch_texts': ch_texts,
        'best': merge_best(eng_texts, ch_texts)
    }

def extract_texts(result):
    if not result or len(result) == 0: return []
    page = result[0]
    data = page.json if isinstance(page.json, dict) else {}
    texts = data.get('res', {}).get('rec_texts', [])
    scores = data.get('res', {}).get('rec_scores', [])
    dt_polys = data.get('res', {}).get('dt_polys', [])
    
    output = []
    for i, t in enumerate(texts):
        if not t.strip(): continue
        poly = dt_polys[i] if i < len(dt_polys) else []
        score = scores[i] if i < len(scores) else 0
        x = int(min(p[0] for p in poly)) if poly else 0
        y = int(min(p[1] for p in poly)) if poly else 0
        output.append({
            'text': t.strip(), 'confidence': round(score, 3),
            'bbox': [x, y, int(max(p[0] for p in poly)-x) if poly else 0, int(max(p[1] for p in poly)-y) if poly else 0]
        })
    return output

def merge_best(eng, ch):
    """合并英文和中文OCR的最优结果"""
    combined = {}
    for items, prefix in [(eng, 'en'), (ch, 'ch')]:
        for item in items:
            key = f"{item['bbox'][0]}_{item['bbox'][1]}"
            if key not in combined or item['confidence'] > combined[key]['confidence']:
                combined[key] = item
    return sorted(combined.values(), key=lambda x: x['confidence'], reverse=True)

def main():
    if len(sys.argv) < 2:
        print('Usage: python3 scripts/test-red-ocr-v2.py <image_path>')
        sys.exit(1)
    img_path = sys.argv[1]
    
    print(f'Processing: {img_path}')
    data = process(img_path)
    if not data: return
    
    print('Initializing OCR...')
    ocr_eng = PaddleOCR(lang='en', use_doc_orientation_classify=False, use_doc_unwarping=False)
    ocr_ch = PaddleOCR(lang='ch', use_doc_orientation_classify=False, use_doc_unwarping=False)
    
    results = []
    variants = [
        ('black_red', data['black_red']),     # 红笔区→纯黑
        ('bold_red', data['bold_red']),       # 膨胀后黑化
        ('enhanced', data['enhanced']),       # 对比增强
        ('red_amplified', data['red_amplified']) # 红色放大
    ]
    
    for name, img in variants:
        print(f'  Testing {name}...')
        r = test_ocr(data, name, img, ocr_eng, ocr_ch)
        results.append(r)
        best_count = len(r['best'])
        if best_count > 0:
            print(f'    -> {best_count} texts (best)')
            for t in r['best'][:8]:
                print(f'       "{t["text"]}" conf={t["confidence"]:.3f}')
    
    # 最佳方案汇总
    print('\n=== 最佳方案对比 ===')
    for r in results:
        best = r['best']
        # 筛选有意义的短文本
        meaningful = [t for t in best if len(t['text']) <= 5 or t['confidence'] > 0.6]
        total = len(best)
        high_conf = len([t for t in best if t['confidence'] > 0.5])
        print(f'  {r["variant"]:15s}: total={total:2d} high_conf={high_conf:2d} meaningful={len(meaningful):2d}')
    
    # 保存最佳结果
    best_variant = max(results, key=lambda r: len([t for t in r['best'] if t['confidence'] > 0.5]))
    json_path = f'{OUT}/{data["basename"]}_ocr.json'
    with open(json_path, 'w') as f:
        json.dump({
            'image': img_path,
            'best_variant': best_variant['variant'],
            'results': [{'variant': r['variant'], 'texts': r['best']} for r in results]
        }, f, indent=2, ensure_ascii=False)
    print(f'\nSaved: {json_path}')

if __name__ == '__main__':
    main()
