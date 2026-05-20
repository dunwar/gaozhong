#!/usr/bin/env python3
"""
gaozhong.online — Tencent Cloud OCR integration (backup channel)
Uses GeneralAccurateOCR (高精度版, 99% accuracy) for printed text extraction.
Outputs same question-structured JSON format as ocr-page.py (VL OCR).
"""

import json, sys, os, argparse, base64, hmac, hashlib, re, time
import http.client
from datetime import datetime

# ═══════════════════════
# Tencent Cloud API v3 signing
# ═══════════════════════
# https://cloud.tencent.com/document/api/866/33526

def sign_tc3(secret_key, date, service, string_to_sign):
    """TC3-HMAC-SHA256 signing"""
    def hmac_sha256(key, msg):
        return hmac.new(key, msg.encode('utf-8'), hashlib.sha256).digest()
    
    secret_date = hmac_sha256(("TC3" + secret_key).encode('utf-8'), date)
    secret_service = hmac_sha256(secret_date, service)
    secret_signing = hmac_sha256(secret_service, "tc3_request")
    return hmac.new(secret_signing, string_to_sign.encode('utf-8'), hashlib.sha256).hexdigest()

def call_tencent_ocr(image_path, secret_id, secret_key, region='ap-guangzhou', high_precision=True):
    """Call Tencent Cloud GeneralBasicOCR or GeneralAccurateOCR"""
    
    # Read and compress image
    from PIL import Image
    import io
    
    img = Image.open(image_path).convert('RGB')
    # Resize to max 2048px on longest side (Tencent recommends)
    max_dim = max(img.size)
    if max_dim > 2048:
        ratio = 2048 / max_dim
        img = img.resize((int(img.size[0] * ratio), int(img.size[1] * ratio)), Image.LANCZOS)
    
    # Compress to JPEG for faster upload
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=85)
    img_b64 = base64.b64encode(buf.getvalue()).decode()
    
    # API parameters
    action = 'GeneralAccurateOCR' if high_precision else 'GeneralBasicOCR'
    service = 'ocr'
    host = 'ocr.tencentcloudapi.com'
    version = '2018-11-19'
    algorithm = 'TC3-HMAC-SHA256'
    timestamp = str(int(time.time()))
    date = datetime.utcfromtimestamp(int(timestamp)).strftime('%Y-%m-%d')
    
    payload = json.dumps({
        'ImageBase64': img_b64,
        'LanguageType': 'auto',
        'IsWords': False
    })
    
    # Build signed request
    http_request_method = 'POST'
    canonical_uri = '/'
    canonical_querystring = ''
    ct = 'application/json; charset=utf-8'
    canonical_headers = f'content-type:{ct}\nhost:{host}\nx-tc-action:{action.lower()}\n'
    signed_headers = 'content-type;host;x-tc-action'
    hashed_payload = hashlib.sha256(payload.encode('utf-8')).hexdigest()
    
    canonical_request = (
        f'{http_request_method}\n{canonical_uri}\n{canonical_querystring}\n'
        f'{canonical_headers}\n{signed_headers}\n{hashed_payload}'
    )
    
    credential_scope = f'{date}/{service}/tc3_request'
    hashed_canonical_request = hashlib.sha256(canonical_request.encode('utf-8')).hexdigest()
    string_to_sign = f'{algorithm}\n{timestamp}\n{credential_scope}\n{hashed_canonical_request}'
    
    signature = sign_tc3(secret_key, date, service, string_to_sign)
    
    authorization = (
        f'{algorithm} Credential={secret_id}/{credential_scope}, '
        f'SignedHeaders={signed_headers}, Signature={signature}'
    )
    
    headers = {
        'Authorization': authorization,
        'Content-Type': ct,
        'Host': host,
        'X-TC-Action': action,
        'X-TC-Timestamp': timestamp,
        'X-TC-Version': version,
        'X-TC-Region': region
    }
    
    conn = http.client.HTTPSConnection(host, timeout=30)
    conn.request('POST', '/', payload, headers)
    resp = conn.getresponse()
    data = json.loads(resp.read().decode())
    
    if 'Response' not in data or 'Error' in data.get('Response', {}):
        error = data.get('Response', {}).get('Error', {})
        raise Exception(f"Tencent OCR error: {error.get('Code', 'Unknown')} - {error.get('Message', '')}")
    
    return data['Response']

# ═══════════════════════
# Text block → Question structuring
# ═══════════════════════

QUESTION_NUM_RE = re.compile(r'^\s*(\d{1,3})\s*[\.、．)]')
OPTION_RE = re.compile(r'^\s*([A-D])\s*[\.、．)]\s*(.+)')

