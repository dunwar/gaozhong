#!/usr/bin/env python3
"""
gaozhong.online - Hybrid OCR: PaddleOCR detection + VL reading
Phase 1: PaddleOCR detects text regions and question number positions
Phase 2: Uses detected regions to structure questions
Phase 3: (Optional) VL reads text for question regions with low OCR confidence
"""
import json, sys, os, argparse, re
import numpy as np

def run_paddleocr(image_path):
    """Run PaddleOCR and return text blocks with coordinates."""
    from paddlex import create_pipeline
    
    pipeline = create_pipeline('OCR')
    output = list(pipeline.predict(image_path))
    item = output[0]
    
    texts = item.get('rec_texts', [])
    scores = item.get('rec_scores', [])
    polys = item.get('dt_polys', [])
    
    blocks = []
    for i, (text, score) in enumerate(zip(texts, scores)):
        s = float(score)
        if s < 0.2:
            continue
        
        if i < len(polys):
            pts = polys[i]
            xs = [int(pt[0]) for pt in pts]
            ys = [int(pt[1]) for pt in pts]
            bx, by = min(xs), min(ys)
            bw, bh = max(xs) - min(xs), max(ys) - min(ys)
        else:
            bx, by, bw, bh = 0, 0, 0, 0
        
        blocks.append({
            'text': text.strip(),
            'confidence': round(s, 3),
            'bbox': {'x': bx, 'y': by, 'w': bw, 'h': bh},
            'centerY': int(by + bh / 2),
            'centerX': int(bx + bw / 2)
        })
    
    return blocks

def find_question_numbers(blocks):
    """
    Find question numbers by:
    1. Matching patterns like '21.' at the start of text blocks
    2. Matching standalone numbers at left side of page
    3. Using layout analysis (consistent x-position of question numbers)
    """
    candidates = []
    num_pattern = re.compile(r'^\s*(\d{1,3})\s*[\.、．)\s]')
    standalone_num = re.compile(r'^\s*(\d{1,3})\s*$')
    
    for b in blocks:
        t = b['text']
        
        # Pattern 1: Number followed by punctuation
        m = num_pattern.match(t)
        if m:
            num = int(m.group(1))
            if 1 <= num <= 200:
                candidates.append({
                    'questionNumber': num,
                    'block': b,
                    'method': 'pattern',
                    'centerY': b['centerY'],
                    'centerX': b['centerX']
                })
                continue
        
        # Pattern 2: Standalone number at left side
        m = standalone_num.match(t)
        if m and b['centerX'] < 500:  # Left half of page
            num = int(m.group(1))
            if 1 <= num <= 200:
                candidates.append({
                    'questionNumber': num,
                    'block': b,
                    'method': 'standalone',
                    'centerY': b['centerY'],
                    'centerX': b['centerX']
                })
    
    # Deduplicate by question number (keep the first occurrence)
    seen = set()
    unique = []
    for c in sorted(candidates, key=lambda c: c['questionNumber']):
        if c['questionNumber'] not in seen:
            seen.add(c['questionNumber'])
            unique.append(c)
    
    # Sort by Y position
    unique.sort(key=lambda c: c['centerY'])
    
    return unique

