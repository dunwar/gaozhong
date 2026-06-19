"""
TextIn Question Parser for gaozhong
===================================
Parses TextIn pdf_to_markdown detail items into structured questions.

Key design:
- TextIn returns rich structured data (position, type, sub_type)
- Phase 1: Extract questions from line-start patterns (most reliable)
- Phase 2: Merge option lines into their parent question
- Phase 3: Grammar blanks with hint words
- Phase 4: Option-group detection for listening questions
- Phase 5: Cloze embedded question numbers
- Phase 6: Conservative gap-filling (only small gaps, no bulk range inference)
- Phase 7: Handwritten region extraction
- Phase 8: Translation questions (Q21-25)
- NO bulk continuity inference — that was causing massive false positives
"""

import re
import logging
from typing import List, Dict, Optional, Set, Tuple
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# ============================================================
# Patterns
# ============================================================

# Match "25." or "25)" or "25:" at line start — most reliable signal
QUESTION_PATTERN = re.compile(r'^[\s·\-]*(\d{1,3})\s*[\.\)]\s*(.+)')

# Grammar blank: "46(custom)" or "46____" within text
GRAMMAR_BLANK_PATTERN = re.compile(r'(\d{1,2})[_\(]([a-zA-Z]+)[_\)]')

# Section headers
SECTION_PATTERN = re.compile(
    r'(Listening|Grammar|Vocabulary|Reading|Cloze|Translation|Writing|'
    r'Directions|Section|Part|词汇|词块|专题|基础训练|默写)',
    re.IGNORECASE
)

# Option line: "A.something" "B) something"
OPTION_PATTERN = re.compile(r'^[A-D][\.\)]\s*(.+)')

# Translation question: "21. 翻译内容..." or "21．翻译内容..."
TRANSLATION_PATTERN = re.compile(r'(2[1-5])[\.．]\s*(.+?)(?=\n|$)')

# Handwritten question number: "A25." "B12)" etc.
HANDWRITTEN_Q_PATTERN = re.compile(r'[A-D](\d{1,2})[\.\)\s]')


@dataclass
class ParsedQuestion:
    """A single parsed question."""
    number: int
    text: str = ""
    options: List[Tuple[str, str]] = field(default_factory=list)
    section: str = ""
    bbox: Tuple[int, int, int, int] = (0, 0, 0, 0)
    source: str = ""
    hint_word: str = ""

    def to_gaozhong_dict(self) -> Dict:
        options_dict = {}
        for letter, text in self.options:
            options_dict[letter.upper()] = text
        return {
            'questionNumber': self.number,
            'questionType': self._infer_type(),
            'questionText': self.text[:300] if self.text else '',
            'options': options_dict,
            'bbox': {
                'x': self.bbox[0], 'y': self.bbox[1],
                'w': self.bbox[2], 'h': self.bbox[3]
            },
            'passageRef': None,
            'passageText': '',
        }

    def _infer_type(self) -> str:
        text = self.text.lower()
        if '填空' in text or '_' in text:
            return 'cloze'
        if '翻译' in text or 'translate' in text:
            return 'translation'
        if any(kw in text for kw in ['listening', '听力']):
            return 'listening'
        if any(kw in text for kw in ['reading', '阅读', 'passage']):
            return 'reading'
        if any(kw in text for kw in ['writing', '写作', 'essay']):
            return 'writing'
        return 'choice'


