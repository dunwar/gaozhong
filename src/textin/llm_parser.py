"""
LLM Question Parser for gaozhong
================================
Replaces regex parser with LLM-driven extraction.
Takes TextIn detail items → formats them as structured text → LLM extracts questions.

Key advantage over regex:
- Understands exam paper structure (Section, Part, Listening, Cloze)
- Groups listening options (A/B/C/D) into questions without explicit numbers
- Correctly maps cloze embedded numbers (73.A.humanity → Q73)
- Uses outline_level for section boundaries
- Does NOT hallucinate gap-filling questions

Usage:
    from src.textin.llm_parser import parse_with_llm
    result = parse_with_llm(detail_items, image_size={'width':1280,'height':1700})
"""

import json
import os
import re
import logging
from typing import List, Dict, Optional

logger = logging.getLogger(__name__)

# DeepSeek API config
DEEPSEEK_API_KEY = os.environ.get('DEEPSEEK_API_KEY', '')
DEEPSEEK_API_URL = os.environ.get('DEEPSEEK_API_URL',
    'https://api.deepseek.com/v1/chat/completions')
LLM_MODEL = os.environ.get('MODEL_PARSER', 'deepseek-v4-pro')
LLM_TIMEOUT = int(os.environ.get('LLM_PARSE_TIMEOUT', '90'))


