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
    """Format TextIn detail items into indexed text for LLM input.

    Each item gets an [idx=N] marker so the LLM can reference which items
    belong to each question. We can then recover real positions from TextIn data.
    """
    lines = []
    for idx, item in enumerate(items):
        item_type = item.get('type', 'paragraph')
        content_type = item.get('content', 0)

        # Skip headers, footers, sidebars
        if content_type == 1:
            continue

        ol = item.get('outline_level', -1)
        text = item.get('text', '').strip()

        # Handle tables — extract cell text row by row
        if item_type == 'table':
            cells = item.get('cells', [])
            if cells:
                table_lines = [f'[idx={idx}] [表格开始]']
                rows = {}
                for cell in cells:
                    r = cell.get('row', 0)
                    if r not in rows:
                        rows[r] = []
                    rows[r].append(cell.get('text', '').strip())
                for r in sorted(rows.keys()):
                    table_lines.append(f'[idx={idx}] | ' + ' | '.join(rows[r]))
                table_lines.append(f'[idx={idx}] [表格结束]')
                lines.append('\n'.join(table_lines))
            continue

        # Handle images
        if item_type == 'image':
            lines.append(f'[idx={idx}] [图片]')
            continue

        # Skip empty paragraphs
        if not text:
            continue

        # Build annotation prefix
        prefix = ''
        if ol == 0:
            prefix = '# '
        elif ol == 1:
            prefix = '## '
        elif ol >= 2:
            prefix = '### '

        lines.append(f'[idx={idx}] {prefix}{text}')

    return '\n'.join(lines)


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
6. 翻译题(translation): "21．中文句子（提示词）", 全角句号, 含中文+英文提示词, options={{}}
7. 选句填空(sentence_gap): 短文4空, 表格6句(A-F)选4填入
8. 语法填空(grammar_fill): 短文含 ___() 无选项, 填单词正确形式
9. 写作(writing): 英文提示+要求, 无选项, 通常最后一页
10. 题型: listening/grammar/vocabulary/cloze/reading/sentence_gap/translation/grammar_fill/writing
8. bbox: 设为 {{"x":0,"y":0,"w":0,"h":0}}
9. 只输出题目JSON, 不要"```json", 不要解释

【输出格式】
{{"questions":[
  {{"questionNumber":1,"pageIndex":1,"questionType":"listening","questionText":"(听力题)","options":{{"A":"...","B":"...","C":"...","D":"..."}},"itemIndices":[5,6,7,8],"passageText":"","passageRef":null}},
  {{"questionNumber":21,"pageIndex":1,"questionType":"grammar","questionText":"题干文本","options":{{"A":"...","B":"...","C":"...","D":"..."}},"itemIndices":[105,106,107,108,109],"passageText":"","passageRef":null}}
]}}

