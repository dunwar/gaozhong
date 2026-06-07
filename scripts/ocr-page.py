#!/usr/bin/env python3
"""
gaozhong.online — VL OCR single-page extractor (v2.0)
Uses Kimi k2.6 per-page with retry + strict JSON format.
"""
import json, sys, os, base64, argparse, time
from urllib.request import Request, urlopen
from urllib.error import URLError

API_KEY = os.environ.get("KIMI_API_KEY", "")
API_URL = "https://api.moonshot.cn/v1/chat/completions"
MODEL = "moonshot-v1-8k-vision-preview"
API_TIMEOUT = 300  # per-call timeout (seconds) — kimi-k2.6 reasoning model needs more time
MAX_RETRIES = 3
RETRY_BACKOFF_BASE = 3  # seconds; actual = base * 2^attempt

SINGLE_PAGE_SYSTEM = "你是一位上海高中英语老师。你仔细看试卷图片，逐题提取印刷文字。最终只输出JSON，不加任何解释。"

SINGLE_PAGE_PROMPT = """请识别这张试卷页面上的所有题目，逐题提取印刷文字。

══════════════════════════════════
【版面分析 — 先判断结构】
══════════════════════════════════
第1步：观察页面整体排版
- 是单栏还是双栏？
- 双栏的话，先读完左栏（从上到下），再读右栏（从上到下）
- ⚠️ 严禁将左右两栏的文字混在一起当成一行！

══════════════════════════════════
【题目识别规则】
══════════════════════════════════
1. 看到 "21." "22." 等数字+标点 = 一道题
2. 一道题 = 题号 + 题干 + 选项（如有）。选项是同一道题的，不要拆开
3. 听力题题干空白 → questionText 填 "(听力题)"
4. Section 标题、Directions 说明、页眉页脚 → 忽略

══════════════════════════════════
【阅读理解 — 特殊处理】
══════════════════════════════════
- 第1道阅读题：passageText 抄写文章全文（逐字，不要省略）
- 第2-5道同一文章的题：passageText 填 "[见上题]"
- 如果文章跨段落，全部合并到第一道题的 passageText

══════════════════════════════════
【题型对照】
══════════════════════════════════
- choice: 选择题（有A/B/C/D选项）
- cloze: 完形填空
- reading: 阅读理解
- grammar: 语法填空（句子中有 ___ 标记）
- fill_blank: 填空题
- translation: 翻译题
- dictation: 默写
- listening: 听力题

【输出JSON格式 — 严格按此格式，不要增减字段】
{"passages":[{"text":"阅读文章全文..."}],"questions":[
  {"questionNumber":1,"questionType":"choice","questionText":"题干原文","options":{"A":"选项A","B":"选项B","C":"选项C","D":"选项D"},"passageText":"","passageRef":null,"bbox":{"x":0,"y":0,"w":0,"h":0}}
]}

只输出这个JSON对象，不要markdown代码块，不要"```json"，不要额外解释。

⚠️ bbox要求：每道题的bbox必须根据图片中的实际位置逐一计算，禁止所有题目使用相同的bbox值！"""


def encode_image(path):
    with open(path, 'rb') as f:
        return base64.b64encode(f.read()).decode('utf-8')


def call_kimi(messages, max_tokens=32000, timeout=API_TIMEOUT):
    key = API_KEY
    if not key:
        raise RuntimeError("KIMI_API_KEY not set")
    
    body = json.dumps({
        "model": MODEL,
        "messages": messages,
        "temperature": 1,  # kimi-k2.6 only allows temperature=1
        "max_tokens": max_tokens
    }).encode('utf-8')
    
    req = Request(API_URL, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}"
    })
    
    try:
        with urlopen(req, timeout=timeout) as resp:
            result = json.loads(resp.read().decode('utf-8'))
        choice = result['choices'][0]
        finish = choice.get('finish_reason', 'unknown')
        content = choice['message']['content']
        tokens = result.get('usage', {})
        print(f"[kimi] finish={finish}, prompt_tokens={tokens.get('prompt_tokens','?')}, completion_tokens={tokens.get('completion_tokens','?')}, chars={len(content)}", file=sys.stderr)
        if finish == 'length':
            print("[kimi] ⚠️ Output truncated! Increase max_tokens.", file=sys.stderr)
        return content
    except URLError as e:
        raise RuntimeError(f"API call failed: {e}")