def _format_items(items: List[Dict]) -> str:
    """Format TextIn detail items into a structured text for LLM input.

    Groups items by approximate y-position, uses outline_level for section markers.
    """
    lines = []
    for item in items:
        text = item.get('text', '').strip()
        if not text:
            continue

        ol = item.get('outline_level', -1)
        content_type = item.get('content', 0)
        pos = item.get('position', [])

        # Calculate y-center for ordering
        if pos and len(pos) >= 8:
            y_center = int(sum(pos[i] for i in range(1, len(pos), 2)) / (len(pos) // 2))
        else:
            y_center = 0

        # Build annotation prefix
        prefix = ''
        if content_type == 1:
            prefix = '[页眉页脚] '
        elif ol == 0:
            prefix = '# '  # H1 title
        elif ol == 1:
            prefix = '## '  # H2 section
        elif ol >= 2:
            prefix = '### '  # H3+ subsection

        lines.append({
            'text': prefix + text,
            'y': y_center,
            'ol': ol,
        })

    # Sort by y position (top to bottom, left to right implied by TextIn order)
    # TextIn already returns items in reading order, so we keep original order
    return '\n'.join(l['text'] for l in lines)


def _build_prompt(formatted_text: str, image_size: Dict) -> str:
    """Build the LLM prompt for question extraction."""
    return f"""你是上海高中英语教研专家。下面是 TextIn OCR 从一张试卷页面识别出的文字。

请逐题提取所有题目，输出 JSON。

【识别文字 — 按版面从上到下】
{formatted_text}

【提取规则】
1. 题号: 试卷上印刷的数字编号。听力题可能没有显式题号 → 按选项组编号(第1组=Q1,第2组=Q2...)
2. 听力题(Section A Short Conversations): 连续4个A/B/C/D选项 = 1道听力题。questionText填"(听力题)"
3. 完形填空: 题号可能嵌入选项行如"73.A.humanity"→题号=73
4. 语法填空: 正文中含 ___(题号) 标记或 "1.A.xxx B.xxx" 格式
5. 阅读理解: passageText 提取文章全文, passageRef 指向文章编号
6. 翻译题(Q21-25): 含中文的题目
7. 题型: choice/cloze/reading/grammar/translation/listening
8. bbox: 设为 {{"x":0,"y":0,"w":0,"h":0}}
9. 只输出题目JSON, 不要"```json", 不要解释

【输出格式】
{{"questions":[
  {{"questionNumber":1,"questionType":"listening","questionText":"(听力题)","options":{{"A":"...","B":"...","C":"...","D":"..."}},"passageText":"","passageRef":null,"bbox":{{"x":0,"y":0,"w":0,"h":0}}}},
  {{"questionNumber":21,"questionType":"grammar","questionText":"题干文本","options":{{"A":"...","B":"...","C":"...","D":"..."}},"passageText":"","passageRef":null,"bbox":{{"x":0,"y":0,"w":0,"h":0}}}}
]}}

⚠️ 输出完整的JSON数组，包含页面上的每一道题！"""


def _call_llm(prompt: str) -> Optional[Dict]:
    """Call DeepSeek LLM API to parse questions."""
    import urllib.request
    import urllib.error

    if not DEEPSEEK_API_KEY:
        logger.warning("DEEPSEEK_API_KEY not set, LLM parser unavailable")
        return None

    body = json.dumps({
        'model': LLM_MODEL,
        'messages': [{'role': 'user', 'content': prompt}],
        'temperature': 0.05,
        'max_tokens': 16384,
    }).encode('utf-8')

    req = urllib.request.Request(DEEPSEEK_API_URL, data=body, headers={
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {DEEPSEEK_API_KEY}',
    })

    try:
        with urllib.request.urlopen(req, timeout=LLM_TIMEOUT) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            content = data['choices'][0]['message']['content']
            return _parse_llm_response(content)
    except urllib.error.URLError as e:
        logger.error(f"LLM API error: {e}")
        return None
    except Exception as e:
        logger.error(f"LLM parse error: {e}")
        return None


def _parse_llm_response(content: str) -> Optional[Dict]:
    """Parse LLM JSON response, handling truncation and formatting issues."""
    # Try direct JSON parse
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass

    # Try extracting JSON from code blocks
    for pattern in [r'```json\s*([\s\S]*?)```', r'```\s*([\s\S]*?)```', r'\{[\s\S]*"questions"[\s\S]*\}']:
        m = re.search(pattern, content)
        if m:
            try:
                return json.loads(m.group(1) if m.lastindex else m.group(0))
            except json.JSONDecodeError:
                continue

    # Try recovering truncated JSON (close unclosed brackets)
    for attempt in range(1, 5):
        fixed = content.rstrip()
        if fixed.endswith(','):
            fixed = fixed[:-1] + '}]}]}'
        else:
            fixed += '}]}]}'
        try:
            result = json.loads(fixed)
            logger.warning(f"Recovered truncated JSON with {attempt} bracket patches")
            return result
        except json.JSONDecodeError:
            continue

    # Last resort: try to extract individual question objects
    q_objs = re.findall(r'\{\s*"questionNumber"[^}]*\}', content)
    if q_objs:
        questions = []
        for q_str in q_objs:
            try:
                questions.append(json.loads(q_str))
            except json.JSONDecodeError:
                continue
        if questions:
            logger.warning(f"Extracted {len(questions)} questions from truncated JSON")
            return {'questions': questions}

    logger.error(f"Could not parse LLM response: {content[:300]}")
    return None


def _llm_result_to_gaozhong(llm_result: Dict, image_size: Dict) -> Dict:
    """Convert LLM parsed result to gaozhong-compatible format."""
    questions = llm_result.get('questions', [])
    gaozhong_questions = []

    for q in questions:
        qn = q.get('questionNumber', 0)
        if not qn or qn < 1:
            continue

        options = q.get('options', {})
        if isinstance(options, list):
            # Convert list format to dict
            options = {chr(65+i): v for i, v in enumerate(options)}

        gaozhong_questions.append({
            'questionNumber': qn,
            'questionType': q.get('questionType', 'choice'),
            'questionText': (q.get('questionText', '') or '')[:300],
            'options': options,
            'bbox': q.get('bbox', {'x': 0, 'y': 0, 'w': 0, 'h': 0}),
            'passageRef': q.get('passageRef'),
            'passageText': q.get('passageText', '') or '',
        })

    # Sort by question number
    gaozhong_questions.sort(key=lambda q: q['questionNumber'])

    return {
        'questions': gaozhong_questions,
        'passages': llm_result.get('passages', []),
        'engine': f'textin-pdf_to_markdown-llm-{LLM_MODEL}',
        'image_size': image_size or {},
        'raw_count': len(gaozhong_questions),
    }


def parse_with_llm(detail_items: List[Dict],
                   image_size: Optional[Dict] = None,
                   subject: str = "英语") -> Optional[Dict]:
    """
    Parse TextIn detail items using LLM.

    Args:
        detail_items: TextIn result.detail array
        image_size: Optional {width, height}
        subject: Subject name (for prompt customization)

    Returns:
        Dict with gaozhong-compatible format, or None if LLM unavailable/failed
    """
    if not detail_items:
        return None

    if not DEEPSEEK_API_KEY:
        logger.info("DEEPSEEK_API_KEY not set, skipping LLM parser")
        return None

    logger.info(f"LLM parser: {len(detail_items)} detail items, subject={subject}")

    # Format items as structured text
    formatted = _format_items(detail_items)
    logger.info(f"LLM parser: formatted {len(formatted)} chars")

    # Build and send prompt
    prompt = _build_prompt(formatted, image_size or {})
    llm_result = _call_llm(prompt)

    if not llm_result:
        return None

    # Convert to gaozhong format
    result = _llm_result_to_gaozhong(llm_result, image_size or {})
    logger.info(f"LLM parser: extracted {result['raw_count']} questions")

    return result


def parse_with_llm_fallback(detail_items: List[Dict],
                            image_size: Optional[Dict] = None,
                            subject: str = "英语") -> Dict:
    """
    Try LLM parser first, fall back to regex parser if LLM fails.

    Returns:
        Dict with gaozhong-compatible format
    """
    # Try LLM parser first
    if DEEPSEEK_API_KEY:
        key_preview = DEEPSEEK_API_KEY[:8] + '...' if len(DEEPSEEK_API_KEY) > 8 else '(empty)'
        print(f"TextIn Parser: trying LLM parser (model={LLM_MODEL}, key={key_preview})", flush=True)
        result = parse_with_llm(detail_items, image_size, subject)
        if result and result.get('questions'):
            print(f"TextIn Parser: LLM extracted {result['raw_count']} questions", flush=True)
            return result
        print("TextIn Parser: LLM failed, falling back to regex parser", flush=True)
    else:
        print("TextIn Parser: DEEPSEEK_API_KEY not set, using regex parser", flush=True)

    # Fall back to regex parser
    from src.textin.parser import parse_xparse_result
    result = parse_xparse_result(detail_items, image_size, subject)
    print(f"TextIn Parser: regex extracted {result.get('raw_count', len(result.get('questions',[])))} questions", flush=True)
    return result