⚠️ pageIndex 和 itemIndices 是关键字段！
- pageIndex: 题目所在页码(1-6)
- itemIndices: 该题覆盖的所有 [idx=N] 编号（同一页内的编号）"""


def _compute_bbox(item_indices: List[int], detail_items: List[Dict]) -> Dict:
    """Compute the bounding box from a set of TextIn detail item indices."""
    if not item_indices or not detail_items:
        return {'x': 0, 'y': 0, 'w': 0, 'h': 0}

    xs, ys = [], []
    for idx in item_indices:
        if 0 <= idx < len(detail_items):
            pos = detail_items[idx].get('position', [])
            if pos and len(pos) >= 8:
                xs.extend([pos[i] for i in range(0, len(pos), 2)])
                ys.extend([pos[i] for i in range(1, len(pos), 2)])

    if not xs or not ys:
        return {'x': 0, 'y': 0, 'w': 0, 'h': 0}

    return {
        'x': int(min(xs)),
        'y': int(min(ys)),
        'w': int(max(xs) - min(xs)),
        'h': int(max(ys) - min(ys)),
    }


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
        'max_tokens': 32768,
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

    # Try recovering truncated JSON (close unclosed brackets/strings)
    # Remove trailing incomplete content
    fixed = content.rstrip()
    # If ends mid-string-value, close the string
    if fixed.rfind('\"') < fixed.rfind(':') or fixed.endswith('\"'):
        pass  # string might be complete
    fixed = re.sub(r':\s*"[^"]*$', ': ""', fixed)  # close broken string values
    fixed = re.sub(r':\s*[\[{][^}\]]*$', ': null', fixed)  # close broken arrays/objects
    fixed = re.sub(r',\s*$', '', fixed)  # remove trailing comma
    # Close unclosed structures
    open_braces = fixed.count('{') - fixed.count('}')
    open_brackets = fixed.count('[') - fixed.count(']')
    fixed += '}' * max(0, open_braces) + ']' * max(0, open_brackets)
    try:
        result = json.loads(fixed)
        logger.warning(f"Recovered truncated JSON")
        return result
    except json.JSONDecodeError:
        pass

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


def _llm_result_to_gaozhong(llm_result: Dict, image_size: Dict,
                            detail_items: List[Dict] = None,
                            all_page_items: List[List[Dict]] = None) -> Dict:
    """Convert LLM parsed result to gaozhong-compatible format.

    Uses itemIndices + pageIndex from LLM output to compute real bbox
    from TextIn position data. Falls back to all-zero bbox if no indices.
    """
    questions = llm_result.get('questions', [])
    gaozhong_questions = []

    for q in questions:
        qn = q.get('questionNumber', 0)
        if not qn or qn < 1:
            continue

        options = q.get('options', {})
        if isinstance(options, list):
            options = {chr(65+i): v for i, v in enumerate(options)}

        # Compute real bbox from item indices
        item_indices = q.get('itemIndices', [])
        page_idx = q.get('pageIndex', 0) - 1  # 1-based → 0-based

        # Select correct detail items for this question's page
        if all_page_items and 0 <= page_idx < len(all_page_items):
            page_items = all_page_items[page_idx]
        elif detail_items:
            page_items = detail_items
        else:
            page_items = []

        bbox = _compute_bbox(item_indices, page_items)

        gaozhong_questions.append({
            'questionNumber': qn,
            'questionType': q.get('questionType', 'choice'),
            'questionText': (q.get('questionText', '') or '')[:300],
            'options': options,
            'bbox': bbox,
            'pageIndex': page_idx + 1 if all_page_items else (q.get('pageIndex', 1)),
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

    # Convert to gaozhong format with real bbox from TextIn positions
    result = _llm_result_to_gaozhong(llm_result, image_size or {}, detail_items)
    logger.info(f"LLM parser: extracted {result['raw_count']} questions")

    return result


def parse_all_pages_llm(all_detail_items: List[List[Dict]],
                        image_size: Optional[Dict] = None,
                        subject: str = "英语") -> Optional[Dict]:
    """
    Parse ALL pages at once with a single LLM call.
    Merges all pages' text → LLM sees the complete exam paper.

    Args:
        all_detail_items: List of per-page detail item lists
        image_size: Optional {width, height}
        subject: Subject name

    Returns:
        Dict with gaozhong-compatible format, or None if LLM unavailable/failed
    """
    if not DEEPSEEK_API_KEY:
        return None

    total_items = sum(len(items) for items in all_detail_items)
    logger.info(f"LLM all-pages: {len(all_detail_items)} pages, {total_items} total items")

    # Format each page with separator (per-page [idx=N] markers)
    all_formatted = []
    for pi, items in enumerate(all_detail_items):
        page_text = _format_items(items)
        all_formatted.append(f"══════ 第 {pi+1} 页 ══════\n{page_text}")

    full_text = '\n\n'.join(all_formatted)
    logger.info(f"LLM all-pages: formatted {len(full_text)} chars")

    # Build prompt for full exam
    prompt = f"""你是上海高中英语教研专家。下面是 TextIn OCR 从一套完整英语试卷识别出的所有文字,按页组织。

请逐题提取这套试卷的全部题目,输出 JSON。注意题号是试卷原始编号,跨页连续。

{full_text}

【提取规则】
1. 题号: 试卷上印刷的数字编号。听力题无显式题号 → 按选项组编号(第1组=Q1,第2组=Q2...)
2. 听力题(Section A): 连续4个A/B/C/D选项 = 1道听力题。questionText填"(听力题)", type=listening
3. 完形填空: 题号嵌入选项行如"73.A.humanity"→题号=73
4. 语法/选词填空: 正文中含 ___(题号) 或 "F52" "54E" 等嵌入格式,从词框表格中匹配选项
5. 阅读理解: passageText 提取文章全文
6. 翻译题(translation): "21．中文（提示词）" 全角句号, 含中文+英文提示词, options={{}}
7. 选句填空(sentence_gap): 短文4空, 表格6句(A-F)选4填入
8. 语法填空(grammar_fill): 短文含 ___() 无选项, 填单词正确形式
9. 写作(writing): 英文提示+要求, 无选项, 通常最后一页
10. 题型: listening/grammar/vocabulary/cloze/reading/sentence_gap/translation/grammar_fill/writing
9. 只输出JSON, 不要```json```, 不要解释
10. ⚠️ 提取试卷中的每一道题! 不要遗漏!

【输出格式】
{{"questions":[
  {{"questionNumber":1,"questionType":"listening","questionText":"(听力题)","options":{{"A":"...","B":"...","C":"...","D":"..."}},"passageText":"","passageRef":null,"bbox":{{"x":0,"y":0,"w":0,"h":0}}}}
]}}"""

    # Call LLM with large limits for full exam
    import urllib.request
    import urllib.error

    body = json.dumps({
        'model': LLM_MODEL,
        'messages': [{'role': 'user', 'content': prompt}],
        'temperature': 0.05,
        'max_tokens': 65536,
    }).encode('utf-8')

    req = urllib.request.Request(DEEPSEEK_API_URL, data=body, headers={
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {DEEPSEEK_API_KEY}',
    })

    timeout = int(os.environ.get('LLM_PARSE_TIMEOUT_BIG', '480'))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            content = data['choices'][0]['message']['content']
            llm_result = _parse_llm_response(content)
    except Exception as e:
        logger.error(f"LLM all-pages error: {e}")
        return None

    if not llm_result:
        return None

    result = _llm_result_to_gaozhong(llm_result, image_size or {},
                                      all_page_items=all_detail_items)
    logger.info(f"LLM all-pages: extracted {result['raw_count']} questions total")
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
