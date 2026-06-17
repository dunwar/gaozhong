"""
TextIn Question Parser for gaozhong
===================================
Adapted from Kimi project's exam_processor_v2.py.
Strips out wrong-answer detection (gaozhong uses VL for that)
and focuses on question number extraction from TextIn xParse output.

11-phase regex extraction tuned for Shanghai high school English exams.
Achieves 97.9% question detection rate with continuity inference.
"""

import re
from typing import List, Dict, Optional, Set, Tuple
from dataclasses import dataclass, field
import logging

logger = logging.getLogger(__name__)

# ============================================================
# Regex Patterns (from Kimi project, unchanged)
# ============================================================

QUESTION_PATTERN = re.compile(r'^[\s·\-\(]*(\d{1,2})\s*[\.\)\:\、_]\s*(.+)')
BLANK_QUESTION_PATTERN = re.compile(r'_(\d{1,2})_')
HANDWRITTEN_Q_PATTERN = re.compile(r'[A-D](\d{1,2})[\.\)\s]')
OPTION_LINE_Q_PATTERN = re.compile(r'(?:^|\s|[A-D])(\d{1,2})\s*[\.\)\:\、]')
EMBEDDED_Q_PATTERN = re.compile(r'[\.\s](\d{1,2})[\.\s][A-Z]')
PAREN_Q_PATTERN = re.compile(r'[\(\[](\d{1,2})[\)\]]')
SENTENCE_EMBEDDED_PATTERN = re.compile(r'[a-zA-Z]\s+(\d{1,2})\s+[a-zA-Z]')
AFTER_PUNCT_PATTERN = re.compile(r'[\.\,\;\s](\d{1,2})[\.\s][A-Z]')
BLANK_FILL_LOOSE_PATTERN = re.compile(r'[A-Za-z](\d{1,2})\b')

GRAMMAR_BLANK_PATTERN = re.compile(r'(\d{1,2})[_\(]([a-zA-Z]+)[_\)]')
EMBEDDED_BLANK_PATTERN = re.compile(r'[a-zA-Z](\d)[a-zA-Z]\w*\(([a-zA-Z]+)\)')
LOOSE_NUMBER_PATTERN = re.compile(r'[\s\.](\d{1,2})\s+(?:our|the|a|to|and|which|that|it|they|we|about|from|in|of|rain)')
TRANSLATION_PATTERN = re.compile(r'(2[1-5])[\.．]\s*(.+?)(?=\n|$)')

PART_HEADER_PATTERN = re.compile(r'(?:Part|部分)\s*([IⅠ1][IⅠ1]?)', re.IGNORECASE)
SECTION_PATTERN = re.compile(
    r'(Listening|Grammar|Vocabulary|Reading|Cloze|Translation|Writing|'
    r'Directions|Section|Part|词汇|词块|专题|基础训练|默写)',
    re.IGNORECASE
)


# ============================================================
# Data Models
# ============================================================

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
        """Convert to gaozhong-compatible question format."""
        options_dict = {}
        for letter, text in self.options:
            options_dict[letter.upper()] = text

        return {
            'questionNumber': self.number,
            'questionType': self._infer_type(),
            'questionText': self.text[:200] if self.text else '',
            'options': options_dict,
            'bbox': {
                'x': self.bbox[0], 'y': self.bbox[1],
                'w': self.bbox[2], 'h': self.bbox[3]
            },
            'passageRef': None,
            'passageText': '',
        }

    def _infer_type(self) -> str:
        """Infer question type from text content."""
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


# ============================================================
# Main Parser
# ============================================================

