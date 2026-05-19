#!/usr/bin/env python3
"""
gaozhong.online — HSV 颜色分离 + OpenCV 符号检测验证
Phase 0: 验证新方案核心假设

用法: python3 scripts/hsv-separate.py /app/data/papers/<sessionId>/page_1.jpg
输出:
  1. 黑蓝通道图 (output/hsv-test/blackblue_page1.jpg)
  2. 红笔通道图 (output/hsv-test/red_page1.jpg)  
  3. 红笔符号检测标注图 (output/hsv-test/annotated_page1.jpg)
  4. 文本统计：每个红笔区域的类别和置信度
"""

import cv2
import numpy as np
import sys
import os
import json

def hsv_separate(img_path, output_dir='output/hsv-test'):
    """HSV 颜色分离：生成黑蓝通道图和红笔通道图"""
    os.makedirs(output_dir, exist_ok=True)
    basename = os.path.splitext(os.path.basename(img_path))[0]
    
    img = cv2.imread(img_path)
    if img is None:
        print(f'ERROR: Cannot read {img_path}')
        return None
    
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, w = img.shape[:2]
    print(f'Image: {w}x{h}')
    
    # ─── 红笔提取 ───
    # 红色在 HSV 中有两段（绕 0°/360°）
    lower_red1 = np.array([0, 50, 50])
    upper_red1 = np.array([10, 255, 255])
    lower_red2 = np.array([160, 50, 50])
    upper_red2 = np.array([180, 255, 255])
    
    mask_red1 = cv2.inRange(hsv, lower_red1, upper_red1)
    mask_red2 = cv2.inRange(hsv, lower_red2, upper_red2)
    mask_red = cv2.bitwise_or(mask_red1, mask_red2)
    
    # 形态学去噪
    kernel = np.ones((2, 2), np.uint8)
    mask_red_clean = cv2.morphologyEx(mask_red, cv2.MORPH_CLOSE, kernel)
    mask_red_clean = cv2.morphologyEx(mask_red_clean, cv2.MORPH_OPEN, kernel)
    
    # 红笔通道图（白底红笔）
    red_channel = np.ones_like(img) * 255
    red_channel[mask_red_clean > 0] = img[mask_red_clean > 0]
    
    # ─── 黑蓝通道图（去红） ───
    mask_not_red = cv2.bitwise_not(mask_red_clean)
    blackblue_channel = img.copy()
    blackblue_channel[mask_red_clean > 0] = [255, 255, 255]  # 红笔区域变白
    
    # 保存
    cv2.imwrite(f'{output_dir}/{basename}_blackblue.jpg', blackblue_channel)
    cv2.imwrite(f'{output_dir}/{basename}_red.jpg', red_channel)
    print(f'Saved: {basename}_blackblue.jpg, {basename}_red.jpg')
    
    return {
        'img': img,
        'mask_red': mask_red_clean,
        'blackblue': blackblue_channel,
        'red': red_channel,
        'basename': basename,
        'output_dir': output_dir
    }

