#!/usr/bin/env python3
"""
gaozhong.online - Phase 1: VL-powered OCR page extractor
Uses Kimi k2.6 to extract ALL printed text with bounding boxes.
Output: JSON with questions list (qnum, text, options, bbox, type)
"""
import json, sys, os, base64, argparse
from urllib.request import Request, urlopen
from urllib.error import URLError

API_KEY = os.environ.get("KIMI_API_KEY", "")
API_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
MODEL = "kimi-k2.6"

PROMPT = """You are a precise OCR and layout analysis engine. Analyze this exam paper image and extract ALL printed text with exact bounding boxes.

## CRITICAL: Your ONLY job is OCR + layout. Do NOT evaluate answers. Do NOT judge correctness. Do NOT describe what you see. Just extract text and positions.

## Step 1: Identify ALL question numbers
Scan the ENTIRE page for printed question numbers. Common patterns:
- "1.", "2.", "3." ... (dot after number)
- "21.", "22.", "23." ...
- "1．", "2．" (full-width dot)
- Bold/large numbers at line starts
- Roman numerals like "I.", "II.", "III." are SECTION headers, NOT questions

## Step 2: For EACH question, extract:
- questionNumber: integer
- questionType: "choice" | "fill_blank" | "reading" | "dictation" | "translation" | "writing"
- questionText: the FULL question text (stem/problem statement)
- options: {"A":"...", "B":"...", "C":"...", "D":"..."} (only for choice questions)
- bbox: the bounding box covering this ENTIRE question including all options and answer area
  Format: {"x": int, "y": int, "w": int, "h": int}
  - x,y = top-left corner of the question region
  - w,h = width and height covering from question number through the last option/answer line
  - IMPORTANT: bbox MUST be large enough to include the student's handwritten answer area
  - Include ALL the options area (A/B/C/D lines) within the bbox
  - Extend bbox downward to include where red pen marks would appear

## Step 3: Output format
Return ONLY pure JSON (no markdown, no explanation):
{
  "questions": [
    {
      "questionNumber": 21,
      "questionType": "choice",
      "questionText": "The professor gave the students ...",
      "options": {"A": "a lecture", "B": "a test", "C": "a project", "D": "a report"},
      "bbox": {"x": 45, "y": 120, "w": 520, "h": 85}
    },
    {
      "questionNumber": 22,
      "questionType": "...",
      "questionText": "...",
      "options": {},
      "bbox": {"x": 45, "y": 210, "w": 520, "h": 65}
    }
  ]
}

## Rules:
1. Every visible question number on the page = one question object
2. qnums MUST be sequential and start from the first visible number on the page
3. bbox coordinates are integer pixels relative to the top-left corner of the image
4. bbox width should cover the full text column width (~500-600px for standard A4)
5. bbox height should be generous enough to include student answers and red pen marks
6. For dictation/fill_blank questions arranged in columns, each numbered item is a separate question
7. If question text spans multiple lines, include ALL lines in questionText
8. questionText: copy the EXACT printed text, do not summarize or truncate
9. For reading comprehension: the passage itself is NOT a question; only the numbered questions under it are
10. Include the reading passage reference text in the first question's questionText if helpful"""

def encode_image(path):
    with open(path, 'rb') as f:
        return base64.b64encode(f.read()).decode('utf-8')

def call_kimi_vision(image_path, api_key=None):
    key = api_key or API_KEY
    if not key:
        raise RuntimeError("KIMI_API_KEY not set")
    
    b64 = encode_image(image_path)
    mime = "image/png" if image_path.endswith('.png') else "image/jpeg"
    
    body = json.dumps({
        "model": MODEL,
        "messages": [
            {"role": "system", "content": "You are a precise OCR engine. Output ONLY pure JSON. No markdown. No explanations."},
            {"role": "user", "content": [
                {"type": "text", "text": PROMPT},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}", "detail": "high"}}
            ]}
        ],
        "temperature": 0.1,
        "max_tokens": 8000
    }).encode('utf-8')
    
    req = Request(API_URL, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}"
    })
    
    try:
        with urlopen(req, timeout=180) as resp:
            result = json.loads(resp.read().decode('utf-8'))
        content = result['choices'][0]['message']['content']
        return extract_json(content)
    except URLError as e:
        raise RuntimeError(f"API call failed: {e}")

def extract_json(text):
    """Extract JSON from VL response with fallbacks."""
    cleaned = str(text).strip()
    
    # Remove markdown fences
    if cleaned.startswith('```'):
        cleaned = cleaned.split('\n', 1)[1] if '\n' in cleaned else cleaned[3:]
        if cleaned.endswith('```'):
            cleaned = cleaned[:-3]
    cleaned = cleaned.strip()
    
    # Direct parse
    try:
        return json.loads(cleaned)
    except:
        pass
    
    # Find JSON object
    import re
    m = re.search(r'\{[\s\S]*\}', cleaned)
    if m:
        try:
            return json.loads(m.group(0))
        except:
            pass
    
    raise RuntimeError(f"Failed to extract JSON from: {cleaned[:500]}")

def main():
    parser = argparse.ArgumentParser(description='OCR page extraction via VL')
    parser.add_argument('image', help='Path to page image')
    parser.add_argument('--api-key', help='Kimi API key (or set KIMI_API_KEY env)')
    parser.add_argument('--output', '-o', help='Output JSON file path')
    args = parser.parse_args()
    
    if not os.path.exists(args.image):
        print(json.dumps({"error": f"File not found: {args.image}"}))
        sys.exit(1)
    
    try:
        result = call_kimi_vision(args.image, args.api_key)
        
        # Validate
        if 'questions' not in result:
            result = {'questions': result} if isinstance(result, list) else result
        
        questions = result.get('questions', [])
        
        # Sort by question number
        questions.sort(key=lambda q: q.get('questionNumber', 0))
        
        output = {
            "status": "ok",
            "image": args.image,
            "totalQuestions": len(questions),
            "questions": questions
        }
        
        if args.output:
            with open(args.output, 'w', encoding='utf-8') as f:
                json.dump(output, f, ensure_ascii=False, indent=2)
            print(f"Saved to {args.output}")
        
        print(json.dumps(output, ensure_ascii=False, indent=2))
        
    except Exception as e:
        print(json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False))
        sys.exit(1)

if __name__ == '__main__':
    main()
