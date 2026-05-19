#!/usr/bin/env python3
"""
gaozhong.online - Phase 2: Red mark detection via OpenCV
Uses HSV color filtering to locate red pen markings on exam papers.
Output: JSON list of red mark regions with bbox and type hints.
"""
import json, sys, os, argparse
import cv2
import numpy as np

def detect_red_marks(image_path, debug_dir=None):
    """
    Detect red pen marks using HSV color space filtering.
    Returns list of {markId, bbox: {x,y,w,h}, type, confidence}
    """
    img = cv2.imread(image_path)
    if img is None:
        raise RuntimeError(f"Cannot read image: {image_path}")
    
    h, w = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    
    # Red wraps around in HSV hue space, so we need two ranges
    # Range 1: red near 0 degrees (0-10)
    lower_red1 = np.array([0, 50, 50])
    upper_red1 = np.array([10, 255, 255])
    mask1 = cv2.inRange(hsv, lower_red1, upper_red1)
    
    # Range 2: red near 180 degrees (170-180)
    lower_red2 = np.array([170, 50, 50])
    upper_red2 = np.array([180, 255, 255])
    mask2 = cv2.inRange(hsv, lower_red2, upper_red2)
    
    # Also detect pink/magenta (common for teacher pens)
    lower_pink = np.array([140, 30, 80])
    upper_pink = np.array([170, 255, 255])
    mask3 = cv2.inRange(hsv, lower_pink, upper_pink)
    
    # Combine masks
    mask = cv2.bitwise_or(mask1, mask2)
    mask = cv2.bitwise_or(mask, mask3)
    
    # Morphological operations to clean up
    kernel_small = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2, 2))
    kernel_medium = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    
    # Close small gaps
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel_small)
    # Remove tiny noise
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel_small)
    
    if debug_dir:
        os.makedirs(debug_dir, exist_ok=True)
        cv2.imwrite(os.path.join(debug_dir, 'red_mask.png'), mask)
    
    # Find contours
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    marks = []
    MIN_AREA = 20   # Minimum red pixel area
    MAX_AREA = 50000  # Maximum (ignore large red decorations)
    
    for i, cnt in enumerate(contours):
        area = cv2.contourArea(cnt)
        if area < MIN_AREA or area > MAX_AREA:
            continue
        
        x, y, bw, bh = cv2.boundingRect(cnt)
        
        # Filter out very thin lines (likely image borders/decorations)
        aspect_ratio = max(bw, bh) / max(min(bw, bh), 1)
        if bw > w * 0.6:  # Horizontal line spanning >60% of page width
            continue
        if bh > h * 0.3:  # Vertical line spanning >30% of page height
            continue
        
        # Classify mark type based on geometry
        mark_type = classify_mark(cnt, bw, bh, area, aspect_ratio)
        
        # Confidence based on size
        confidence = min(1.0, area / 200) if area > 0 else 0.5
        
        marks.append({
            "markId": len(marks) + 1,
            "bbox": {"x": int(x), "y": int(y), "w": int(bw), "h": int(bh)},
            "type": mark_type,
            "area": int(area),
            "confidence": round(confidence, 2)
        })
    
    # Sort by Y position (top to bottom)
    marks.sort(key=lambda m: m["bbox"]["y"])
    
    # Re-index
    for i, m in enumerate(marks):
        m["markId"] = i + 1
    
    return marks, mask

def classify_mark(contour, bw, bh, area, aspect_ratio):
    """Classify the mark type based on geometric properties."""
    # Compact shape with cross-like features
    if aspect_ratio < 2.5 and area < 800:
        # Check for cross shape using convexity defects
        hull = cv2.convexHull(contour)
        hull_area = cv2.contourArea(hull)
        solidity = area / hull_area if hull_area > 0 else 1
        
        if solidity < 0.7:  # Concave shape - likely cross
            return "cross"
        elif aspect_ratio < 1.5:
            return "dot_or_small_mark"
    
    # Long thin shape
    if aspect_ratio > 4:
        if bw > bh * 3:
            return "underline_or_strikethrough"
        else:
            return "vertical_line"
    
    # Medium blob - likely handwritten letter/number
    if 50 < area < 2000 and 1.5 < aspect_ratio < 4:
        return "handwritten_letter"
    
    # Check mark (tick) shape detection
    if aspect_ratio < 3 and area < 600:
        # Check if contour bends upward (tick shape)
        moments = cv2.moments(contour)
        if moments['m00'] > 0:
            cx = int(moments['m10'] / moments['m00'])
            cy = int(moments['m01'] / moments['m00'])
            # If center of mass is above geometric center, might be tick
            geo_cy = cv2.boundingRect(contour)[1] + cv2.boundingRect(contour)[3] / 2
            if cy < geo_cy:
                return "check_or_mark"
    
    return "unknown_red_mark"

def generate_red_highlighted_image(image_path, mask, output_path=None):
    """Generate a white-background image with only red marks visible."""
    img = cv2.imread(image_path)
    if img is None:
        return None
    
    # Create white background
    white_bg = np.ones_like(img) * 255
    # Copy only red pixels from original
    result = cv2.bitwise_and(img, img, mask=mask)
    # Where mask is 0, use white
    result = cv2.add(result, cv2.bitwise_and(white_bg, white_bg, mask=cv2.bitwise_not(mask)))
    
    if output_path:
        cv2.imwrite(output_path, result)
    
    return result

def main():
    parser = argparse.ArgumentParser(description='Detect red pen marks in exam paper')
    parser.add_argument('image', help='Path to page image')
    parser.add_argument('--output', '-o', help='Output JSON file')
    parser.add_argument('--debug-dir', help='Save debug images (red mask, highlighted)')
    parser.add_argument('--highlighted', help='Save red-highlighted image')
    args = parser.parse_args()
    
    try:
        marks, mask = detect_red_marks(args.image, args.debug_dir)
        
        if args.highlighted:
            generate_red_highlighted_image(args.image, mask, args.highlighted)
        
        result = {
            "status": "ok",
            "image": args.image,
            "totalMarks": len(marks),
            "marks": marks
        }
        
        if args.output:
            with open(args.output, 'w', encoding='utf-8') as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
        
        print(json.dumps(result, ensure_ascii=False, indent=2))
        
    except Exception as e:
        print(json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False))
        sys.exit(1)

if __name__ == '__main__':
    main()