class TextInQuestionParser:
    """
    Question parser using TextIn pdf_to_markdown results.
    Conservative extraction: only extract what TextIn actually recognized.
    """

    def __init__(self, subject: str = "英语"):
        self.subject = subject

    def parse(self, xparse_detail: List[Dict],
              image_size: Optional[Dict] = None) -> Dict:
        """
        Parse questions from TextIn detail items.

        Args:
            xparse_detail: List from TextIn result.detail
            image_size: Optional {width, height}

        Returns:
            Dict with gaozhong-compatible format
        """
        # Convert detail items to OCR line format
        ocr_lines = []
        handwritten_texts = []

        for item in xparse_detail:
            text = item.get('text', '')
            tags = item.get('tags', [])
            pos = item.get('position', [])

            if pos and len(pos) >= 8:
                xs = [pos[i] for i in range(0, len(pos), 2)]
                ys = [pos[i] for i in range(1, len(pos), 2)]
                bbox = (int(min(xs)), int(min(ys)),
                        int(max(xs) - min(xs)), int(max(ys) - min(ys)))
            else:
                bbox = (0, 0, 0, 0)

            ocr_lines.append({
                'text': text,
                'bbox': bbox,
                'tags': tags,
                'type': item.get('type', ''),
                'sub_type': item.get('sub_type', ''),
                'outline_level': item.get('outline_level', -1),
                'content': item.get('content', 0),
            })

            if 'handwritten' in tags:
                handwritten_texts.append({
                    'text': text,
                    'bbox': bbox,
                })

        logger.info(f"Parsing {len(ocr_lines)} OCR lines, {len(handwritten_texts)} handwritten")

        # Extract questions
        questions = self._extract_questions(ocr_lines, handwritten_texts)

        gaozhong_questions = [q.to_gaozhong_dict() for q in questions]

        return {
            'questions': gaozhong_questions,
            'passages': [],
            'engine': 'textin-pdf_to_markdown-v2',
            'image_size': image_size or {},
            'raw_count': len(questions),
        }

    def _extract_questions(self, ocr_lines: List[Dict],
                           handwritten_texts: List[Dict]) -> List[ParsedQuestion]:
        """Extract questions conservatively from TextIn OCR lines."""
        questions_dict: Dict[int, ParsedQuestion] = {}
        current_section = ""

        # Phase 1: Line-start question numbers (reliable)
        # TextIn usually returns each question as a separate paragraph
        # starting with "25." or "25)"
        # Use TextIn's outline_level for title/section detection
        current_q_num = None
        for line_info in ocr_lines:
            text = line_info['text'].strip()
            if not text:
                continue

            # Skip headers/footers/sidebars (TextIn marks these as content=1)
            if line_info.get('content') == 1:
                continue

            # Track section: use TextIn's outline_level first (reliable),
            # fall back to SECTION_PATTERN regex
            outline = line_info.get('outline_level', -1)
            if outline >= 0:
                # TextIn confirmed title (0=H1, 1=H2, ...)
                current_section = text
                continue
            elif outline == -1 and SECTION_PATTERN.search(text) and len(text) < 80:
                # Regex fallback for titles TextIn didn't classify
                current_section = text
                continue

            m = QUESTION_PATTERN.match(text)
            if m:
                q_num = int(m.group(1))
                if 1 <= q_num <= 100:
                    if q_num not in questions_dict:
                        questions_dict[q_num] = ParsedQuestion(
                            number=q_num,
                            text=m.group(2).strip(),
                            bbox=line_info['bbox'],
                            source='line_start',
                            section=current_section
                        )
                    current_q_num = q_num
                    continue

            # Phase 2: Attach option lines to current question
            opt_match = OPTION_PATTERN.match(text)
            if opt_match and current_q_num and current_q_num in questions_dict:
                letter = text[0].upper()
                questions_dict[current_q_num].options.append(
                    (letter, opt_match.group(1).strip())
                )
                continue

        # Phase 3: Grammar blanks (e.g. "46(handled)" inline)
        full_text = '\n'.join(l['text'] for l in ocr_lines)
        for m in GRAMMAR_BLANK_PATTERN.finditer(full_text):
            q = int(m.group(1))
            hint = m.group(2)
            if 1 <= q <= 30 and q not in questions_dict:
                start = max(0, m.start() - 60)
                end = min(len(full_text), m.end() + 60)
                ctx = full_text[start:end].replace('\n', ' ')
                questions_dict[q] = ParsedQuestion(
                    number=q,
                    text=f"[语法填空 {hint}] {ctx[:120]}",
                    source='grammar_blank',
                    hint_word=hint,
                )

        # Phase 4: Option-group detection for listening questions
        # Listening questions have no visible question number — just 4 options (A/B/C/D)
        # ONLY trigger if the page contains listening-related keywords
        full_text_for_check = '\n'.join(l['text'] for l in ocr_lines).lower()
        is_listening_page = any(kw in full_text_for_check for kw in [
            'listening', 'section a', 'short conversation', '听力'
        ])
        has_existing_low_q = any(q in questions_dict for q in range(1, 11))
        
        if is_listening_page and not has_existing_low_q:
            option_groups = []
            current_group = []
            for line_info in ocr_lines:
                text = line_info['text'].strip()
                opt = OPTION_PATTERN.match(text)
                if opt:
                    letter = text[0].upper()
                    current_group.append((letter, opt.group(1).strip(), line_info['bbox']))
                else:
                    if len(current_group) >= 3:
                        option_groups.append(current_group)
                    current_group = []
            if current_group and len(current_group) >= 3:
                option_groups.append(current_group)

            if 2 <= len(option_groups) <= 15:
                for gi, group in enumerate(option_groups[:20]):
                    q_num = gi + 1
                    if q_num not in questions_dict:
                        opts = [(g[0], g[1]) for g in group]
                        bbox = group[0][2]
                        questions_dict[q_num] = ParsedQuestion(
                            number=q_num, text="[听力] Section A",
                            options=opts, bbox=bbox,
                            source='option_group', section='Listening'
                        )

        # Phase 5: Cloze embedded question numbers
        # In cloze passages, numbers appear mid-text: "...is F52 by..." or "...languages must be 54E..."
        # Pattern: letter+digits or digits+letter embedded in text
        if not any(q in questions_dict for q in range(46, 70)):
            cloze_pattern = re.compile(r'[A-Z](\d{2})|(\d{2})[A-Z]')
            cloze_qs = set()
            for line_info in ocr_lines:
                text = line_info['text']
                for m in cloze_pattern.finditer(text):
                    q_str = m.group(1) or m.group(2)
                    if q_str:
                        q = int(q_str)
                        if 40 <= q <= 85 and q not in questions_dict:
                            cloze_qs.add(q)

            # Only add cloze questions if we find a coherent cluster (≥5 in range)
            if len(cloze_qs) >= 5:
                for q in sorted(cloze_qs):
                    questions_dict[q] = ParsedQuestion(
                        number=q,
                        text="[完形填空] 题号嵌入文章",
                        source='cloze_embedded',
                    )

        # Phase 6: Conservative gap-filling
        # Only fill gaps of 1-2 between directly adjacent detected numbers
        detected = sorted(questions_dict.keys())
        for i in range(len(detected) - 1):
            gap = detected[i + 1] - detected[i] - 1
            if 1 <= gap <= 2:
                for q in range(detected[i] + 1, detected[i + 1]):
                    if q not in questions_dict:
                        questions_dict[q] = ParsedQuestion(
                            number=q,
                            text="[小范围推断] 相邻题号补缺",
                            source='small_gap',
                        )

        # Phase 7: Handwritten region extraction
        # Extract question numbers from TextIn-detected handwritten areas
        for region in handwritten_texts:
            q_nums = self._extract_all_q_numbers(region['text'])
            for q in q_nums:
                if q not in questions_dict and 1 <= q <= 100:
                    questions_dict[q] = ParsedQuestion(
                        number=q,
                        text=f"[HW] {region['text'][:80]}",
                        bbox=region['bbox'],
                        source='handwritten',
                    )

        # Phase 8: Translation questions (Q21-25)
        # Shanghai English exams: translation questions appear at Q21-25
        # with Chinese prompts followed by a numbered line
        full_text = '\n'.join(l['text'] for l in ocr_lines)
        for m in TRANSLATION_PATTERN.finditer(full_text):
            q, text = int(m.group(1)), m.group(2)
            if 21 <= q <= 25 and q not in questions_dict:
                questions_dict[q] = ParsedQuestion(
                    number=q,
                    text=f"[翻译] {text[:100]}",
                    source='translation',
                    section='Translation',
                )

        return sorted(questions_dict.values(), key=lambda q: q.number)

    def _extract_all_q_numbers(self, text: str) -> List[int]:
        """Extract all possible question numbers from handwritten text."""
        numbers: Set[int] = set()
        patterns = [
            HANDWRITTEN_Q_PATTERN,
            QUESTION_PATTERN,
            GRAMMAR_BLANK_PATTERN,
        ]
        for pattern in patterns:
            for m in pattern.finditer(text):
                for gi in range(1, m.re.groups + 1):
                    try:
                        q = int(m.group(gi))
                        if 1 <= q <= 100:
                            numbers.add(q)
                    except (ValueError, IndexError):
                        continue
        return sorted(numbers)


def parse_xparse_result(xparse_detail: List[Dict],
                         image_size: Optional[Dict] = None,
                         subject: str = "英语") -> Dict:
    """
    One-shot function: parse TextIn detail items into gaozhong question format.

    Args:
        xparse_detail: The `result.detail` array from TextIn pdf_to_markdown API
        image_size: Optional {width, height}
        subject: Subject name

    Returns:
        Dict with gaozhong-compatible {questions, passages, engine, image_size}
    """
    parser = TextInQuestionParser(subject=subject)
    return parser.parse(xparse_detail, image_size)