def group_questions(blocks, qnum_candidates, page_width=1707):
    """Group blocks into questions based on detected question numbers."""
    if not qnum_candidates:
        return []
    
    # Sort blocks by Y
    blocks = sorted(blocks, key=lambda b: (b['centerY'], b['centerX']))
    
    questions = []
    
    for i, qc in enumerate(qnum_candidates):
        qnum = qc['questionNumber']
        q_y = qc['centerY']
        
        # Find the Y range for this question
        start_y = q_y - 10  # Start a bit above question number
        
        if i + 1 < len(qnum_candidates):
            next_y = qnum_candidates[i + 1]['centerY']
            end_y = next_y - 5  # End just before next question
        else:
            end_y = max(b['centerY'] for b in blocks) + 50
        
        # Collect blocks in this Y range
        q_blocks = [b for b in blocks if start_y <= b['centerY'] <= end_y]
        
        if not q_blocks:
            continue
        
        # Bbox: union of all blocks in this question
        all_x = [b['bbox']['x'] for b in q_blocks]
        all_y = [b['bbox']['y'] for b in q_blocks]
        all_r = [b['bbox']['x'] + b['bbox']['w'] for b in q_blocks]
        all_b = [b['bbox']['y'] + b['bbox']['h'] for b in q_blocks]
        
        # Expand bbox to cover full page width (capture right-column answer area)
        bbox = {
            'x': 0,  # Full width
            'y': int(min(all_y) - 5),
            'w': page_width,
            'h': int(max(all_b) - min(all_y) + 10)
        }
        
        # Classify question type
        all_text = ' '.join(b['text'] for b in q_blocks)
        has_options = any(re.match(r'^\s*[A-D]\s*[\.、．)]', b['text']) for b in q_blocks)
        
        if has_options:
            qtype = 'choice'
        elif len(all_text) > 300:
            qtype = 'reading'
        elif len(q_blocks) <= 3:
            qtype = 'fill_blank'
        else:
            qtype = 'dictation'
        
        # Extract options from blocks
        options = {}
        opt_pattern = re.compile(r'^\s*([A-D])\s*[\.、．)]\s*(.+)')
        for b in q_blocks:
            m = opt_pattern.match(b['text'])
            if m:
                key = m.group(1)
                if key not in options:
                    options[key] = m.group(2).strip()
        
        # Get question text (from VL or OCR blocks)
        q_text = extract_question_text(q_blocks)
        
        questions.append({
            'questionNumber': qnum,
            'questionType': qtype,
            'questionText': q_text,
            'options': options,
            'bbox': bbox,
            'blockCount': len(q_blocks),
            'ocrConfidence': round(np.mean([b['confidence'] for b in q_blocks]), 3) if q_blocks else 0
        })
    
    return questions

def extract_question_text(q_blocks):
    """Extract the best question text from blocks."""
    # Skip option blocks and standalone numbers
    lines = []
    for b in q_blocks:
        t = b['text'].strip()
        if re.match(r'^\s*[A-D]\s*[\.、．)]', t):
            continue
        if re.match(r'^\s*\d{1,3}\s*$', t):
            continue
        if len(t) < 3:
            continue
        lines.append(t)
    return ' '.join(lines)

def main():
    parser = argparse.ArgumentParser(description='Hybrid OCR page extraction')
    parser.add_argument('image', help='Path to page image')
    parser.add_argument('--output', '-o', help='Output JSON file')
    parser.add_argument('--raw-blocks', help='Save raw blocks to file')
    args = parser.parse_args()
    
    if not os.path.exists(args.image):
        print(json.dumps({"status": "error", "error": f"File not found: {args.image}"}, ensure_ascii=False))
        sys.exit(1)
    
    try:
        blocks = run_paddleocr(args.image)
        
        if args.raw_blocks:
            with open(args.raw_blocks, 'w') as f:
                json.dump(blocks, f, ensure_ascii=False, indent=2)
        
        # Find question numbers
        # Determine page width from max block x
        page_width = max(b['bbox']['x'] + b['bbox']['w'] for b in blocks) if blocks else 1707
        qnum_candidates = find_question_numbers(blocks)
        
        # Group into questions
        questions = group_questions(blocks, qnum_candidates, page_width)
        
        output = {
            "status": "ok",
            "image": args.image,
            "engine": "paddleocr",
            "totalBlocks": len(blocks),
            "questionNumberCandidates": len(qnum_candidates),
            "totalQuestions": len(questions),
            "questions": questions
        }
        
        if args.output:
            with open(args.output, 'w', encoding='utf-8') as f:
                json.dump(output, f, ensure_ascii=False, indent=2)
        
        print(json.dumps(output, ensure_ascii=False, indent=2))
        
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False))
        sys.exit(1)

if __name__ == '__main__':
    main()
