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
- Pre-cleans OCR粘连 artifacts before LLM input

Usage:
    from src.textin.llm_parser import parse_with_llm
    result = parse_with_llm(detail_items, image_size={'width':1280,'height':1700})
"""

import json
import os
import re
import logging
from typing import List, Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# DeepSeek API config
DEEPSEEK_API_KEY = os.environ.get('DEEPSEEK_API_KEY', '')
DEEPSEEK_API_URL = os.environ.get('DEEPSEEK_API_URL',
    'https://api.deepseek.com/v1/chat/completions')
LLM_MODEL = os.environ.get('MODEL_PARSER', 'deepseek-v4-pro')
LLM_TIMEOUT = int(os.environ.get('LLM_PARSE_TIMEOUT', '90'))


# ═══════════════════════════════════════════════════════════════════════
# Layer 2: OCR文本预清洗 — 修复 TextIn 常见粘连问题
# ═══════════════════════════════════════════════════════════════════════

def _clean_ocr_text(text: str) -> str:
    """Pre-clean TextIn OCR粘连 artifacts before sending to LLM.

    TextIn OCR has three known quality issues that cause LLM mis-parsing:
    1. Option letter glued to next question number: "A43.The company" → option A + Q43
    2. Content glued to next question number mid-sentence: "...translateI 46 .A"
    3. Duplicated option letters: "CC.burn" → "C. burn"

    We fix the most common, unambiguous patterns here. Remaining edge cases
    are handled by the LLM prompt's 【OCR粘连处理】 rules.
    """
    if not text:
        return text

    # ---- Pattern 1: Option letter (A-D) glued to next question number ----
    # "A43.The insurance" → "A\n43. The insurance"
    # "D41.The ancient skill" → "D\n41. The ancient skill"
    # Guard: number is 2-3 digits followed by period, followed by uppercase
    text = re.sub(
        r'\b([A-D])(\d{2,3}\.)(\s*[A-Z])',
        r'\1\n\2\3',
        text
    )

    # ---- Pattern 2: Content+question number粘连 mid-sentence ----
    # "...translateI 46 .A Japanese" → "...translate I\n46. A Japanese"
    # "true in otherI61 .Nobel" → "true in other I\n61. Nobel"
    # Pattern: lowercase + uppercase + whitespace + 2-3 digit num + . + space + uppercase
    text = re.sub(
        r'([a-z])([A-Z])\s+(\d{2,3})\s*\.\s*([A-Z])',
        r'\1 \2\n\3. \4',
        text
    )

    # ---- Pattern 3: Word glued to question number (no following period) ----
    # "...a preciseK47" → "...a precise K\n47."
    # "English's lack of a preciseK47" → the next item starts with 47
    text = re.sub(
        r'([a-z])([A-Z])(\d{2,3})\b(?!\.)',
        r'\1 \2\n\3.',
        text
    )

    # ---- Pattern 4: Duplicated option letters (OCR artifact) ----
    # "CC.burn the midnight oil" → "C. burn the midnight oil"
    # "B,C.What farming techniques" → "C. What farming techniques"
    text = re.sub(
        r'\b([A-D]),?\1\.\s*',
        r'\1. ',
        text
    )

    # ---- Pattern 5: Garbage prefix before clean question number ----
    # "AC.WwSSdo13. 3.Why does" → "3. Why does"
    # "CD75.A.extensive" → "75. A. extensive"
    # Only when the garbage is 2+ uppercase letters followed by junk
    text = re.sub(
        r'\b[A-Z]{2,}\.\w*\d*\.?\s*(\d{1,3}\.\s*)',
        r'\1',
        text
    )

    return text


def _split_glued_items(text: str) -> List[str]:
    """Split a single TextIn item that contains multiple questions glued together.

    When OCR merges adjacent lines (e.g., "C.burn the midnight oil 45.When Sarah saw..."),
    this extracts the two logical pieces so the LLM sees them as separate items.

    Returns list of text segments. If no split needed, returns [text].
    """
    parts = [text]

    # Detect "content ending + number. + new content" within a single item
    # This catches the most common case: option text + next question number + question text
    # Pattern: lowercase/non-digit + whitespace + 2-3 digit number + period + space + capital
    new_parts = []
    for part in parts:
        split_points = []
        for m in re.finditer(r'([a-z])\s+(\d{2,3}\.\s*[A-Z])', part):
            split_points.append(m.start(2))

        if split_points:
            prev = 0
            for sp in split_points:
                if sp > prev:
                    new_parts.append(part[prev:sp].strip())
                prev = sp
            if prev < len(part):
                new_parts.append(part[prev:].strip())
        else:
            new_parts.append(part)

    return [p for p in new_parts if p]


# ═══════════════════════════════════════════════════════════════════════
# Text formatting & prompt building
# ═══════════════════════════════════════════════════════════════════════

def _format_items(items: List[Dict]) -> str:
    """Format TextIn detail items into indexed text for LLM input.

    Each item gets an [idx=N] marker so the LLM can reference which items
    belong to each question. We can then recover real positions from TextIn data.

    OCR pre-cleaning is applied to each item's text before formatting.
    Heavily glued items are split into sub-items with -a/-b suffixes.
    """
    lines = []
    for idx, item in enumerate(items):
        item_type = item.get('type', 'paragraph')
        content_type = item.get('content', 0)

        # Skip headers, footers, sidebars
        if content_type == 1:
            continue

        ol = item.get('outline_level', -1)
        text = (item.get('text', '') or '').strip()

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

        # ---- Layer 2: OCR pre-cleaning ----
        text = _clean_ocr_text(text)

        # ---- Split heavily glued items ----
        sub_texts = _split_glued_items(text)
        if len(sub_texts) > 1:
            for si, sub in enumerate(sub_texts):
                sub_idx = f'{idx}{chr(97+si)}'  # idx=298a, 298b, ...
                lines.append(f'[idx={sub_idx}] {sub}')
            continue

        # Build annotation prefix
        # # = outline_level 0 (top-level Section)
        # ## = outline_level 1 (sub-section)
        # ### = outline_level 2+ (sub-sub-section)
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

【标题识别 — 必须跳过！】
⚠️ 文字中以 # / ## / ### 开头的是 Section 标题（如 "# Listening Comprehension"、"## Grammar and Vocabulary"、"### Section B"），这是试卷的大题分区标记，不是题目！即使标题行包含数字编号（如 "Section 3"），也必须跳过，不计入题号列表。

【OCR粘连处理 — 必须拆分！】
TextIn OCR 经常把相邻的选项和题号粘连在一起。遇到以下模式时必须拆分对待：

模式1 — 选项字母+题号粘连: "A43.The company..." → A是上一题的选项A，43.是新题号。拆分为两题。
模式2 — 选项内容+下一题号在同一行: "CC.burn the midnight oil 45.When Sarah..." → "burn the midnight oil"是上一题选项C，45.是新题号。拆开！
  规则：当一行中出现"字母.文字...数字."的模式时，字母部分归上一题选项，数字是新题号。
模式3 — 题号嵌在句子中间: "...translateI 46 .A Japanese..." → 句子在46前结束，46是题号。
模式4 — [idx=N] 有字母后缀(如 298a, 298b): 表示该item已被预拆分为多个部分，每个都可能是独立题目。

【提取规则】
1. 题号: 试卷上印刷的数字编号。题号可能出现在段落中间，不是每道题都独立成行。例如阅读理解 passage 后面紧跟 "46. What is the main idea..."，46 就是题目。提取时必须扫描全文每一个带数字编号的行，不要漏掉段落中嵌入的题号！
2. 🚫 铁律：题号必须与试卷上印刷的数字完全一致。绝不允许"补号"或"重新编号"。如果某题试卷上印的是52，就输出52，不能因为前面漏了一题而输出51。
3. 听力题(Section A Short Conversations): 连续4个A/B/C/D选项 = 1道听力题。questionText填"(听力题)"
4. 完形填空: 题号可能嵌入选项行如"73.A.humanity"→题号=73
5. 语法填空: 正文中含 ___(题号) 标记或 "1.A.xxx B.xxx" 格式
6. 阅读理解: passageText 提取文章全文, passageRef 指向文章编号
7. 翻译题(translation): "21．中文句子（提示词）", 全角句号, 含中文+英文提示词, options={{}}
8. 选句填空(sentence_gap): 短文4空, 表格6句(A-F)选4填入
9. 语法填空(grammar_fill): 短文含 ___() 无选项, 填单词正确形式
10. 写作(writing): 英文提示+要求, 无选项, 通常最后一页
11. 题型: listening/grammar/vocabulary/cloze/reading/sentence_gap/translation/grammar_fill/writing
12. ⚠️ 不同Section可有相同题号! 如Listening Q1≠Grammar Q1≠Cloze Q1, 全部保留不合并
13. bbox: 设为 {{"x":0,"y":0,"w":0,"h":0}}
14. 只输出题目JSON, 不要"```json", 不要解释

【自检规则 — 输出前必须执行】
✅ 检查1: 逐行扫描输出结果，确认没有任何 # / ## / ### 标题行被当成题目。
✅ 检查2: 每个 Section 内题号是否连续？如果发现 45→47 缺了46，说明有遗漏，必须回到 [idx] 列表中 45 和 47 之间的所有行重新查找，特别注意粘连行。
✅ 检查3: 每道题的 questionNumber 是否与试卷上印刷的数字完全一致？如有"补号"或偏移，立即修正。
✅ 检查4: 是否有选项字母+题号粘连的行被整行当成了一道题？若有，拆分。

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
    fixed = content.rstrip()
    fixed = re.sub(r':\s*"[^"]*$', ': ""', fixed)
    fixed = re.sub(r':\s*[\[{][^}\]]*$', ': null', fixed)
    fixed = re.sub(r',\s*$', '', fixed)
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


# ═══════════════════════════════════════════════════════════════════════
# Layer 3: 后处理校验 — Section内题号连续性检测
# ═══════════════════════════════════════════════════════════════════════

def _check_section_continuity(questions: List[Dict]) -> None:
    """Check question number continuity within each Section.

    Logs WARN if gaps are found, which may indicate:
    - OCR粘连导致 LLM 漏题
    - 标题误判为题目导致编号偏移
    """
    if len(questions) < 2:
        return

    # Group by section (use pageIndex as proxy if section field is empty)
    sections = {}
    for q in questions:
        sec_key = q.get('section', '') or f"P{q.get('pageIndex', '?')}"
        if sec_key not in sections:
            sections[sec_key] = []
        sections[sec_key].append(q['questionNumber'])

    for sec_key, nums in sections.items():
        nums = sorted(set(nums))
        if len(nums) < 2:
            continue
        gaps = []
        for i in range(1, len(nums)):
            if nums[i] - nums[i-1] > 1:
                missing = list(range(nums[i-1] + 1, nums[i]))
                gaps.append(f"{nums[i-1]}→{nums[i]} (缺: {missing})")
        if gaps:
            logger.warning(
                f"Section [{sec_key}] 题号断档: {'; '.join(gaps)} "
                f"— 可能是OCR粘连导致漏题或标题误判"
            )


def _llm_result_to_gaozhong(llm_result: Dict, image_size: Dict,
                            detail_items: List[Dict] = None,
                            all_page_items: List[List[Dict]] = None) -> Dict:
    """Convert LLM parsed result to gaozhong-compatible format.

    Uses itemIndices + pageIndex from LLM output to compute real bbox
    from TextIn position data. Falls back to all-zero bbox if no indices.

    Includes section-level continuity check (Layer 3).
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
        # Handle sub-indices like "298a" → extract base index 298
        item_indices_raw = q.get('itemIndices', [])
        item_indices = []
        for idx in item_indices_raw:
            if isinstance(idx, str):
                m = re.match(r'(\d+)', idx)
                if m:
                    item_indices.append(int(m.group(1)))
            elif isinstance(idx, (int, float)):
                item_indices.append(int(idx))

        page_idx = q.get('pageIndex', 0) - 1  # 1-based → 0-based

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
            'section': q.get('section', ''),  # Section context for disambiguation
            'passageRef': q.get('passageRef'),
            'passageText': q.get('passageText', '') or '',
        })

    # ---- Layer 3: Section continuity check ----
    _check_section_continuity(gaozhong_questions)

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

    # Format items as structured text (with OCR pre-cleaning)
    formatted = _format_items(detail_items)
    logger.info(f"LLM parser: formatted {len(formatted)} chars ({formatted.count(chr(10))+1} lines)")

    # Build and send prompt
    prompt = _build_prompt(formatted, image_size or {})
    llm_result = _call_llm(prompt)

    if not llm_result:
        return None

    # Convert to gaozhong format
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
    logger.info(f"LLM all-pages: formatted {len(full_text)} chars ({full_text.count(chr(10))+1} lines)")

    # Build prompt for full exam
    prompt = f"""你是上海高中英语教研专家。下面是 TextIn OCR 从一套完整英语试卷识别出的所有文字,按页组织。

请逐题提取这套试卷的全部题目,输出 JSON。注意题号是试卷原始编号,跨页连续。

{full_text}

【标题识别 — 必须跳过！】
⚠️ 文字中以 # / ## / ### 开头的是 Section 标题（如 "# Listening Comprehension"、"## Grammar and Vocabulary"、"### Section B"），这是试卷的大题分区标记，不是题目！即使标题行包含数字编号（如 "Section 3"），也必须跳过，不计入题号列表。

【OCR粘连处理 — 必须拆分！】
TextIn OCR 经常把相邻的选项和题号粘连在一起。遇到以下模式时必须拆分对待：

模式1 — 选项字母+题号粘连: "A43.The company..." → A是上一题的选项A，43.是新题号。拆分为两题。
模式2 — 选项内容+下一题号在同一行: "CC.burn the midnight oil 45.When Sarah..." → "burn the midnight oil"是上一题选项C，45.是新题号。拆开！
  规则：当一行中出现"字母.文字...数字."的模式时，字母部分归上一题选项，数字是新题号。
模式3 — 题号嵌在句子中间: "...translateI 46 .A Japanese..." → 句子在46前结束，46是题号。
模式4 — [idx=N] 有字母后缀(如 298a, 298b): 表示该item已被预拆分为多个部分，每个都可能是独立题目。

【提取规则】
1. 题号: 试卷上印刷的数字编号。题号可能出现在段落中间，不是每道题都独立成行。例如阅读理解 passage 后面紧跟 "46. What is the main idea..."，46 就是题目。提取时必须扫描全文每一个带数字编号的行，不要漏掉段落中嵌入的题号！
2. 🚫 铁律：题号必须与试卷上印刷的数字完全一致。绝不允许"补号"或"重新编号"。如果某题试卷上印的是52，就输出52，不能因为前面漏了一题而输出51。
3. 听力题(Section A): 连续4个A/B/C/D选项 = 1道听力题。questionText填"(听力题)", type=listening
4. 完形填空: 题号嵌入选项行如"73.A.humanity"→题号=73
5. 语法/选词填空: 正文中含 ___(题号) 或 "F52" "54E" 等嵌入格式,从词框表格中匹配选项
6. 阅读理解: passageText 提取文章全文
7. 翻译题(translation): "21．中文（提示词）" 全角句号, 含中文+英文提示词, options={{}}
8. 选句填空(sentence_gap): 短文4空, 表格6句(A-F)选4填入
9. 语法填空(grammar_fill): 短文含 ___() 无选项, 填单词正确形式
10. 写作(writing): 英文提示+要求, 无选项, 通常最后一页
11. 题型: listening/grammar/vocabulary/cloze/reading/sentence_gap/translation/grammar_fill/writing
12. ⚠️ 不同Section可有相同题号! 如Listening Q1≠Grammar Q1≠Cloze Q1, 全部保留不合并
13. 只输出JSON, 不要```json```, 不要解释

【自检规则 — 输出前必须执行】
✅ 检查1: 逐行扫描输出结果，确认没有任何 # / ## / ### 标题行被当成题目。
✅ 检查2: 每个 Section 内题号是否连续？如果发现 45→47 缺了46，说明有遗漏，必须回到 [idx] 列表中 45 和 47 之间的所有行重新查找，特别注意粘连行。
✅ 检查3: 每道题的 questionNumber 是否与试卷上印刷的数字完全一致？如有"补号"或偏移，立即修正。
✅ 检查4: 是否有选项字母+题号粘连的行被整行当成了一道题？若有，拆分。

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
