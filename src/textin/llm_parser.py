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

def _extract_section_name(text: str) -> str:
    """Extract a human-readable section name from a header line."""
    # Remove #/##/### prefixes and [idx=N] markers
    cleaned = re.sub(r'^\[idx=\d+\]\s*#+\s*', '', text).strip()
    # Clean up common OCR artifacts in headers
    cleaned = re.sub(r'\*+', '', cleaned).strip()
    # Truncate to reasonable length
    if len(cleaned) > 80:
        cleaned = cleaned[:80]
    return cleaned


def _is_major_section_name(name: str) -> bool:
    """Check if a section name indicates a major exam section (deserves its own LLM call).

    Must be a meaningful content area, not just a bare 'Section A' label.
    """
    # Bare section labels are too generic — skip them
    bare_labels = {'section a', 'section b', 'section c', 'section d',
                   'part i', 'part ii', 'part iii', 'part iv'}
    name_lower = name.lower().strip()
    if name_lower in bare_labels:
        return False

    major_keywords = [
        'listening', 'grammar', 'vocabulary', 'cloze', 'reading',
        'translation', 'writing', 'comprehension',
    ]
    return any(kw in name_lower for kw in major_keywords)


def _detect_sections(all_page_items: List[List[Dict]]) -> List[Dict]:
    """Split all pages' items into logical sections based on outline_level.

    Section boundaries: # (ol=0) always splits. ## (ol=1) splits only
    if the name suggests a major section change.

    Post-processing: merge tiny sections (< MIN_ITEMS items) into neighbors.

    Returns sections with:
    - name: Human-readable section name
    - page_items: List of (page_index, item_dict) tuples
    - start_page: First page this section appears on
    """
    MIN_ITEMS = 8  # sections smaller than this get merged

    raw_sections = []
    current_section = {'name': 'Preamble', 'page_items': [], 'start_page': 0}

    for pi, items in enumerate(all_page_items):
        for item in items:
            ol = item.get('outline_level', -1)
            text = item.get('text', '').strip()
            content_type = item.get('content', 0)

            if content_type == 1:
                continue

            # Section boundary detection
            is_boundary = False
            if ol == 0:
                # # (ol=0) = always a major boundary
                is_boundary = True
            elif ol >= 1:
                # ## (ol=1) or ### (ol>=2) = boundary if it's a named major section
                section_name = _extract_section_name(text)
                if section_name and _is_major_section_name(section_name):
                    is_boundary = True
                # Skip "Directions:..." and "Questions N through M" — they're instructions
                if text.lower().startswith('direction') or 'questions' in text.lower():
                    is_boundary = False

            if is_boundary:
                section_name = _extract_section_name(text)
                if section_name:
                    if current_section['page_items']:
                        raw_sections.append(current_section)
                    current_section = {
                        'name': section_name,
                        'page_items': [],
                        'start_page': pi
                    }
                    continue

            current_section['page_items'].append((pi, item))

    if current_section['page_items']:
        raw_sections.append(current_section)

    # Merge tiny sections: forward-merge into next section if too small
    merged = []
    i = 0
    while i < len(raw_sections):
        s = raw_sections[i]
        # If this section is tiny and there's a next section, merge forward
        if len(s['page_items']) < MIN_ITEMS and i + 1 < len(raw_sections):
            next_s = raw_sections[i + 1]
            # Prepend our items to next section, keep next section's name/start_page
            next_s['page_items'] = s['page_items'] + next_s['page_items']
            next_s['start_page'] = min(s['start_page'], next_s['start_page'])
            # Use the more descriptive name
            if len(s['name']) > len(next_s['name']) and _is_major_section_name(s['name']):
                next_s['name'] = s['name']
            i += 1
            continue
        merged.append(s)
        i += 1

    # Filter out sections still too small after merge
    merged = [s for s in merged if len(s['page_items']) >= 2]

    return merged


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
        Formatted text with [idx=N] markers, section headers preserved
    """
    lines = []
    for local_idx, (pi, item) in enumerate(page_items):
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

    return f"""你是上海高中英语教研专家。下面是试卷中"{section_name}"部分的OCR识别文字。

请提取这部分的所有题目,输出JSON。题号使用试卷原始编号。

【Section: {section_name} | 起始页: {start_page}】

{formatted}

{SECTION_PROMPT_RULES}

【输出格式】
{{"section":"{section_name}","questions":[
  {{"questionNumber":1,"pageIndex":{start_page},"questionType":"listening","questionText":"(听力题)","options":{{"A":"...","B":"...","C":"...","D":"..."}},"itemIndices":[5,6,7,8],"passageText":"","passageRef":null}}
]}}"""


def _build_prompt(formatted_text: str, image_size: Dict) -> str:
    """Build LLM prompt for single-page extraction (legacy)."""
    return f"""你是上海高中英语教研专家。下面是试卷一个页面的OCR识别文字。请提取所有题目,输出JSON。

{formatted}

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

