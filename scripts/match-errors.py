#!/usr/bin/env python3
"""
gaozhong.online - Phase 3: Position matching engine
Matches red mark locations against question bounding boxes.
Output: classified questions (correct/wrong/needs_review)
"""
import json, sys, os, argparse

def point_in_bbox(px, py, bbox, margin=10):
    """Check if a point (px,py) is inside a bbox with optional margin expansion."""
    x, y, w, h = bbox['x'], bbox['y'], bbox['w'], bbox['h']
    return (x - margin <= px <= x + w + margin and 
            y - margin <= py <= y + h + margin)

def bbox_overlap(a, b, margin=5):
    """Check if two bboxes overlap (expanded by margin)."""
    ax1, ay1 = a['x'] - margin, a['y'] - margin
    ax2, ay2 = a['x'] + a['w'] + margin, a['y'] + a['h'] + margin
    bx1, by1 = b['x'], b['y']
    bx2, by2 = b['x'] + b['w'], b['y'] + b['h']
    
    return not (ax2 < bx1 or ax1 > bx2 or ay2 < by1 or ay1 > by2)

def match_marks_to_questions(questions, marks, margin=15, expand_x=False, page_width=None):
    """
    Match each red mark to the CLOSEST question by vertical distance.
    This handles layouts where bboxes are full-width and overlap.
    Returns dict: questionNumber -> list of matched marks.
    """
    matches = {}
    
    for mark in marks:
        my = mark['bbox']['y'] + mark['bbox']['h'] / 2
        
        best_q = None
        best_dist = float('inf')
        
        for q in questions:
            b = q['bbox']
            # Compute vertical distance from mark center to question center
            q_center_y = b['y'] + b['h'] / 2
            dist = abs(my - q_center_y)
            
            # Also check if mark is within reasonable horizontal range
            # (with expand_x, we ignore x since marks may be in right column)
            if dist < best_dist:
                best_dist = dist
                best_q = q['questionNumber']
        
        # Only match if within threshold (question height + margin)
        if best_q is not None:
            avg_q_height = sum(q['bbox']['h'] for q in questions) / len(questions)
            threshold = avg_q_height * 0.7  # mark must be within 70% of question height from center
            if best_dist <= threshold:
                if best_q not in matches:
                    matches[best_q] = []
                matches[best_q].append(mark)
    
    return matches

def bbox_overlap_score(mark_bbox, q_bbox):
    """Calculate IoU-like overlap score."""
    mx1, my1 = mark_bbox['x'], mark_bbox['y']
    mx2, my2 = mark_bbox['x'] + mark_bbox['w'], mark_bbox['y'] + mark_bbox['h']
    qx1, qy1 = q_bbox['x'], q_bbox['y']
    qx2, qy2 = q_bbox['x'] + q_bbox['w'], q_bbox['y'] + q_bbox['h']
    
    # Intersection
    ix1 = max(mx1, qx1)
    iy1 = max(my1, qy1)
    ix2 = min(mx2, qx2)
    iy2 = min(my2, qy2)
    
    if ix2 <= ix1 or iy2 <= iy1:
        return 0
    
    inter_area = (ix2 - ix1) * (iy2 - iy1)
    mark_area = mark_bbox['w'] * mark_bbox['h']
    return inter_area / mark_area if mark_area > 0 else 0