def blocks_to_questions(text_detections, img_width):
    """Convert Tencent OCR text blocks into structured questions.
    
    Tencent returns: TextDetections[] with { DetectedText, Confidence, ItemPolygon {X,Y,Width,Height} }
    """
    blocks = []
    for td in text_detections:
        text = td.get('DetectedText', '').strip()
        conf = td.get('Confidence', 0)
        poly = td.get('ItemPolygon', {})
        if not text or conf < 50:  # Skip very low confidence
            continue
        blocks.append({
            'text': text,
            'confidence': conf,
            'x': poly.get('X', 0),
            'y': poly.get('Y', 0),
            'w': poly.get('Width', 0),
            'h': poly.get('Height', 0),
            'centerY': poly.get('Y', 0) + poly.get('Height', 0) / 2
        })
    
    # Sort by Y position
    blocks.sort(key=lambda b: (b['centerY'], b['x']))
    
    # Find question numbers
    qnum_blocks = []
    for i, b in enumerate(blocks):
        m = QUESTION_NUM_RE.match(b['text'])
        if m:
            num = int(m.group(1))
            if 1 <= num <= 200:
                qnum_blocks.append((i, num, b))
    
    if not qnum_blocks:
        # Fallback: group by Y spacing into items
        return fallback_group(blocks, img_width)
    
    # Group blocks into questions
    questions = []
    for j, (idx, qnum, qb) in enumerate(qnum_blocks):
        start_idx = idx
        end_idx = qnum_blocks[j + 1][0] if j + 1 < len(qnum_blocks) else len(blocks)
        q_blocks = blocks[start_idx:end_idx]
        
        # Bbox
        if q_blocks:
            xs = [b['x'] for b in q_blocks]
            ys = [b['y'] for b in q_blocks]
            rs = [b['x'] + b['w'] for b in q_blocks]
            bs = [b['y'] + b['h'] for b in q_blocks]
            bbox = {'x': 0, 'y': int(min(ys)), 'w': img_width, 'h': int(max(bs) - min(ys))}
        else:
            bbox = {'x': 0, 'y': 0, 'w': img_width, 'h': 0}
        
        # Extract options and text
        options = {}
        text_lines = []
        for b in q_blocks:
            t = b['text']
            m = OPTION_RE.match(t)
            if m:
                key = m.group(1)
                val = m.group(2).strip()
                if key not in options:
                    options[key] = val
            elif not QUESTION_NUM_RE.match(t):
                text_lines.append(t)
        
        qtype = 'choice' if options else ('reading' if len(' '.join(text_lines)) > 300 else 'fill_blank')
        
        questions.append({
            'questionNumber': qnum,
            'questionType': qtype,
            'questionText': ' '.join(text_lines),
            'options': options,
            'bbox': bbox
        })
    
    questions.sort(key=lambda q: q['questionNumber'])
    return questions

def fallback_group(blocks, img_width):
    """Group text blocks by Y spacing when no question numbers detected."""
    if not blocks:
        return []
    
    groups = []
    current = [blocks[0]]
    GAP = 40
    
    for b in blocks[1:]:
        prev = current[-1]
        if abs(b['centerY'] - prev['centerY']) < GAP:
            current.append(b)
        else:
            groups.append(current)
            current = [b]
    if current:
        groups.append(current)
    
    questions = []
    for i, g in enumerate(groups):
        ys = [b['y'] for b in g]
        bs = [b['y'] + b['h'] for b in g]
        text = ' '.join(b['text'] for b in g)
        
        questions.append({
            'questionNumber': i + 1,
            'questionType': 'unknown',
            'questionText': text,
            'options': {},
            'bbox': {'x': 0, 'y': int(min(ys)), 'w': img_width, 'h': int(max(bs) - min(ys))}
        })
    
    return questions

# ═══════════════════════
# Main
# ═══════════════════════

def main():
    parser = argparse.ArgumentParser(description='Tencent Cloud OCR page extraction')
    parser.add_argument('image', help='Path to page image')
    parser.add_argument('--secret-id', required=True, help='Tencent Cloud SecretId')
    parser.add_argument('--secret-key', required=True, help='Tencent Cloud SecretKey')
    parser.add_argument('--region', default='ap-guangzhou', help='Region')
    parser.add_argument('--high-precision', action='store_true', default=True, help='Use high-precision model')
    parser.add_argument('--output', '-o', help='Output JSON file')
    args = parser.parse_args()
    
    if not os.path.exists(args.image):
        print(json.dumps({"status": "error", "error": f"File not found: {args.image}"}))
        sys.exit(1)
    
    try:
        t0 = time.time()
        response = call_tencent_ocr(args.image, args.secret_id, args.secret_key, args.region, args.high_precision)
        elapsed = time.time() - t0
        
        text_detections = response.get('TextDetections', [])
        img_width = 1707  # default, actual width depends on image
        
        # Try to get actual image dimensions
        try:
            from PIL import Image
            img = Image.open(args.image)
            img_width = img.size[0]
        except:
            pass
        
        questions = blocks_to_questions(text_detections, img_width)
        
        output = {
            "status": "ok",
            "image": args.image,
            "engine": "tencent-ocr",
            "model": "GeneralAccurateOCR" if args.high_precision else "GeneralBasicOCR",
            "elapsed": round(elapsed, 3),
            "totalBlocks": len(text_detections),
            "totalQuestions": len(questions),
            "questions": questions,
            "language": response.get('Language', 'unknown'),
            "angle": response.get('Angle', 0)
        }
        
        if args.output:
            with open(args.output, 'w', encoding='utf-8') as f:
                json.dump(output, f, ensure_ascii=False, indent=2)
        
        print(json.dumps(output, ensure_ascii=False))
        
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False))
        sys.exit(1)

if __name__ == '__main__':
    main()
