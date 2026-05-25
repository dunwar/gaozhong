#!/usr/bin/env python3
"""
gaozhong.online - Phase 1: VL-powered OCR multi-page extractor
Uses Kimi k2.6 in a SINGLE conversation with MULTIPLE rounds:
  Round 1: first half of pages → extract questions
  Round 2: second half of pages + round 1 response as context → complete extraction
This avoids image overload while preserving cross-page context.
"""
import json, sys, os, base64, argparse
from urllib.request import Request, urlopen
from urllib.error import URLError

API_KEY = os.environ.get("KIMI_API_KEY", "")
API_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
MODEL = "kimi-k2.6"

SYSTEM_PROMPT = "你是一位上海高中英语老师，正在整理一套完整试卷。你会分两次收到试卷图片。每次输出 JSON。"

ROUND1_PROMPT = """请帮我识别这套上海高中英语试卷的前半部分。

【你现在看到的是前半部分页面】
请仔细阅读每张图片上的印刷文字，把每道题的内容提取出来。

【怎么读题】
- "1." "21." 这样的题号 = 一道题目
- 一页有多少个可见题号，就有多少道题
- 每道题：题干 + 选项（如有）

【听力题】
- Section 说明文字（"Directions: ..."）忽略，不是题目
- 只有带题号+选项的才输出
- 题干印在图上就抄下来，没印写"（听力题）"

【各题型】
- choice：选择题，有 A/B/C/D 选项
- cloze：完形填空，短文+空格+选项
- reading：阅读理解
- fill_blank：填空（无选项）
- dictation：默写
- translation：翻译题
- grammar：语法填空（句子中含 ___(word) 标记）

【阅读文章】
如果页面有阅读文章段落，在第一道阅读题的 passageText 中抄写全文。
后续同篇文章的题 passageText 写 "[见上一题]"。

【核心规则】
- 一道题 = 一个题号 + 题干 + 四个选项。选项不拆成多道题
- 每道题的选项只属于该题
- bbox 标记题目位置：{x, y, w, h} 像素坐标，从题号到选项末尾

【输出格式】只输出 JSON：
{
  "pages": [
    {
      "pageNumber": 1,
      "firstQuestion": 1,
      "lastQuestion": 20,
      "sections": ["I. Listening"],
      "questions": [
        {
          "questionNumber": 1,
          "questionType": "choice",
          "questionText": "题目原文",
          "options": {"A":"...","B":"...","C":"...","D":"..."},
          "passageText": "",
          "passageTruncated": false,
          "bbox": {"x": 50, "y": 200, "w": 540, "h": 80}
        }
      ]
    }
  ]
}

开始吧，直接输出 JSON（不要解释文字，不要 markdown 代码块）。"""

ROUND2_PROMPT = """以下是这套试卷的后半部分。请继续识别。

【重要】你在前一轮已经识别了前半部分的题目。现在继续识别后半部分，注意：
- 题号续接：如果前半部分最后一题是N题，后半部分从N+1开始
- 阅读文章如果跨页，标记 passageTruncated: true
- 如果某篇文章在前半部分已提取，passageText 写 "[见前半部分]"

【输出格式】直接输出 JSON，不要加任何解释文字，不要加 markdown 代码块：
{"pages":[{"pageNumber":4,"firstQuestion":51,"lastQuestion":70,"sections":["III. Reading"],"questions":[...]}]}

直接输出 JSON："""


def encode_image(path):
    with open(path, 'rb') as f:
        return base64.b64encode(f.read()).decode('utf-8')


def call_kimi(messages, max_tokens=32000, timeout=300):
    """Send a chat completion request with conversation history."""
    key = API_KEY
    if not key:
        raise RuntimeError("KIMI_API_KEY not set")
    
    body = json.dumps({
        "model": MODEL,
        "messages": messages,
        "temperature": 0.05,
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
    """Extract JSON from response with fallbacks. Handles truncated JSON."""
    cleaned = str(text).strip()
    import re
    
    # Try to find JSON inside ``` fences first
    fence_match = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', cleaned)
    if fence_match:
        try:
            return json.loads(fence_match.group(1).strip())
        except:
            pass
    
    # Strip ``` fences if at boundaries
    if cleaned.startswith('```'):
        parts = cleaned.split('\n', 1)
        cleaned = parts[1] if len(parts) > 1 else cleaned[3:]
        if cleaned.rstrip().endswith('```'):
            cleaned = cleaned.rstrip()[:-3]
    cleaned = cleaned.strip()
    
    # Direct parse
    try:
        return json.loads(cleaned)
    except:
        pass
    
    # Find first '{' and try to extract complete JSON object
    brace_start = cleaned.find('{')
    if brace_start >= 0:
        candidate = cleaned[brace_start:]
        
        # Try parsing with decreasing lengths (handle truncation)
        for end_offset in range(len(candidate), max(brace_start, len(candidate) - 2000), -1):
            try:
                return json.loads(candidate[:end_offset])
            except json.JSONDecodeError as e:
                if 'Unterminated string' in str(e) or 'Expecting value' in str(e):
                    continue
                break  # Not a truncation issue
                
        # Last resort: try to close the truncated JSON by adding closing brackets
        truncated = candidate[:len(candidate) - 100]  # Remove the clearly broken part
        # Try adding closing brackets
        for suffix in [']}]', '}]', ']', '}']:
            try:
                return json.loads(truncated + suffix)
            except:
                continue
    
    raise RuntimeError(f"Failed to extract JSON from: {cleaned[:500]}")


def build_image_content(image_paths):
    """Build content array with text + images."""
    content = []
    for path in image_paths:
        if not os.path.exists(path):
            raise RuntimeError(f"Image not found: {path}")
        b64 = encode_image(path)
        mime = "image/png" if path.endswith('.png') else "image/jpeg"
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:{mime};base64,{b64}", "detail": "high"}
        })
    return content