def classify_questions(questions, matches, marking_method='red_pen'):
    """
    Classify each question as correct/wrong based on red mark presence.
    
    marking_method:
    - 'red_pen': Any red mark in question area = wrong (default for teacher red pen grading)
    - 'cross_only': Only cross-type marks = wrong (for checkmark/cross grading)
    - 'mixed': Cross + handwritten letters = wrong, check marks = correct
    """
    results = []
    
    for q in questions:
        qnum = q['questionNumber']
        qmarks = matches.get(qnum, [])
        
        is_error = False
        confidence = 'high'
        reason = ''
        
        if not qmarks:
            # No red marks = correct, but flag for review (might be ungraded)
            is_error = False
            confidence = 'low'
            reason = 'no_red_marks'
        else:
            if marking_method == 'red_pen':
                # Any red mark = wrong
                is_error = True
                confidence = 'medium'
                reason = f'red_marks_found_{len(qmarks)}'
            
            elif marking_method == 'cross_only':
                # Only cross marks count
                crosses = [m for m in qmarks if m['type'] == 'cross']
                checks = [m for m in qmarks if m['type'] == 'check_or_mark']
                if crosses:
                    is_error = True
                    confidence = 'medium'
                    reason = f'cross_marks_{len(crosses)}'
                elif checks:
                    is_error = False
                    confidence = 'medium'
                    reason = 'check_marks_present'
                else:
                    is_error = False
                    confidence = 'low'
                    reason = 'ambiguous_marks'
            
            elif marking_method == 'mixed':
                # Cross + handwritten letters = wrong; check marks = correct
                crosses = [m for m in qmarks if m['type'] in ('cross', 'handwritten_letter')]
                checks = [m for m in qmarks if m['type'] == 'check_or_mark']
                if crosses:
                    is_error = True
                    confidence = 'medium'
                    reason = f'error_marks_{len(crosses)}'
                elif checks:
                    is_error = False
                    confidence = 'medium'
                    reason = 'check_marks'
                else:
                    is_error = False
                    confidence = 'low'
                    reason = 'ambiguous'
        
        results.append({
            'questionNumber': qnum,
            'questionType': q.get('questionType', ''),
            'questionText': q.get('questionText', '')[:60],
            'options': q.get('options', {}),
            'bbox': q['bbox'],
            'isError': is_error,
            'confidence': confidence,
            'reason': reason,
            'matchedMarks': qmarks,
            'markCount': len(qmarks)
        })
    
    return results

def analyze_page(ocr_json, marks_json, marking_method='red_pen', margin=15, expand_x=True, page_width=None):
    """
    Main pipeline: take OCR and marks results, match them, classify questions.
    """
    ocr_data = ocr_json if isinstance(ocr_json, dict) else json.loads(ocr_json)
    marks_data = marks_json if isinstance(marks_json, dict) else json.loads(marks_json)
    
    questions = ocr_data.get('questions', [])
    marks = marks_data.get('marks', [])
    
    # Detect page width from marks if not provided
    if page_width is None and expand_x and marks:
        page_width = max(m['bbox']['x'] + m['bbox']['w'] for m in marks)
        # Also consider question bboxes
        if questions:
            page_width = max(page_width, max(q['bbox']['x'] + q['bbox']['w'] for q in questions))
    
    # Match marks to questions
    matches = match_marks_to_questions(questions, marks, margin, expand_x, page_width)
    
    # Classify
    results = classify_questions(questions, matches, marking_method)
    
    # Summary
    error_count = sum(1 for r in results if r['isError'])
    correct_count = sum(1 for r in results if not r['isError'])
    low_conf_count = sum(1 for r in results if r['confidence'] == 'low')
    unmatched_marks = len(marks) - sum(len(v) for v in matches.values())
    
    return {
        "status": "ok",
        "summary": {
            "totalQuestions": len(questions),
            "errorQuestions": error_count,
            "correctQuestions": correct_count,
            "lowConfidenceCount": low_conf_count,
            "totalMarks": len(marks),
            "matchedMarks": sum(len(v) for v in matches.values()),
            "unmatchedMarks": unmatched_marks,
            "markingMethod": marking_method,
            "matchMargin": margin
        },
        "matches": {str(k): v for k, v in matches.items()},
        "questions": results
    }

def main():
    parser = argparse.ArgumentParser(description='Match red marks to questions')
    parser.add_argument('--ocr', required=True, help='OCR JSON file or JSON string')
    parser.add_argument('--marks', required=True, help='Red marks JSON file or JSON string')
    parser.add_argument('--method', default='red_pen', choices=['red_pen', 'cross_only', 'mixed'],
                        help='Marking method (default: red_pen)')
    parser.add_argument('--margin', type=int, default=15, help='Bbox expansion margin in pixels')
    parser.add_argument('--output', '-o', help='Output JSON file')
    args = parser.parse_args()
    
    # Load OCR data
    if os.path.exists(args.ocr):
        with open(args.ocr, 'r') as f:
            ocr_data = json.load(f)
    else:
        ocr_data = json.loads(args.ocr)
    
    # Load marks data
    if os.path.exists(args.marks):
        with open(args.marks, 'r') as f:
            marks_data = json.load(f)
    else:
        marks_data = json.loads(args.marks)
    
    result = analyze_page(ocr_data, marks_data, args.method, args.margin, expand_x=True)
    
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
    
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