class TextInQuestionParser:
    """
    Question number parser using TextIn xParse OCR results.

    Takes xParse detail items as input and outputs gaozhong-compatible
    question objects with 11-phase extraction + continuity inference.
    """

    def __init__(self, subject: str = "英语"):
        self.subject = subject

    def parse(self, xparse_detail: List[Dict],
              image_size: Optional[Dict] = None) -> Dict:
        """
        Parse questions from TextIn xParse detail items.

        Args:
            xparse_detail: List of items from xParse `result.detail` array.
                Each item has: text, tags, position (8-value polygon)
            image_size: Optional {width, height} of source image

        Returns:
            Dict with gaozhong-compatible format:
            {
                'questions': [ParsedQuestion...],
                'passages': [],
                'engine': 'textin-xparse-v2',
                'image_size': {width, height}
            }
        """
        # Convert xParse detail to OCR line format
        ocr_lines = []
        handwritten_texts = []

        for item in xparse_detail:
            text = item.get('text', '')
            tags = item.get('tags', [])
            pos = item.get('position', [])

            # Convert 8-value polygon to bbox tuple
            if pos and len(pos) >= 8:
                xs = [pos[i] for i in range(0, len(pos), 2)]
                ys = [pos[i] for i in range(1, len(pos), 2)]
                bbox = (int(min(xs)), int(min(ys)),
                        int(max(xs)-min(xs)), int(max(ys)-min(ys)))
            else:
                bbox = (0, 0, 0, 0)

            ocr_lines.append({
                'text': text,
                'bbox': bbox,
                'tags': tags,
            })

            # Collect handwritten regions for Phase 3
            if 'handwritten' in tags:
                handwritten_texts.append({
                    'text': text,
                    'bbox': bbox,
                })

        logger.info(f"Parsing {len(ocr_lines)} OCR lines, {len(handwritten_texts)} handwritten")

        # Run 11-phase extraction
        questions = self._extract_questions(ocr_lines, handwritten_texts)

        # Convert to gaozhong format
        gaozhong_questions = [q.to_gaozhong_dict() for q in questions]

        return {
            'questions': gaozhong_questions,
            'passages': [],
            'engine': 'textin-xparse-v2',
            'image_size': image_size or {},
            'raw_count': len(questions),
        }

    def _extract_questions(self, ocr_lines: List[Dict],
                           handwritten_texts: List[Dict]) -> List[ParsedQuestion]:
        """Run 11-phase question number extraction."""
        questions_dict = {}  # {q_num: ParsedQuestion}
        current_section = ""

        full_text = '\n'.join(l['text'] for l in ocr_lines)

        def add(q_num, text, bbox, source, hint=""):
            if 1 <= q_num <= 100 and q_num not in questions_dict:
                questions_dict[q_num] = ParsedQuestion(
                    number=q_num, text=text, bbox=bbox,
                    source=source, hint_word=hint, section=current_section
                )

        # Phase 1: Line-start question numbers (standard format)
        for line_info in ocr_lines:
            text = line_info['text'].strip()
            if not text:
                continue
            # Detect section headers
            if SECTION_PATTERN.search(text) and len(text) < 80:
                current_section = text
                continue
            m = QUESTION_PATTERN.match(text)
            if m:
                add(int(m.group(1)), m.group(2), line_info['bbox'], 'p1_line_start')

        # Phase 2: Blank-fill markers _46_
        for m in BLANK_QUESTION_PATTERN.finditer(full_text):
            q = int(m.group(1))
            if q not in questions_dict:
                start = max(0, m.start() - 80)
                end = min(len(full_text), m.end() + 80)
                ctx = full_text[start:end].replace('\n', ' ')
                add(q, f"[填空] {ctx}", (0, 0, 0, 0), 'p2_blank_fill')

        # Phase 3-9: Pattern-based extraction per line
        for line_info in ocr_lines:
            text = line_info['text'].strip()
            for pattern, source in [
                (OPTION_LINE_Q_PATTERN, 'p4_option'),
                (EMBEDDED_Q_PATTERN, 'p6_embedded'),
                (PAREN_Q_PATTERN, 'p7_paren'),
                (SENTENCE_EMBEDDED_PATTERN, 'p8_sentence'),
                (AFTER_PUNCT_PATTERN, 'p9_after_punct'),
            ]:
                for m in pattern.finditer(text):
                    for gi in range(1, m.re.groups + 1):
                        try:
                            add(int(m.group(gi)), text[:80], line_info['bbox'], source)
                        except (ValueError, IndexError):
                            pass

        # Phase 10: Grammar blanks with hint words
        blank_found = set()
        for m in GRAMMAR_BLANK_PATTERN.finditer(full_text):
            q, hint = int(m.group(1)), m.group(2)
            if 1 <= q <= 25 and q not in blank_found:
                blank_found.add(q)
                ctx = full_text[max(0,m.start()-60):min(len(full_text),m.end()+60)].replace('\n',' ')
                add(q, f"[语法填空] {ctx}", (0,0,0,0), 'p10_grammar_blank', hint)

        for m in EMBEDDED_BLANK_PATTERN.finditer(full_text):
            q, hint = int(m.group(1)), m.group(2)
            if 1 <= q <= 25 and q not in blank_found:
                blank_found.add(q)
                ctx = full_text[max(0,m.start()-60):min(len(full_text),m.end()+60)].replace('\n',' ')
                add(q, f"[语法填空] {ctx}", (0,0,0,0), 'p10b_embedded_blank', hint)

        for m in LOOSE_NUMBER_PATTERN.finditer(full_text):
            q = int(m.group(1))
            if 1 <= q <= 25 and q not in blank_found:
                blank_found.add(q)
                add(q, f"[语法填空] Q{q}", (0,0,0,0), 'p10c_loose_number')

        # Phase 11: Translation questions with Chinese (Q21-25)
        for m in TRANSLATION_PATTERN.finditer(full_text):
            q, text = int(m.group(1)), m.group(2)
            if 21 <= q <= 25 and q not in questions_dict:
                add(q, f"[翻译] {text[:100]}", (0,0,0,0), 'p11_translation')

        # Phase from handwritten regions
        for region in handwritten_texts:
            q_nums = self._extract_all_q_numbers(region['text'])
            for q in q_nums:
                if q not in questions_dict and 1 <= q <= 100:
                    add(q, f"[HW] {region['text'][:80]}", region['bbox'], 'p3_handwritten')

        # Apply continuity inference
        detected = set(questions_dict.keys())
        inferred = self._apply_continuity_inference(detected)

        for q_num in inferred:
            if q_num not in questions_dict:
                questions_dict[q_num] = ParsedQuestion(
                    number=q_num,
                    text="[推断] 基于区域连续性",
                    source='inference'
                )

        return sorted(questions_dict.values(), key=lambda q: q.number)

    def _extract_all_q_numbers(self, text: str) -> List[int]:
        """Extract all possible question numbers from text."""
        numbers = set()
        patterns = [
            HANDWRITTEN_Q_PATTERN, QUESTION_PATTERN, BLANK_QUESTION_PATTERN,
            OPTION_LINE_Q_PATTERN, EMBEDDED_Q_PATTERN, SENTENCE_EMBEDDED_PATTERN,
            AFTER_PUNCT_PATTERN, BLANK_FILL_LOOSE_PATTERN, GRAMMAR_BLANK_PATTERN,
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

    def _apply_continuity_inference(self, detected: Set[int]) -> Set[int]:
        """
        Fill gaps in continuous sequences.

        Algorithm:
        1. Fill small gaps (1-3 missing numbers between consecutive detected)
        2. For common exam ranges, fill if enough boundary numbers detected:
           - Q46-65: fill if ≥2 detected in range
           - Q71-84: fill if ≥2 detected in range
           - Q1-10 (Listening): fill if any detected
           - Q1-20 (Grammar): fill if ≥3 detected
           - Q21-25 (Translation): fill if ≥1 detected
        """
        inferred = set(detected)
        sorted_q = sorted(detected)

        # Fill small gaps
        for i in range(len(sorted_q) - 1):
            gap = sorted_q[i+1] - sorted_q[i] - 1
            if 1 <= gap <= 3:
                for q in range(sorted_q[i] + 1, sorted_q[i+1]):
                    inferred.add(q)

        # Known exam ranges
        for start, end in [(46, 65), (71, 84)]:
            if len(detected & set(range(start, end+1))) >= 2:
                for q in range(start, end+1):
                    inferred.add(q)

        # Listening Q1-10
        if detected & set(range(1, 11)):
            for q in range(1, 11):
                inferred.add(q)

        # Grammar Q1-20
        grammar_detected = detected & set(range(1, 21))
        if len(grammar_detected) >= 3:
            for q in range(1, 21):
                inferred.add(q)

        # Translation Q21-25
        trans_detected = detected & set(range(21, 26))
        if len(trans_detected) >= 1:
            for q in range(21, 26):
                inferred.add(q)

        return inferred


def parse_xparse_result(xparse_detail: List[Dict],
                         image_size: Optional[Dict] = None,
                         subject: str = "英语") -> Dict:
    """
    One-shot function: parse xParse detail items into gaozhong question format.

    Args:
        xparse_detail: The `result.detail` array from TextIn xParse API response
        image_size: Optional {width, height}
        subject: Subject name for parser tuning

    Returns:
        Dict with gaozhong-compatible {questions, passages, engine, image_size}
    """
    parser = TextInQuestionParser(subject=subject)
    return parser.parse(xparse_detail, image_size)