def detect_red_marks(data, output_dir):
    """在红笔掩码上检测符号（✓✗ 等）"""
    mask = data['mask_red']
    
    # 膨胀以连接断笔
    kernel = np.ones((3, 3), np.uint8)
    mask_dilated = cv2.dilate(mask, kernel, iterations=1)
    
    # 找轮廓
    contours, hierarchy = cv2.findContours(mask_dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    results = []
    annotated = data['blackblue'].copy()
    
    for i, cnt in enumerate(contours):
        area = cv2.contourArea(cnt)
        if area < 15:  # 忽略噪点
            continue
        
        x, y, w, h = cv2.boundingRect(cnt)
        aspect_ratio = w / max(h, 1)
        
        # 提取该区域的掩码
        roi_mask = np.zeros(mask.shape, np.uint8)
        cv2.drawContours(roi_mask, [cnt], -1, 255, -1)
        roi_mask = roi_mask[y:y+h, x:x+w]
        
        # 轮廓特征
        hull = cv2.convexHull(cnt)
        hull_area = cv2.contourArea(hull)
        solidity = area / hull_area if hull_area > 0 else 0
        
        # 最小外接矩形
        rect = cv2.minAreaRect(cnt)
        rect_area = rect[1][0] * rect[1][1] if rect[1][0] > 0 and rect[1][1] > 0 else 1
        extent = area / rect_area if rect_area > 0 else 0
        
        # ─── 形状分类 ───
        shape_type = 'unknown'
        confidence = 0
        
        # 检查是否可能是 ✗ (cross): 两条交叉线
        # 提取骨架
        roi = mask_dilated[y:y+h, x:x+w]
        skel = roi.copy()
        
        # 简单交叉检测：轮廓形状复杂 + 较瘦
        if 0.3 < aspect_ratio < 3.0 and area > 50:
            # 细长比检测：轮廓周长² / (4π * 面积) 越大越细长
            perimeter = cv2.arcLength(cnt, True)
            if perimeter > 0:
                circularity = 4 * np.pi * area / (perimeter * perimeter)
                if circularity < 0.3 and solidity < 0.7:
                    shape_type = 'cross'  # ✗
                    confidence = 0.7
                elif circularity > 0.7 and solidity > 0.8:
                    shape_type = 'check'  # ✓ (近似)
                    confidence = 0.5  # 较难确定
                elif aspect_ratio > 2.5 and extract_roi_avg(roi_mask) > 0.3:
                    shape_type = 'underline'  # 划线
                    confidence = 0.7
                elif area < 200 and 0.5 < aspect_ratio < 2.0:
                    shape_type = 'dot_or_small'  # 小标记
                    confidence = 0.3
        
        # 规则：长窄形状 → 划线
        if aspect_ratio > 3 and area > 30:
            shape_type = 'underline'
            confidence = 0.8
        
        results.append({
            'id': i,
            'bbox': [int(x), int(y), int(w), int(h)],
            'area': int(area),
            'aspect_ratio': round(aspect_ratio, 2),
            'solidity': round(solidity, 2),
            'circularity': round(4*np.pi*area/max(cv2.arcLength(cnt,True)**2,1), 3) if cv2.arcLength(cnt,True)>0 else 0,
            'type': shape_type,
            'confidence_score': round(confidence, 2)
        })
        
        # 绘制标注
        colors = {
            'cross': (0, 0, 255),      # 红框 = ✗
            'check': (0, 255, 0),      # 绿框 = ✓
            'underline': (255, 0, 0),  # 蓝框 = 划线
            'dot_or_small': (0, 255, 255),  # 黄框
            'unknown': (128, 128, 128) # 灰框
        }
        color = colors.get(shape_type, (128, 128, 128))
        cv2.rectangle(annotated, (x, y), (x+w, y+h), color, 1)
        cv2.putText(annotated, f"{i}:{shape_type[:5]}", (x, y-2), cv2.FONT_HERSHEY_SIMPLEX, 0.3, color, 1)
    
    # 保存标注图
    cv2.imwrite(f'{output_dir}/{data["basename"]}_annotated.jpg', annotated)
    print(f'Saved: {data["basename"]}_annotated.jpg')
    print(f'Total red regions: {len(results)}')
    
    return results

def extract_roi_avg(roi_mask):
    """计算 ROI 掩码的平均填充率"""
    if roi_mask.size == 0:
        return 0
    return np.mean(roi_mask) / 255.0

def main():
    if len(sys.argv) < 2:
        print('Usage: python3 scripts/hsv-separate.py <image_path>')
        sys.exit(1)
    
    img_path = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else 'output/hsv-test'
    
    data = hsv_separate(img_path, output_dir)
    if not data:
        return
    
    results = detect_red_marks(data, output_dir)
    
    # 输出 JSON
    json_path = f'{output_dir}/{data["basename"]}_results.json'
    with open(json_path, 'w') as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f'Saved: {json_path}')
    
    # 汇总
    types = {}
    for r in results:
        t = r['type']
        types[t] = types.get(t, 0) + 1
    print(f'\nType summary: {types}')

if __name__ == '__main__':
    main()
