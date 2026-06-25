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
    # "A1.What does the phrase" → "A\n1. What does the phrase"
    # "D2.Which of the following" → "D\n2. Which of the following"
    # Guard: number 1-3 digits + period + uppercase letter (new sentence)
    text = re.sub(
        r'\b([A-D])(\d{1,3}\.)(\s*[A-Z])',
        r'\1\n\2\3',
        text
    )

    # ---- Pattern 2: Content+question number粘连 mid-sentence ----
    # "...translateI 46 .A Japanese" → "...translate I\n46. A Japanese"
    # "true in otherI61 .Nobel" → "true in other I\n61. Nobel"
    # "market 64 .This" → "market\n64. This"
    # Pattern: lowercase + optional uppercase + whitespace + 2-3 digit num + . + space + uppercase
    text = re.sub(
        r'([a-z])([A-Z])?\s+(\d{2,3})\s*\.\s*([A-Z])',
        r'\1\2\n\3. \4',
        text
    )

    # ---- Pattern 3: Word glued to question number (no following period) ----
    # "...a preciseK47" → "...a precise K\n47."
    text = re.sub(
        r'([a-z])([A-Z])(\d{2,3})\b(?!\.)',
        r'\1 \2\n\3.',
        text
    )

    # ---- Pattern 4: Merged/duplicated option letters ----
    # "CC.burn" → "C. burn"  (duplicated same letter)
    # "B,C.What" → "B. C. What"  (two different option letters merged with comma)
    text = re.sub(
        r'\b([A-D]),?\1\.\s*',
        r'\1. ',
        text
    )
    text = re.sub(
        r'\b([A-D]),([A-D])\.\s*',
        r'\1. \2. ',
        text
    )

    # ---- Pattern 5: Option letters (2 caps) + question number without dot ----
    # "CD75.A.extensive" → "C D\n75. A. extensive"
    # C and D are options of previous question, 75 is new question
    text = re.sub(
        r'\b([A-D])([A-D])(\d{1,3}\.)(\s*[A-Z])',
        r'\1 \2\n\3\4',
        text
    )

    # ---- Pattern 6: Garbage prefix before clean question number ----
    # "AC.WwSSdo13. 3.Why does" → "3. Why does"
    text = re.sub(
        r'\b[A-Z]{2,}\.\w*\d*\.?\s*(\d{1,3}\.\s*)',
        r'\1',
        text
    )

    # ---- Cleanup: fix double periods from Pattern 2 splits ----
    # "46. .Nobel" → "46. Nobel"
    text = re.sub(r'(\d{1,3}\.)\s*\.(\s*[A-Z])', r'\1\2', text)

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
    return f"""你是上海高中英语教研专家。TextIn OCR 识别了一张英语试卷页面。请逐题提取所有题目,输出 JSON。

【识别文字 — 按版面从上到下,每行以 [idx=N] 标记】
{formatted_text}

══════════════════════════════════════
第一部分: 必须跳过的内容
══════════════════════════════════════

❌ 标题跳过: # / ## / ### 开头的是 Section 标题,不是题目。
   例: "# Listening Comprehension"、"## Grammar"、"### Section B" → 全部跳过
❌ 说明文字跳过: "Directions:...", "Questions 11 through 13 are based on..." → 不是题目
❌ 页眉页脚跳过: 学校名称、考试名称、页码 → 不是题目

══════════════════════════════════════
第二部分: OCR粘连拆分规则
══════════════════════════════════════

TextIn OCR 常把相邻内容粘在一起。必须识别并拆分:

🔧 规则1: [选项字母]+[题号] 粘连
   输入: "A43.The company..." → A是上题选项，43是新题号
   输入: "D2.Which of..." → D是上题选项，2是新题号

🔧 规则2: [选项内容]+[下一题号] 同行
   输入: "CC.burn the midnight oil 45.When Sarah..."
   → "burn the midnight oil"归上题选项，45.是新题号

🔧 规则3: 题号嵌在句子中间
   输入: "...translateI 46 .A Japanese..." → 句在46前结束，46是题号

🔧 规则4: [idx=N] 带字母后缀(如 94a, 94b)
   → 该item已被预拆分为多部分，分别处理

══════════════════════════════════════
第三部分: 题目提取规则
══════════════════════════════════════

📌 题号规则:
- 题号 = 试卷上印刷的数字编号。扫描全文每个带数字编号的行
- 🚫 铁律: 题号必须与试卷印刷数字完全一致,禁止补号/重编号
  试卷印52就输出52, 不能因漏题输出51
- OCR常见误读: S0→80, 1→I, O→0, 5→S, 8→B
  如 "S0.A.neck and neck" → 题号=80,选项A

📌 题型规则:
- listening: 连续4个A/B/C/D选项=1道听力题, questionText="(听力题)"
- grammar/vocabulary: 4个选项(A-D), 题干+选项分离在不同行
- cloze: 题号嵌入如"73.A.humanity"→题号=73
- reading: 阅读理解, 需提取 passageText 全文
- sentence_gap: 短文4空,表格6句(A-F)选4填入
- translation: "21．中文句子(提示词)", 全角句号, options={{}}
- grammar_fill: 短文含___()无选项, 填单词正确形式
- writing: 英文提示+要求, 无选项

📌 歧义处理:
- 不同Section可有相同题号(如Listening Q1≠Grammar Q1), 全部保留
- section 字段填入所属Section名(从最近的#/##/###标题提取)
- 如无明确Section名, 用题目序号范围推断(1-10→Listening, 21-40→Grammar等)

📌 输出约束:
- 只输出JSON, 不要```json```, 不要解释
- bbox设为{{"x":0,"y":0,"w":0,"h":0}}
- itemIndices包含该题的所有[idx=N]编号(含字母后缀如94a,94b)
- pageIndex: 题目所在页码(1-6)

══════════════════════════════════════
第四部分: 自检(输出前执行)
══════════════════════════════════════
☑ 是否有#/##/###标题被误判为题目? → 删除
☑ 每个Section内题号连续吗? 45→47缺46? → 回查45和47之间的行
☑ 题号与试卷印刷数字完全一致吗? 有补号/偏移吗? → 修正
☑ 有粘连行被当成一整道题吗? (如"A43..."整行当Q43) → 拆分

══════════════════════════════════════
输出格式
══════════════════════════════════════
{{"questions":[
  {{"questionNumber":1,"pageIndex":1,"section":"Listening","questionType":"listening","questionText":"(听力题)","options":{{"A":"...","B":"...","C":"...","D":"..."}},"itemIndices":[5,6,7,8],"passageText":"","passageRef":null}},
  {{"questionNumber":43,"pageIndex":4,"section":"Grammar","questionType":"grammar","questionText":"The insurance company ___ the risk...","options":{{"A":"...","B":"...","C":"...","D":"..."}},"itemIndices":[88,89,90,91,92],"passageText":"","passageRef":null}}
]}}"""


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
    prompt = f"""你是上海高中英语教研专家。TextIn OCR 识别了一套完整英语试卷,按页组织。请逐题提取全部题目,输出 JSON。题号是试卷原始编号,跨页连续。

{full_text}

══════════════════════════════════════
第一部分: 必须跳过的内容
══════════════════════════════════════

❌ 标题跳过: # / ## / ### 开头的是 Section 标题,不是题目。
   例: "# Listening Comprehension"、"## Grammar"、"### Section B" → 跳过
❌ 说明跳过: "Directions:...", "Questions N through M are based on..." → 跳过
❌ 页眉页脚跳过: 学校名、考试名、页码 → 跳过

══════════════════════════════════════
第二部分: OCR粘连拆分规则
══════════════════════════════════════

TextIn OCR 常把相邻内容粘在一起。必须识别并拆分:

🔧 规则1: [选项字母]+[题号]粘连
   输入: "A43.The company..." → A是上题选项，43是新题号
   输入: "D2.Which of..." → D是上题选项，2是新题号

🔧 规则2: [选项内容]+[下一题号]同行
   输入: "CC.burn the midnight oil 45.When Sarah..."
   → "burn the midnight oil"归上题选项，45.是新题号

🔧 规则3: 题号嵌在句子中间
   输入: "...translateI 46 .A Japanese..." → 句在46前结束，46是题号

🔧 规则4: [idx=N]带字母后缀(如94a,94b) → 已被预拆分,分别处理

══════════════════════════════════════
第三部分: 题目提取规则
══════════════════════════════════════

📌 题号规则:
- 题号=试卷印刷数字编号,跨页连续。扫描全文每个带数字编号的行
- 🚫 铁律: 题号必须与试卷印刷数字完全一致,禁止补号/重编号
  试卷印52就输出52,不能因漏题输出51
- OCR常见误读纠正: S0→80, 1→I, O→0, 5→S, 8→B
  如 "S0.A.neck and neck" → 题号=80,选项A
- 不同页上同编号但不同Section的题全保留(如P1-Listening Q1≠P3-Grammar Q1)

📌 题型规则:
- listening: 连续4个A/B/C/D选项=1道听力题,questionText="(听力题)"
- grammar/vocabulary: 4个选项(A-D), 题干+选项可能分离在不同行
- cloze: 题号嵌入如"73.A.humanity"→题号=73
- reading: 阅读理解,提取passageText全文
- sentence_gap: 短文4空,表格6句(A-F)选4填入
- translation: "21．中文(提示词)",全角句号,options={{}}
- grammar_fill: 短文含___()无选项,填单词正确形式
- writing: 英文提示+要求,无选项

📌 歧义处理:
- section字段: 填入所属Section名(从最近的#/##/###标题提取)
- 如无标题,由题号范围推断(1-10→Listening, 11-20→Listening B, 21-40→Grammar, 41-70→Cloze/Vocab, 71+→Reading)
- itemIndices: 含该题的所有[idx=N]编号(含字母后缀如94a,94b)
- pageIndex: 题目所在页码(1起)

📌 输出约束:
- 只输出JSON,不要```json```,不要解释
- bbox设为{{"x":0,"y":0,"w":0,"h":0}}

══════════════════════════════════════
第四部分: 自检(输出前执行)
══════════════════════════════════════
☑ 是否有#/##/###标题被误判为题目? → 删除
☑ 每个Section内题号连续吗? 45→47缺46? → 回查45和47之间的行
☑ 题号与试卷印刷数字完全一致吗? 有补号/偏移吗? → 修正
☑ 有粘连行被当成一整道题吗? (如"A43..."整行当Q43) → 拆分

══════════════════════════════════════
输出格式
══════════════════════════════════════
{{"questions":[
  {{"questionNumber":1,"pageIndex":1,"section":"Listening","questionType":"listening","questionText":"(听力题)","options":{{"A":"...","B":"...","C":"...","D":"..."}},"itemIndices":[5,6,7,8],"passageText":"","passageRef":null,"bbox":{{"x":0,"y":0,"w":0,"h":0}}}},
  {{"questionNumber":43,"pageIndex":4,"section":"Grammar","questionType":"grammar","questionText":"The insurance company ___ the risk...","options":{{"A":"...","B":"...","C":"...","D":"..."}},"itemIndices":[88,89,90,91,92],"passageText":"","passageRef":null,"bbox":{{"x":0,"y":0,"w":0,"h":0}}}}
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