def _process_one_section(section: Dict, all_page_items: List[List[Dict]],
                         image_size: Dict) -> Optional[Dict]:
    """Process a single section through LLM. Returns gaozhong-format result or None."""
    section_name = section['name']
    item_count = len(section['page_items'])

    # Skip tiny sections (just a header with no real items)
    if item_count < 2:
        logger.info(f"Section [{section_name}]: too few items ({item_count}), skipping")
        return None

    logger.info(f"Section [{section_name}]: {item_count} items, page {section['start_page']+1}")

    prompt = _build_section_prompt(section)
    prompt_len = len(prompt)

    # Use smaller max_tokens per section (每section最多32题,每题~200 tokens)
    llm_result = _call_llm(prompt, max_tokens=16384)

    if not llm_result:
        logger.warning(f"Section [{section_name}]: LLM call failed")
        return None

    # Use the section's items as the reference for bbox computation
    section_items_only = [item for _, item in section['page_items']]
    result = _llm_result_to_gaozhong(llm_result, image_size,
                                      detail_items=section_items_only)

    # Inject the correct page offset for this section
    section_page_offset = section['start_page']
    for q in result['questions']:
        # The LLM might output pageIndex relative to section start
        # Adjust to absolute page index
        llm_page = q.get('pageIndex', section_page_offset + 1)
        if llm_page < section_page_offset + 1:
            q['pageIndex'] = section_page_offset + 1

    q_count = result['raw_count']
    logger.info(f"Section [{section_name}]: extracted {q_count} questions")
    return result


def parse_by_sections(all_detail_items: List[List[Dict]],
                      image_size: Optional[Dict] = None,
                      subject: str = "英语") -> Optional[Dict]:
    """★ Recommended for full exams: split by Section, process each independently.

    This solves two key problems with full-paper LLM processing:
    1. 尾部退化: 120+ questions in one JSON → attention decay → copy-paste errors
       → Per-section: 10-30 questions each → short JSON → no decay
    2. OCR粘连累积: poor OCR in later sections bleeds into earlier ones
       → Isolated per section → errors don't propagate

    Sections are processed in parallel (up to SECTION_CONCURRENCY at a time).
    Failed sections are retried once, then skipped (not blocking).

    Returns gaozhong-compatible dict, or None if all sections fail.
    """
    if not DEEPSEEK_API_KEY:
        return None

    total_items = sum(len(items) for items in all_detail_items)
    logger.info(f"Section-based parsing: {len(all_detail_items)} pages, {total_items} total items")

    # Step 1: Detect sections
    sections = _detect_sections(all_detail_items)
    logger.info(f"Detected {len(sections)} sections: {[s['name'][:40] for s in sections]}")

    if len(sections) <= 1:
        # Only one section (or none) — fall back to full-paper processing
        logger.info("Only 1 section detected, falling back to full-paper processing")
        return parse_all_pages_llm(all_detail_items, image_size, subject)

    # Step 2: Process sections in parallel
    all_questions = []
    img_size = image_size or {}
    failed_sections = []

    with ThreadPoolExecutor(max_workers=SECTION_CONCURRENCY) as executor:
        futures = {
            executor.submit(_process_one_section, section, all_detail_items, img_size): section
            for section in sections
        }

        for future in as_completed(futures):
            section = futures[future]
            try:
                result = future.result(timeout=LLM_TIMEOUT + 30)
                if result and result.get('questions'):
                    all_questions.extend(result['questions'])
                    logger.info(f"  ✓ [{section['name'][:30]}] {result['raw_count']} questions")
                else:
                    failed_sections.append(section)
                    logger.warning(f"  ✗ [{section['name'][:30]}] no questions extracted")
            except Exception as e:
                failed_sections.append(section)
                logger.error(f"  ✗ [{section['name'][:30]}] exception: {e}")

    # Step 3: Retry failed sections once
    if failed_sections:
        logger.info(f"Retrying {len(failed_sections)} failed sections...")
        for section in failed_sections:
            try:
                result = _process_one_section(section, all_detail_items, img_size)
                if result and result.get('questions'):
                    all_questions.extend(result['questions'])
                    logger.info(f"  ✓ retry [{section['name'][:30]}] {result['raw_count']} questions")
                else:
                    logger.warning(f"  ✗ retry [{section['name'][:30]}] still failed, skipping")
            except Exception as e:
                logger.error(f"  ✗ retry [{section['name'][:30]}] exception: {e}")

    if not all_questions:
        logger.error("All sections failed, falling back to full-paper processing")
        return parse_all_pages_llm(all_detail_items, image_size, subject)

    # Step 4: Merge and validate
    all_questions.sort(key=lambda q: (q.get('pageIndex', 0), q['questionNumber']))
    _check_section_continuity(all_questions)

    # Deduplicate: same questionNumber + same section → keep first
    seen = set()
    deduped = []
    for q in all_questions:
        key = (q['questionNumber'], q.get('section', ''))
        if key not in seen:
            seen.add(key)
            deduped.append(q)
        else:
            logger.warning(f"Duplicate Q{q['questionNumber']} in section [{q.get('section','')}], dropped")

    logger.info(f"Section-based total: {len(deduped)} questions from {len(sections)} sections "
                f"({len(failed_sections)} sections failed/skipped)")

    return {
        'questions': deduped,
        'passages': [],
        'engine': f'textin-section-llm-{LLM_MODEL}',
        'image_size': img_size,
        'raw_count': len(deduped),
    }


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
