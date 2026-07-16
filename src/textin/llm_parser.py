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
- ★ Section-aware processing: splits exam by Section to avoid LLM尾部退化

Architecture (v2.0):
  Layer 0: Section detection — group items by #/## boundaries
  Layer 1: OCR pre-cleaning — 6 regex patterns + _split_glued_items()
  Layer 2: Per-section LLM prompt — focused, 10-30 questions each
  Layer 3: Post-processing — continuity check + merge
  Fallback: Full-paper processing if section-based fails

Usage:
    from src.textin.llm_parser import parse_with_llm, parse_by_sections
    result = parse_by_sections(all_page_items)  # recommended for full exams
"""

import json
import os
import re
import logging
from typing import List, Dict, Optional, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed

logger = logging.getLogger(__name__)

# DeepSeek API config
DEEPSEEK_API_KEY = os.environ.get('DEEPSEEK_API_KEY', '')
DEEPSEEK_API_URL = os.environ.get('DEEPSEEK_API_URL',
    'https://api.deepseek.com/v1/chat/completions')
LLM_MODEL = os.environ.get('MODEL_PARSER', 'deepseek-v4-pro')
LLM_TIMEOUT = int(os.environ.get('LLM_PARSE_TIMEOUT', '90'))
SECTION_CONCURRENCY = int(os.environ.get('SECTION_CONCURRENCY', '4'))


# ═══════════════════════════════════════════════════════════════════════
# Layer 0: Section-aware splitting
# ═══════════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════════
# Section boundary detection — pure regex, no outline_level dependency
# ═══════════════════════════════════════════════════════════════════════

# English exam section header patterns (ordered by priority)
_RE_ROMAN_SECTION = re.compile(
    r'^[IVX]+\.\s*[A-Z][a-z]')  # I. Listening, II. Grammar, III. Reading
_RE_PART_MARKER = re.compile(
    r'^\*?Part\s+[IVX\d]')      # Part I, *Part II
_RE_SECTION_LABEL = re.compile(
    r'^Section\s+[A-D]\b')      # Section A, Section B
_RE_DIRECTIONS = re.compile(
    r'^(Directions?|Questions\s+\d+)')  # Directions:..., Questions 11 through...
_RE_PASSAGE_LABEL = re.compile(
    r'^\([A-F]\)$')             # (A), (B) — bare passage markers
_RE_EXAM_TITLE = re.compile(
    r'学期|期中|期末|考试|试卷|学年')  # Chinese exam title markers


def _is_section_header(text: str) -> bool:
    """Check if a text line is a section header (not regular content)."""
    t = text.strip()
    if not t or len(t) > 100:
        return False
    # Must match a known header pattern
    return bool(_RE_ROMAN_SECTION.match(t) or
                _RE_PART_MARKER.match(t) or
                _RE_SECTION_LABEL.match(t))


def _is_major_boundary(text: str, prev_boundary_page: int, current_page: int) -> bool:
    """Determine if a section header should trigger a Section split.

    Rules:
    1. Roman numeral (I./II./III.) → ALWAYS splits (strongest signal)
    2. Part marker → ALWAYS splits
    3. Section label (Section A/B/C) → splits only if on a different page
       from the previous boundary (handles missing Roman numeral headers)
    4. Directions / passage labels → NEVER split
    """
    t = text.strip()

    # Directions and question group headers are never boundaries
    if _RE_DIRECTIONS.match(t):
        return False

    # Bare passage labels like (A), (B) are never boundaries
    if _RE_PASSAGE_LABEL.match(t) and len(t) < 10:
        return False

    # Exam title (contains Chinese) — not a question section
    if _RE_EXAM_TITLE.search(t):
        return False

    # Roman numeral sections: I. II. III. IV. — always a major boundary
    if _RE_ROMAN_SECTION.match(t):
        return True

    # Part markers: Part I, Part II — always a major boundary
    if _RE_PART_MARKER.match(t):
        return True

    # Section labels: split only if on a different page (handles missing Roman numeral)
    if _RE_SECTION_LABEL.match(t):
        if current_page != prev_boundary_page:
            return True

    return False


def _detect_sections(all_page_items: List[List[Dict]]) -> List[Dict]:
    """Split all pages' items into logical sections using pure regex.

    NO dependency on TextIn outline_level — uses text pattern matching only.
    This is more robust because outline_level is inconsistent across pages
    (same 'Section B' can be ol=0, ol=1, or ol=2 depending on TextIn's layout analysis).

    Split strategy:
    - I./II./III. Roman numeral → always new section
    - Part I/II → always new section
    - Section A/B/C on new page → new section (catches missed Roman numerals)
    - Section A/B/C on same page → sub-section context, stays in current section

    Post-processing:
    - Merge tiny sections (< MIN_ITEMS) forward into next section
    - Split oversized sections (> MAX_ITEMS) at sub-section markers
    """
    MIN_ITEMS = 3   # merge sections smaller than this (v4.8: 8→3, 防止小section被吞并)
    MAX_ITEMS = 150 # split sections larger than this

    raw_sections = []
    current_section = {'name': '', 'page_items': [], 'start_page': 0}
    last_boundary_page = -1

    for pi, items in enumerate(all_page_items):
        for item in items:
            text = item.get('text', '').strip()
            content_type = item.get('content', 0)

            if content_type == 1:
                continue

            # Check if this item is a section boundary
            if _is_section_header(text) and _is_major_boundary(text, last_boundary_page, pi):
                if current_section['page_items']:
                    raw_sections.append(current_section)
                # Extract clean section name
                name = text.strip().lstrip('*').strip()
                if len(name) > 80:
                    name = name[:80]
                current_section = {
                    'name': name,
                    'page_items': [],
                    'start_page': pi
                }
                last_boundary_page = pi
                continue

            # Regular item: add to current section
            current_section['page_items'].append((pi, item))

    if current_section['page_items']:
        raw_sections.append(current_section)

    # ---- Post-processing ----

    # 1. Merge tiny sections forward into next section
    merged = []
    i = 0
    while i < len(raw_sections):
        s = raw_sections[i]
        if len(s['page_items']) < MIN_ITEMS and i + 1 < len(raw_sections):
            next_s = raw_sections[i + 1]
            next_s['page_items'] = s['page_items'] + next_s['page_items']
            next_s['start_page'] = min(s['start_page'], next_s['start_page'])
            # Keep the more descriptive name
            if len(s['name']) > len(next_s['name']):
                next_s['name'] = s['name']
            i += 1
            continue
        merged.append(s)
        i += 1

    # 2. Filter out sections that are still too small
    merged = [s for s in merged if len(s['page_items']) >= 2]

    # 3. Split oversized sections at sub-section markers (Section A/B/C within same page group)
    result = []
    for s in merged:
        if len(s['page_items']) <= MAX_ITEMS:
            result.append(s)
            continue

        # Try to split at Section A/B/C markers
        sub_sections = []
        current_sub = {'name': s['name'], 'page_items': [], 'start_page': s['start_page']}
        for pi, item in s['page_items']:
            text = item.get('text', '').strip()
            if _RE_SECTION_LABEL.match(text) and len(current_sub['page_items']) >= MIN_ITEMS:
                sub_sections.append(current_sub)
                current_sub = {
                    'name': f"{s['name']} - {text.strip()}",
                    'page_items': [],
                    'start_page': pi
                }
                continue
            current_sub['page_items'].append((pi, item))

        if current_sub['page_items']:
            sub_sections.append(current_sub)

        if len(sub_sections) > 1:
            result.extend(sub_sections)
        else:
            result.append(s)

    return result


# ═══════════════════════════════════════════════════════════════════════
# Layer 1: OCR text pre-cleaning
# ═══════════════════════════════════════════════════════════════════════

def _clean_ocr_text(text: str) -> str:
    """Pre-clean TextIn OCR粘连 artifacts before sending to LLM."""
    if not text:
        return text

    # Pattern 1: Option letter (A-D) glued to next question number
    text = re.sub(r'\b([A-D])(\d{1,3}\.)(\s*[A-Z])', r'\1\n\2\3', text)

    # Pattern 2: Content+question number粘连 mid-sentence
    text = re.sub(r'([a-z])([A-Z])?\s+(\d{2,3})\s*\.\s*([A-Z])', r'\1\2\n\3. \4', text)

    # Pattern 3: Word glued to question number (no following period)
    text = re.sub(r'([a-z])([A-Z])(\d{2,3})\b(?!\.)', r'\1 \2\n\3.', text)

    # Pattern 4: Merged/duplicated option letters
    text = re.sub(r'\b([A-D]),?\1\.\s*', r'\1. ', text)
    text = re.sub(r'\b([A-D]),([A-D])\.\s*', r'\1. \2. ', text)

    # Pattern 5: Option letters (2 caps) + question number without dot
    text = re.sub(r'\b([A-D])([A-D])(\d{1,3}\.)(\s*[A-Z])', r'\1 \2\n\3\4', text)

    # Pattern 6: Garbage prefix before clean question number
    text = re.sub(r'\b[A-Z]{2,}\.\w*\d*\.?\s*(\d{1,3}\.\s*)', r'\1', text)

    # Cleanup: fix double periods
    text = re.sub(r'(\d{1,3}\.)\s*\.(\s*[A-Z])', r'\1\2', text)

    return text


def _split_glued_items(text: str) -> List[str]:
    """Split a single TextIn item that contains multiple questions glued together."""
    parts = [text]
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
# Item formatting
# ═══════════════════════════════════════════════════════════════════════

def _format_section_items(page_items: List[Tuple[int, Dict]]) -> str:
    """Format items for a single section, with local [idx=N] numbering.

    Args:
        page_items: List of (page_index, item_dict) tuples

    Returns:
        Formatted text with [idx=N] markers, section headers preserved,
        and explicit ═══ 第 N 页 ═══ page boundary markers.
    """
    lines = []
    last_page = None
    for local_idx, (pi, item) in enumerate(page_items):
        # v4.8: Insert page boundary marker when crossing pages
        if last_page is not None and pi != last_page:
            lines.append(f'')
            lines.append(f'══════ 第 {pi+1} 页 ══════')
            lines.append(f'')
        last_page = pi

        item_type = item.get('type', 'paragraph')
        content_type = item.get('content', 0)

        if content_type == 1:
            continue

        ol = item.get('outline_level', -1)
        text = (item.get('text', '') or '').strip()

        # Handle tables
        if item_type == 'table':
            cells = item.get('cells', [])
            if cells:
                table_lines = [f'[idx={local_idx}] [表格开始]']
                rows = {}
                for cell in cells:
                    r = cell.get('row', 0)
                    if r not in rows:
                        rows[r] = []
                    rows[r].append(cell.get('text', '').strip())
                for r in sorted(rows.keys()):
                    table_lines.append(f'[idx={local_idx}] | ' + ' | '.join(rows[r]))
                table_lines.append(f'[idx={local_idx}] [表格结束]')
                lines.append('\n'.join(table_lines))
            continue

        # Handle images
        if item_type == 'image':
            lines.append(f'[idx={local_idx}] [图片]')
            continue

        if not text:
            continue

        # OCR pre-cleaning
        text = _clean_ocr_text(text)

        # Split heavily glued items
        sub_texts = _split_glued_items(text)
        if len(sub_texts) > 1:
            for si, sub in enumerate(sub_texts):
                sub_idx = f'{local_idx}{chr(97+si)}'
                lines.append(f'[idx={sub_idx}] {sub}')
            continue

        # Preserve outline_level markers for section context
        prefix = ''
        if ol == 0:
            prefix = '# '
        elif ol == 1:
            prefix = '## '
        elif ol >= 2:
            prefix = '### '

        lines.append(f'[idx={local_idx}] {prefix}{text}')

    return '\n'.join(lines)


def _format_items(items: List[Dict]) -> str:
    """Format TextIn detail items (single page, legacy API)."""
    page_items = [(0, item) for item in items]
    return _format_section_items(page_items)


# ═══════════════════════════════════════════════════════════════════════
# Prompt builders
# ═══════════════════════════════════════════════════════════════════════

SECTION_PROMPT_RULES = """══════════════════════════════════════
提取规则
══════════════════════════════════════

❌ 跳过: #/##/### 开头的标题、"Directions:..."说明、页眉页脚

🔧 OCR粘连拆分:
  规则1: "A43.The..." → A是上题选项，43是新题号
  规则2: "CC.burn... 45.When..." → burn归上题选项，45是新题号
  规则3: "...translateI 46 .A..." → 句在46前结束，46是题号
  规则4: [idx=N]带字母后缀(94a,94b) → 已被预拆分，分别处理

📌 核心规则:
  - 题号=试卷印刷数字，🚫禁止补号/重编号
  - OCR误读纠正: S0→80, 1→I, O→0, 5→S, 8→B
  - 题型: listening/grammar/vocabulary/cloze/reading/sentence_gap/translation/grammar_fill/writing
  - 听力: 连续4个A/B/C/D选项=1道题，questionText="(听力题)"
  - 完形: "73.A.humanity"→题号=73

📌 输出: 只输出JSON，不要```json```，不要解释
📌 bbox: 全部设为{"x":0,"y":0,"w":0,"h":0}

☑ 自检: 题号连续? 有粘连行误判? 标题被当题目?"""


def _build_section_prompt(section: Dict, page_offset: int = 1) -> str:
    """Build a focused prompt for a single section.

    The prompt is much shorter than full-paper because:
    - Only 10-30 questions per section → <3K JSON output → no尾部退化
    - Section context is explicit → LLM knows what type of questions to expect
    """
    formatted = _format_section_items(section['page_items'])
    section_name = section['name']
    start_page = section['start_page'] + page_offset
    # v4.8: compute end page for multi-page section awareness
    end_page = max(pi for pi, _ in section['page_items']) + page_offset
    page_hint = f"第{start_page}页" if start_page == end_page else f"第{start_page}-{end_page}页"

    return f"""你是上海高中英语教研专家。下面是试卷中"{section_name}"部分{page_hint}的OCR识别文字。

请提取这部分的所有题目,输出JSON。题号使用试卷原始编号。
⚠️ 如果出现了 ══════ 第 N 页 ══════ 分隔线，说明内容跨页，题号应跨页连续，不要重新编号。

【Section: {section_name} | 页码: {page_hint}】

{formatted}

{SECTION_PROMPT_RULES}

【输出格式】
{{"section":"{section_name}","questions":[
  {{"questionNumber":1,"pageIndex":{start_page},"questionType":"listening","questionText":"(听力题)","options":{{"A":"...","B":"...","C":"...","D":"..."}},"itemIndices":[5,6,7,8],"passageText":"","passageRef":null}}
]}}"""


def _build_prompt(formatted_text: str, image_size: Dict) -> str:
    """Build LLM prompt for single-page extraction (legacy)."""
    return f"""你是上海高中英语教研专家。下面是试卷一个页面的OCR识别文字。请提取所有题目,输出JSON。

{formatted_text}

{SECTION_PROMPT_RULES}

【输出格式】
{{"questions":[
  {{"questionNumber":1,"pageIndex":1,"section":"Section","questionType":"listening","questionText":"(听力题)","options":{{"A":"...","B":"...","C":"...","D":"..."}},"itemIndices":[5,6,7,8],"passageText":"","passageRef":null}}
]}}"""


# ═══════════════════════════════════════════════════════════════════════
# LLM calling
# ═══════════════════════════════════════════════════════════════════════

def _call_llm(prompt: str, max_tokens: int = 32768) -> Optional[Dict]:
    """Call DeepSeek LLM API."""
    import urllib.request
    import urllib.error

    if not DEEPSEEK_API_KEY:
        logger.warning("DEEPSEEK_API_KEY not set, LLM parser unavailable")
        return None

    body = json.dumps({
        'model': LLM_MODEL,
        'messages': [{'role': 'user', 'content': prompt}],
        'temperature': 0.05,
        'max_tokens': max_tokens,
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
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass

    for pattern in [r'```json\s*([\s\S]*?)```', r'```\s*([\s\S]*?)```', r'\{[\s\S]*"questions"[\s\S]*\}']:
        m = re.search(pattern, content)
        if m:
            try:
                return json.loads(m.group(1) if m.lastindex else m.group(0))
            except json.JSONDecodeError:
                continue

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
# Post-processing
# ═══════════════════════════════════════════════════════════════════════

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


def _check_section_continuity(questions: List[Dict]) -> None:
    """Check question number continuity within each Section."""
    if len(questions) < 2:
        return

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


def _parse_section_indices(item_indices_raw: List) -> List[int]:
    """Parse item indices from LLM output, handling string sub-indices like '94a'."""
    result = []
    for idx in item_indices_raw:
        if isinstance(idx, str):
            m = re.match(r'(\d+)', idx)
            if m:
                result.append(int(m.group(1)))
        elif isinstance(idx, (int, float)):
            result.append(int(idx))
    return result


def _llm_result_to_gaozhong(llm_result: Dict, image_size: Dict,
                            detail_items: List[Dict] = None,
                            all_page_items: List[List[Dict]] = None) -> Dict:
    """Convert LLM parsed result to gaozhong-compatible format."""
    questions = llm_result.get('questions', [])
    gaozhong_questions = []

    for q in questions:
        qn = q.get('questionNumber', 0)
        if not qn or qn < 1:
            continue

        options = q.get('options', {})
        if isinstance(options, list):
            options = {chr(65+i): v for i, v in enumerate(options)}

        item_indices = _parse_section_indices(q.get('itemIndices', []))
        page_idx = q.get('pageIndex', 0) - 1

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
            'section': q.get('section', ''),
            'passageRef': q.get('passageRef'),
            'passageText': q.get('passageText', '') or '',
        })

    _check_section_continuity(gaozhong_questions)
    gaozhong_questions.sort(key=lambda q: q['questionNumber'])

    return {
        'questions': gaozhong_questions,
        'passages': llm_result.get('passages', []),
        'engine': f'textin-pdf_to_markdown-llm-{LLM_MODEL}',
        'image_size': image_size or {},
        'raw_count': len(gaozhong_questions),
    }


# ═══════════════════════════════════════════════════════════════════════
# Main entry points
# ═══════════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════════
# v2.5: Page-based batch processing (replaces section-based)
# ═══════════════════════════════════════════════════════════════════════

BATCH_PAGES = int(os.environ.get('BATCH_PAGES', '3'))


def _process_one_batch(batch_start_page: int,
                       batch_page_items: List[List[Dict]],
                       image_size: Dict) -> Optional[Dict]:
    """Process a batch of consecutive pages through LLM."""
    item_count = sum(len(items) for items in batch_page_items)

    if item_count < 2:
        logger.info(f"Batch P{batch_start_page+1}: too few items ({item_count}), skipping")
        return None

    batch_end_page = batch_start_page + len(batch_page_items) - 1
    logger.info(f"Batch P{batch_start_page+1}-P{batch_end_page+1}: "
                f"{item_count} items, {len(batch_page_items)} pages")

    # Flatten batch items with global page indices
    flat_items: List[Tuple[int, Dict]] = []
    for pi_offset, items in enumerate(batch_page_items):
        page_idx = batch_start_page + pi_offset
        for item in items:
            flat_items.append((page_idx, item))

    formatted = _format_section_items(flat_items)
    prompt = _build_batch_prompt(batch_start_page, batch_page_items, formatted)

    max_tok = int(os.environ.get('LLM_PARSE_TOKENS_BATCH', '24576'))
    llm_result = _call_llm(prompt, max_tokens=max_tok)

    if not llm_result:
        logger.warning(f"Batch P{batch_start_page+1}: LLM call failed")
        return None

    # Use flat items as reference for bbox (indices in LLM output are local)
    flat_items_only = [item for _, item in flat_items]
    result = _llm_result_to_gaozhong(llm_result, image_size,
                                      detail_items=flat_items_only)

    if not result or not result.get('questions'):
        return None

    # Fix pageIndex using actual item locations
    for q in result['questions']:
        item_indices = q.get('itemIndices', [])
        if item_indices:
            pages = set()
            for idx in item_indices:
                if 0 <= idx < len(flat_items):
                    pi, _ = flat_items[idx]
                    pages.add(pi + 1)
            if pages:
                q['pageIndex'] = min(pages)

        # Clamp: ensure pageIndex is within batch range
        pi = q.get('pageIndex', batch_start_page + 1)
        if pi < batch_start_page + 1 or pi > batch_end_page + 1:
            q['pageIndex'] = batch_start_page + 1

    logger.info(f"  ✓ Batch P{batch_start_page+1}-P{batch_end_page+1}: "
                f"{len(result['questions'])} questions")
    return result


def _build_batch_prompt(batch_start_page: int,
                        batch_page_items: List[List[Dict]],
                        formatted: str) -> str:
    """Build LLM prompt for a page-based batch."""
    batch_end_page = batch_start_page + len(batch_page_items) - 1
    npages = len(batch_page_items)
    if npages == 1:
        page_hint = f"第{batch_start_page+1}页"
    else:
        page_hint = f"第{batch_start_page+1}-{batch_end_page+1}页"

    return f"""你是上海高中英语教研专家。下面是试卷{page_hint}的OCR识别文字。

请提取这部分的所有题目,输出JSON。题号使用试卷原始编号。
⚠️ ══════ 第 N 页 ══════ 分隔线表示跨页，题号应跨页连续，不要重新编号。

【页码: {page_hint}】

{formatted}

{SECTION_PROMPT_RULES}

【输出格式】
{{"questions":[
  {{"questionNumber":1,"pageIndex":{batch_start_page+1},"section":"","questionType":"choice","questionText":"...","options":{{"A":"...","B":"...","C":"...","D":"..."}},"itemIndices":[5,6,7,8],"passageText":"","passageRef":null}}
]}}"""


def parse_by_batches(all_detail_items: List[List[Dict]],
                     image_size: Optional[Dict] = None,
                     subject: str = "英语") -> Optional[Dict]:
    """★ Page-based batch parsing (v2.5, replaces section-based).

    Splits all pages into fixed-size batches (BATCH_PAGES pages each),
    processes each batch independently through LLM, then merges.

    Advantages over section-based (v2.0):
    1. No dependency on TextIn outline_level accuracy
    2. Predictable batch sizes → consistent LLM performance
    3. Simple page boundaries → no mis-detected sections
    4. Fewer LLM calls: typically 2-3 batches vs 6-8 sections
    """
    if not DEEPSEEK_API_KEY:
        return None

    total_items = sum(len(items) for items in all_detail_items)
    total_pages = len(all_detail_items)
    logger.info(f"Batch-based: {total_pages} pages, {total_items} total items")

    # Split pages into batches
    batches: List[Tuple[int, List[List[Dict]]]] = []
    for start_page in range(0, total_pages, BATCH_PAGES):
        batch_pages = all_detail_items[start_page:start_page + BATCH_PAGES]
        batches.append((start_page, batch_pages))

    logger.info(f"Split into {len(batches)} batches (≤{BATCH_PAGES} pages each)")

    img_size = image_size or {}
    all_questions = []
    failed = []

    with ThreadPoolExecutor(max_workers=SECTION_CONCURRENCY) as executor:
        futures = {
            executor.submit(_process_one_batch, start, pages, img_size): (start, pages)
            for start, pages in batches
        }

        for future in as_completed(futures):
            start, pages = futures[future]
            try:
                result = future.result(timeout=LLM_TIMEOUT + 30)
                if result and result.get('questions'):
                    all_questions.extend(result['questions'])
                else:
                    failed.append((start, pages))
                    batch_end = start + len(pages) - 1
                    logger.warning(f"  ✗ Batch P{start+1}-P{batch_end+1}: no questions")
            except Exception as e:
                failed.append((start, pages))
                logger.error(f"  ✗ Batch P{start+1}: exception: {e}")

    # Retry failed batches once
    if failed:
        logger.info(f"Retrying {len(failed)} failed batches...")
        for start, pages in failed:
            try:
                result = _process_one_batch(start, pages, img_size)
                if result and result.get('questions'):
                    all_questions.extend(result['questions'])
                else:
                    logger.warning(f"  ✗ retry Batch P{start+1} still failed, skipping")
            except Exception as e:
                logger.error(f"  ✗ retry Batch P{start+1}: exception: {e}")

    if not all_questions:
        logger.error("All batches failed, falling back to full-paper processing")
        return parse_all_pages_llm(all_detail_items, image_size, subject)

    # Merge: sort by pageIndex then questionNumber, deduplicate by qNumber
    all_questions.sort(key=lambda q: (q.get('pageIndex', 0), q['questionNumber']))
    _check_section_continuity(all_questions)

    seen = set()
    deduped = []
    for q in all_questions:
        key = q['questionNumber']
        if key not in seen:
            seen.add(key)
            deduped.append(q)
        else:
            logger.warning(f"Duplicate Q{q['questionNumber']} dropped")

    logger.info(f"Batch-based total: {len(deduped)} questions from {len(batches)} batches "
                f"({len(failed)} batches failed/skipped)")

    return {
        'questions': deduped,
        'passages': [],
        'engine': f'textin-batch-llm-{LLM_MODEL}',
        'image_size': img_size,
        'raw_count': len(deduped),
    }


# Legacy alias: parse_by_sections delegates to batch-based processing
def parse_by_sections(all_detail_items: List[List[Dict]],
                      image_size: Optional[Dict] = None,
                      subject: str = "英语") -> Optional[Dict]:
    """Legacy entry point — delegates to page-based batch processing."""
    return parse_by_batches(all_detail_items, image_size, subject)


def parse_all_pages_llm(all_detail_items: List[List[Dict]],
                        image_size: Optional[Dict] = None,
                        subject: str = "英语") -> Optional[Dict]:
    """Parse ALL pages at once (legacy full-paper approach, kept as fallback)."""
    if not DEEPSEEK_API_KEY:
        return None

    total_items = sum(len(items) for items in all_detail_items)
    logger.info(f"LLM all-pages (legacy): {len(all_detail_items)} pages, {total_items} total items")

    all_formatted = []
    for pi, items in enumerate(all_detail_items):
        page_text = _format_items(items)
        all_formatted.append(f"══════ 第 {pi+1} 页 ══════\n{page_text}")

    full_text = '\n\n'.join(all_formatted)
    logger.info(f"LLM all-pages: formatted {len(full_text)} chars")

    prompt = f"""你是上海高中英语教研专家。TextIn OCR 识别了一套完整英语试卷,按页组织。请逐题提取全部题目,输出 JSON。题号是试卷原始编号,跨页连续。

{full_text}

{SECTION_PROMPT_RULES}

【输出格式】
{{"questions":[
  {{"questionNumber":1,"pageIndex":1,"section":"Listening","questionType":"listening","questionText":"(听力题)","options":{{"A":"...","B":"...","C":"...","D":"..."}},"itemIndices":[5,6,7,8],"passageText":"","passageRef":null,"bbox":{{"x":0,"y":0,"w":0,"h":0}}}}
]}}"""

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


def parse_with_llm(detail_items: List[Dict],
                   image_size: Optional[Dict] = None,
                   subject: str = "英语") -> Optional[Dict]:
    """Parse single page of TextIn detail items using LLM (legacy)."""
    if not detail_items:
        return None
    if not DEEPSEEK_API_KEY:
        logger.info("DEEPSEEK_API_KEY not set, skipping LLM parser")
        return None

    logger.info(f"LLM parser: {len(detail_items)} detail items, subject={subject}")
    formatted = _format_items(detail_items)
    prompt = _build_prompt(formatted, image_size or {})
    llm_result = _call_llm(prompt)

    if not llm_result:
        return None

    result = _llm_result_to_gaozhong(llm_result, image_size or {}, detail_items)
    logger.info(f"LLM parser: extracted {result['raw_count']} questions")
    return result


def parse_with_llm_fallback(detail_items: List[Dict],
                            image_size: Optional[Dict] = None,
                            subject: str = "英语") -> Dict:
    """Try LLM parser first, fall back to regex parser if LLM fails."""
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

    from src.textin.parser import parse_xparse_result
    result = parse_xparse_result(detail_items, image_size, subject)
    print(f"TextIn Parser: regex extracted {result.get('raw_count', len(result.get('questions',[])))} questions", flush=True)
    return result