def extract_json(text):
    """Extract JSON from VL response. Multi-tier fallback."""
    import re
    cleaned = str(text).strip()
    
    # Tier 1: inside ```json / ``` fences
    fence_match = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', cleaned)
    if fence_match:
        try:
            return json.loads(fence_match.group(1).strip())
        except:
            pass
    
    # Tier 2: strip leading/trailing ```
    if cleaned.startswith('```'):
        cleaned = re.sub(r'^```\w*\s*', '', cleaned)
        cleaned = re.sub(r'\s*```$', '', cleaned)
        cleaned = cleaned.strip()
    
    # Tier 3: direct parse
    try:
        return json.loads(cleaned)
    except:
        pass
    
    # Tier 4: find complete JSON object (handle prefix text)
    brace_start = cleaned.find('{')
    if brace_start >= 0:
        candidate = cleaned[brace_start:]
        # Try decreasing lengths for truncated JSON
        for end_offset in range(len(candidate), max(brace_start, len(candidate) - 1000), -1):
            try:
                return json.loads(candidate[:end_offset])
            except json.JSONDecodeError:
                continue
        
        # Try adding closing brackets for truncated JSON
        for suffix in ['"}]}]}', '"}]}', '}]}', '}]', ']}', '}']:
            try:
                return json.loads(candidate + suffix)
            except:
                continue
    
    # Tier 5: regex fallback — parse question-number + text + options
    q_pattern = re.findall(
        r'(?:^|\n)\s*(\d+)\.\s*(.+?)(?=\s*(?:\n\s*\d+\.|\n\s*$|$))',
        cleaned, re.DOTALL
    )
    if q_pattern:
        questions = []
        for num, body_text in q_pattern:
            num = int(num)
            opt_match = re.findall(
                r'\b([A-E])\s*[\.\s]\s*(.+?)(?=\s*\b[A-E]\s*[\.\s]|\s*$)',
                body_text.strip()
            )
            opts = {k: v.strip().rstrip(';,.') for k, v in opt_match} if opt_match else {}
            q_text = body_text.strip()
            if opts:
                for k, v in opts.items():
                    q_text = q_text.replace(f'{k}. {v}', '').replace(f'{k}.{v}', '')
                q_text = q_text.strip().rstrip(';,.')
            questions.append({
                'questionNumber': num,
                'questionType': 'choice',
                'questionText': q_text or '(题目)',
                'options': opts,
                'passageText': '',
                'passageTruncated': False,
                'bbox': {'x': 0, 'y': 0, 'w': 0, 'h': 0}
            })
        if questions:
            print(f'[ocr-page] Regex fallback extracted {len(questions)} questions', file=sys.stderr)
            return {'questions': questions}
    
    raise RuntimeError(f"Failed to extract JSON from response ({len(cleaned)} chars): {cleaned[:200]}")


def build_image_content(image_path):
    if not os.path.exists(image_path):
        raise RuntimeError(f"Image not found: {image_path}")
    b64 = encode_image(image_path)
    mime = "image/png" if image_path.endswith('.png') else "image/jpeg"
    return [{
        "type": "image_url",
        "image_url": {"url": f"data:{mime};base64,{b64}", "detail": "high"}
    }]


def single_page_extract(image_path):
    """Extract questions from one page with retry on failure."""
    messages = [
        {"role": "system", "content": SINGLE_PAGE_SYSTEM},
        {"role": "user", "content": [{"type": "text", "text": SINGLE_PAGE_PROMPT}] + build_image_content(image_path)}
    ]
    
    last_error = None
    for attempt in range(MAX_RETRIES):
        try:
            text = call_kimi(messages, max_tokens=32000, timeout=API_TIMEOUT)
            result = extract_json(text)
            questions = result.get('questions', [])
            
            if not questions:
                raise RuntimeError("No questions found in response")
            
            print(f"[ocr-page] Page done: {len(questions)} questions (attempt {attempt+1})", file=sys.stderr)
            
            return {
                "status": "ok",
                "totalQuestions": len(questions),
                "questions": questions,
                "passages": result.get('passages', [])
            }
        except Exception as e:
            last_error = e
            if attempt < MAX_RETRIES - 1:
                wait = RETRY_BACKOFF_BASE * (2 ** attempt)
                print(f"[ocr-page] Attempt {attempt+1} failed ({e}), retry in {wait}s...", file=sys.stderr)
                time.sleep(wait)
    
    raise RuntimeError(f"All {MAX_RETRIES} attempts failed: {last_error}")


def main():
    parser = argparse.ArgumentParser(description='VL OCR per-page extraction')
    parser.add_argument('images', nargs='+', help='Image path(s) — only first one used (per-page mode)')
    parser.add_argument('--api-key', help='Kimi API key (or set KIMI_API_KEY env)')
    parser.add_argument('--output', '-o', help='Output JSON file path')
    args = parser.parse_args()
    
    global API_KEY
    if args.api_key:
        API_KEY = args.api_key
    
    image_path = args.images[0]
    if not os.path.exists(image_path):
        print(json.dumps({"error": f"File not found: {image_path}"}))
        sys.exit(1)
    
    try:
        result = single_page_extract(image_path)
        
        if args.output:
            with open(args.output, 'w', encoding='utf-8') as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
            print(f"Saved to {args.output}", file=sys.stderr)
        
        print(json.dumps(result, ensure_ascii=False))
        
    except Exception as e:
        print(json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