def single_page_extract(image_path):
    """Single page: use a focused prompt optimized for flat question extraction."""
    SINGLE_PROMPT = """请帮我仔细阅读这张上海高中英语试卷页面，把每道题的内容准确提取出来。

【核心规则 — 仔细阅读每一条】
1. 只提取带编号的题目。看到 "1." "21." 这样的数字+标点 = 一道题
2. 一道题 = 一个题号 + 题干 + 四个选项（如有）。四个选项不是四道题！
3. 第1题的选项只属于第1题，不要重复到第2题
4. 听力题如果题干没印在图上，questionText 写 "（听力题）"
5. Section 标题、Directions 说明文字不是题目，不要提取

【每道题输出】
{
  "questionNumber": 1,
  "questionType": "choice",
  "questionText": "题目原文，一字不差抄下来",
  "options": {"A": "...", "B": "...", "C": "...", "D": "..."},
  "bbox": {"x": 50, "y": 200, "w": 540, "h": 80}
}

【输出格式】直接输出JSON：
{"questions":[{"questionNumber":1,"questionType":"choice","questionText":"...","options":{"A":"...","B":"...","C":"...","D":"..."},"bbox":{"x":0,"y":0,"w":0,"h":0}}]}

直接输出JSON："""

    messages = [
        {"role": "system", "content": "你是一位高中英语老师，正在整理试卷。你仔细阅读图片上的印刷文字，逐题提取。最终输出JSON。"},
        {"role": "user", "content": [{"type": "text", "text": SINGLE_PROMPT}] + build_image_content([image_path])}
    ]
    
    text = call_kimi(messages, max_tokens=32000, timeout=300)
    result = extract_json(text)
    
    questions = result.get('questions', [])
    print(f"[ocr-page] Single page: {len(questions)} questions", file=sys.stderr)
    
    return {
        "status": "ok",
        "totalPages": 1,
        "totalQuestions": len(questions),
        "pages": [{"pageNumber": 1, "firstQuestion": questions[0]['questionNumber'] if questions else 0, "lastQuestion": questions[-1]['questionNumber'] if questions else 0, "sections": [], "questions": questions}]
    }

def multi_round_extract(image_paths):
    """Multi-round conversation: 2 pages per round, context preserved across rounds.
    For single page, uses a simplified direct prompt."""
    n = len(image_paths)
    
    # Single page: use direct prompt for speed
    if n == 1:
        return single_page_extract(image_paths[0])
    
    BATCH = 2
    num_rounds = (n + BATCH - 1) // BATCH
    
    print(f"[ocr-page] Total {n} pages → {num_rounds} rounds ({BATCH} pages each)", file=sys.stderr)
    
    all_pages = []
    conversation_messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    
    for round_idx in range(num_rounds):
        start = round_idx * BATCH
        end = min(start + BATCH, n)
        batch = image_paths[start:end]
        
        print(f"[ocr-page] ==== Round {round_idx+1}/{num_rounds}: pages {start+1}-{end} ====", file=sys.stderr)
        
        # Build prompt for this round
        if round_idx == 0:
            round_prompt = f"这是试卷的前{len(batch)}页。请逐页识别每道题。直接输出JSON（不要解释文字，不要markdown代码块）："
        else:
            round_prompt = f"以下是试卷的后续{len(batch)}页。你在前面已经识别了第1到{start}页的题目，现在继续识别。注意题号要从前面的最后一题续接。直接输出JSON（不要解释文字，不要markdown代码块）："
        
        content = [{"type": "text", "text": round_prompt}] + build_image_content(batch)
        
        # Add round messages to conversation
        conversation_messages.append({"role": "user", "content": content})
        
        max_tok = 32000
        r_text = call_kimi(conversation_messages, max_tokens=max_tok, timeout=600)
        r_json = extract_json(r_text)
        
        r_pages = r_json.get('pages', [])
        print(f"[ocr-page] Round {round_idx+1} done: {sum(len(p.get('questions',[])) for p in r_pages)} questions", file=sys.stderr)
        
        # Add assistant response to conversation for next round context
        conversation_messages.append({"role": "assistant", "content": r_text})
        
        all_pages.extend(r_pages)
    
    total_q = sum(len(p.get('questions', [])) for p in all_pages)
    
    return {
        "status": "ok",
        "totalPages": len(all_pages),
        "totalQuestions": total_q,
        "pages": all_pages
    }


def main():
    parser = argparse.ArgumentParser(description='Multi-round OCR extraction via VL')
    parser.add_argument('images', nargs='+', help='Path(s) to page images in order')
    parser.add_argument('--api-key', help='Kimi API key (or set KIMI_API_KEY env)')
    parser.add_argument('--output', '-o', help='Output JSON file path')
    args = parser.parse_args()
    
    global API_KEY
    if args.api_key:
        API_KEY = args.api_key
    
    for p in args.images:
        if not os.path.exists(p):
            print(json.dumps({"error": f"File not found: {p}"}))
            sys.exit(1)
    
    try:
        result = multi_round_extract(args.images)
        
        if args.output:
            with open(args.output, 'w', encoding='utf-8') as f:
                json.dump(result, f, ensure_ascii=False, indent=2)
            print(f"Saved to {args.output}", file=sys.stderr)
        
        print(json.dumps(result, ensure_ascii=False, indent=2))
        
    except Exception as e:
        print(json.dumps({"status": "error", "error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == '__main__':
    main()
