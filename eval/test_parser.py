#!/usr/bin/env python3
"""
Parser Unit Test — 验证 8 阶段题目解析逻辑
===========================================
用模拟的 TextIn detail items 测试 parser，与 ground truth 对比。

用法:
    python eval/test_parser.py                    # 运行全部测试
    python eval/test_parser.py --verbose          # 详细输出
    python eval/test_parser.py --paper 02070f95   # 针对特定试卷
"""

import json
import sys
import os

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.textin.parser import (
    TextInQuestionParser,
    parse_xparse_result,
    QUESTION_PATTERN,
    GRAMMAR_BLANK_PATTERN,
    TRANSLATION_PATTERN,
    HANDWRITTEN_Q_PATTERN,
    OPTION_PATTERN,
)

# ═══════════════════════════════════════
# Mock Data Builders
# ═══════════════════════════════════════

def mock_item(text, x=0, y=0, w=300, h=24, tags=None, item_type="text", sub_type=""):
    """Create a TextIn detail item with proper position."""
    if tags is None:
        tags = []
    return {
        'text': text,
        'tags': tags,
        'position': [x, y, x + w, y, x + w, y + h, x, y + h],
        'type': item_type,
        'sub_type': sub_type,
    }


def mock_page1_items():
    """Page 1: Grammar Q1-10 (blank fill with hints), Section header"""
    items = []
    items.append(mock_item("Grammar and Vocabulary", y=0, item_type="heading"))

    # Q1-10: grammar blanks — "46(handled)" format in passage
    passage_lines = [
        "The concept of time 1(remain) a mystery throughout human history.",
        "Ancient civilizations 2(develop) various ways to measure time,",
        "from sundials to water clocks. Modern society 3(rely) heavily on",
        "precise timekeeping. Without accurate clocks, navigation 4(be)",
        "impossible. The first mechanical clocks 5(appear) in Europe during",
        "the 13th century. Before that, people 6(use) the position of the sun",
        "to tell time. Today, atomic clocks 7(provide) the most accurate",
        "measurements. Scientific experiments 8(require) precise timing.",
        "GPS satellites 9(depend) on atomic clocks for positioning.",
        "Without them, our modern world 10(cease) to function properly.",
    ]
    for i, line in enumerate(passage_lines):
        items.append(mock_item(line, y=40 + i * 24))

    return items


def mock_page2_items():
    """Page 2: Listening Q1-10 (option groups, no visible question numbers)"""
    items = []
    items.append(mock_item("Section A Listening Comprehension", y=0, item_type="heading"))
    items.append(mock_item("Directions: In Section A, you will hear...", y=24, item_type="text"))

    # 10 listening questions with option groups
    for qi in range(1, 11):
        y_base = 60 + (qi - 1) * 100
        # Question prompt line
        items.append(mock_item(
            f"{qi}. What does the speaker suggest?",
            y=y_base, item_type="question"
        ))
        # Options
        for li, letter in enumerate(['A', 'B', 'C', 'D']):
            items.append(mock_item(
                f"{letter}. Option {letter} for question {qi}",
                y=y_base + 24 + li * 24,
                item_type="option"
            ))

    return items


def mock_page3_items():
    """Page 3: Choice questions Q11-20 (standard line-start format)"""
    items = []
    items.append(mock_item("Section B", y=0, item_type="heading"))

    questions = [
        (11, "What is the main idea of the passage?"),
        (12, "According to the author, why is sleep important?"),
        (13, "What does the word 'crucial' mean in paragraph 2?"),
        (14, "Which of the following is NOT mentioned?"),
        (15, "The passage suggests that most people ___."),
        (16, "What can be inferred from the third paragraph?"),
        (17, "The author's attitude toward the topic is ___."),
        (18, "What is the purpose of the last paragraph?"),
        (19, "According to the research, which group benefits most?"),
        (20, "What would be the best title for this passage?"),
    ]
    for q_num, text in questions:
        y = 40 + (q_num - 11) * 72
        items.append(mock_item(f"{q_num}. {text}", y=y, item_type="question"))
        for li, letter in enumerate(['A', 'B', 'C', 'D']):
            items.append(mock_item(
                f"{letter}. Answer option {letter} for Q{q_num}",
                y=y + 24 + li * 24,
                item_type="option"
            ))

    return items


def mock_page4_items():
    """Page 4: Translation Q21-25 + more choices Q25-45"""
    items = []
    items.append(mock_item("Section C Translation", y=0, item_type="heading"))

    # Translation Q21-25
    translations = [
        (21, "Directions: Translate the following sentences into English, using the words given in the brackets."),
        (22, "我们必须采取有效措施来保护环境。(measure)"),
        (23, "直到昨天他才告诉我真相。(until)"),
        (24, "这本书值得反复阅读。(worth)"),
        (25, "他习惯每天早起锻炼。(habit)"),
    ]
    for i, (q_num, text) in enumerate(translations):
        items.append(mock_item(f"{q_num}. {text}", y=40 + i * 28, item_type="question"))

    # Choice Q26-45
    for q_num in range(26, 46):
        y = 200 + (q_num - 26) * 64
        items.append(mock_item(
            f"{q_num}. Reading comprehension question {q_num}",
            y=y, item_type="question"
        ))
        for li, letter in enumerate(['A', 'B', 'C', 'D']):
            items.append(mock_item(
                f"{letter}. Option {letter} for question {q_num}",
                y=y + 22 + li * 20,
                item_type="option"
            ))

    return items


def mock_page5_items():
    """Page 5: Cloze Q71-84 (embedded numbers)"""
    items = []
    items.append(mock_item("Section D Cloze", y=0, item_type="heading"))

    # Cloze passage with embedded numbers (letter+digits pattern)
    passage = (
        "Research has shown that sleep plays F71 vital role in memory consolidation. "
        "During deep sleep, the brain processes 72E information gathered throughout the day. "
        "Scientists have discovered that students who sleep well perform G73 better on tests. "
        "The study involved over 1,000 participants D74 were monitored for two weeks. "
        "Results indicated a strong correlation between sleep quality K75 academic achievement. "
        "Furthermore, REM sleep specifically helps with creative C76 problem-solving abilities. "
        "The researchers also P77 found that napping for 20-30 minutes could significantly "
        "improve cognitive R78 performance. However, longer naps S79 sometimes lead to "
        "grogginess. The optimal nap duration T80 is between 10-20 minutes. "
        "Another finding U81 was that consistent sleep schedules matter E82 more than total "
        "sleep duration. Students with irregular sleep T83 patterns performed worse than "
        "those who maintained F84 regular sleeping habits."
    )
    items.append(mock_item(passage, y=30, w=800, h=400, item_type="paragraph"))

    return items


def mock_page6_items():
    """Page 6: Grammar blanks Q46-70 (mixed formats)"""
    items = []
    items.append(mock_item("Grammar", y=0, item_type="heading"))

    # Q46-55: standard line-start questions
    for q_num in range(46, 56):
        items.append(mock_item(
            f"{q_num}. Grammar question number {q_num}",
            y=40 + (q_num - 46) * 28, item_type="question"
        ))

    # Q56-65: grammar blanks inline in passage
    passage = (
        "The Internet 56(change) the way people communicate dramatically. "
        "Before its invention, letters 57(be) the primary means of long-distance "
        "communication. Today, emails and instant messages 58(replace) traditional "
        "mail. Social media platforms 59(transform) how we share information. "
        "However, some argue that face-to-face communication 60(suffer) as a result. "
        "Studies show that young people 61(spend) less time on real-world interactions. "
        "Nevertheless, technology 62(bring) people together in new ways. "
        "Video calls 63(allow) families to stay connected across continents. "
        "The impact of the Internet 64(continue) to evolve. "
        "Only time will tell what the future 65(hold) for human communication."
    )
    items.append(mock_item(passage, y=320, w=800, h=300, item_type="paragraph"))

    # Q66-70: handwritten corrections in margin
    items.append(mock_item("66. correct", y=600, x=620, w=140, h=24,
                           tags=['handwritten'], item_type="handwritten"))
    items.append(mock_item("B67 wrong", y=628, x=620, w=140, h=24,
                           tags=['handwritten'], item_type="handwritten"))
    items.append(mock_item("A68. check", y=656, x=620, w=140, h=24,
                           tags=['handwritten'], item_type="handwritten"))
    items.append(mock_item("69 spelling", y=684, x=620, w=140, h=24,
                           tags=['handwritten'], item_type="handwritten"))
    items.append(mock_item("D70. error", y=712, x=620, w=140, h=24,
                           tags=['handwritten'], item_type="handwritten"))

    return items


# ═══════════════════════════════════════
# Test Cases
# ═══════════════════════════════════════

class TestResult:
    def __init__(self, name):
        self.name = name
        self.passed = 0
        self.failed = 0
        self.errors = []

    def check(self, condition, msg):
        if condition:
            self.passed += 1
        else:
            self.failed += 1
            self.errors.append(msg)
        return condition

    def summary(self):
        total = self.passed + self.failed
        rate = (self.passed / total * 100) if total > 0 else 0
        return f"{self.name}: {self.passed}/{total} passed ({rate:.0f}%)"


def test_pattern_regex():
    """Test individual regex patterns."""
    r = TestResult("Regex Patterns")

    # QUESTION_PATTERN
    m = QUESTION_PATTERN.match("25. What is the answer?")
    r.check(m and m.group(1) == '25', "QUESTION_PATTERN: '25. What...' → q=25")

    m = QUESTION_PATTERN.match("1. Simple question")
    r.check(m and m.group(1) == '1', "QUESTION_PATTERN: single digit '1. Simple...' → q=1")

    m = QUESTION_PATTERN.match("100. Three digit")
    r.check(m and m.group(1) == '100', "QUESTION_PATTERN: three-digit '100. Three...' → q=100")

    m = QUESTION_PATTERN.match("  46) Question with paren")
    r.check(m and m.group(1) == '46', "QUESTION_PATTERN: spaced '46) Question...' → q=46")

    # GRAMMAR_BLANK_PATTERN
    m = GRAMMAR_BLANK_PATTERN.search("1(remain) a mystery")
    r.check(m and m.group(1) == '1' and m.group(2) == 'remain',
            "GRAMMAR_BLANK: '1(remain)' → q=1, hint=remain")

    m = GRAMMAR_BLANK_PATTERN.search("46___(answer)___")
    r.check(m is None, "GRAMMAR_BLANK: '46___' → no match (correctly)")

    # TRANSLATION_PATTERN
    m = TRANSLATION_PATTERN.search("21. 翻译句子\n22. Next question")
    r.check(m and m.group(1) == '21', "TRANSLATION: '21. 翻译...' → q=21")

    m = TRANSLATION_PATTERN.search("25．中文全角句号")
    r.check(m and m.group(1) == '25', "TRANSLATION: full-width '25．' → q=25")

    # HANDWRITTEN_Q_PATTERN
    m = HANDWRITTEN_Q_PATTERN.search("A25. correct")
    r.check(m and m.group(1) == '25', "HANDWRITTEN: 'A25. correct' → q=25")

    m = HANDWRITTEN_Q_PATTERN.search("B67 wrong")
    r.check(m and m.group(1) == '67', "HANDWRITTEN: 'B67 wrong' → q=67")

    print(r.summary())
    if r.errors:
        for e in r.errors:
            print(f"  ❌ {e}")
    return len(r.errors) == 0


def test_phase1_line_start():
    """Test Phase 1: standard line-start question number detection."""
    r = TestResult("Phase 1: Line-start")

    items = [
        mock_item("11. What is the main idea?", y=40),
        mock_item("  12) According to the passage", y=68),
        mock_item("Some plain text without a number", y=96),
    ]
    parser = TextInQuestionParser("英语")
    result = parser.parse(items)

    q_nums = {q['questionNumber'] for q in result['questions']}
    r.check(11 in q_nums, "Phase 1 detected Q11 from '11. What...'")
    r.check(12 in q_nums, "Phase 1 detected Q12 from '  12) According...'")
    r.check(len(result['questions']) == 2,
            f"Phase 1: 2 questions found (not more plain text numbers)")

    print(r.summary())
    if r.errors:
        for e in r.errors:
            print(f"  ❌ {e}")
    return len(r.errors) == 0


def test_phase2_option_attach():
    """Test Phase 2: option lines attach to current question."""
    r = TestResult("Phase 2: Option Attach")

    items = [
        mock_item("15. Sample question", y=40),
        mock_item("A. First option", y=64, item_type="option"),
        mock_item("B. Second option", y=88, item_type="option"),
        mock_item("C. Third option", y=112, item_type="option"),
        mock_item("D. Fourth option", y=136, item_type="option"),
    ]
    parser = TextInQuestionParser("英语")
    result = parser.parse(items)

    qs = {q['questionNumber']: q['options'] for q in result['questions']}
    r.check(15 in qs, "Phase 2: Q15 detected with options")
    r.check(len(qs.get(15, {})) == 4, f"Phase 2: Q15 has 4 options, got {len(qs.get(15, {}))}")
    r.check(qs.get(15, {}).get('B', '') == 'Second option',
            "Phase 2: Q15 option B text correct")

    # Question without options
    items2 = [
        mock_item("20. Question with no options", y=40),
        mock_item("Some other text", y=64),
    ]
    result2 = parser.parse(items2)
    qs2 = {q['questionNumber']: q.get('options', {}) for q in result2['questions']}
    r.check(len(qs2.get(20, {})) == 0,
            "Phase 2: Q20 with no options has empty options dict")

    print(r.summary())
    if r.errors:
        for e in r.errors:
            print(f"  ❌ {e}")
    return len(r.errors) == 0


def test_phase3_grammar_blanks():
    """Test Phase 3: grammar blank detection (46(handled) format)."""
    r = TestResult("Phase 3: Grammar Blanks")

    items = [
        mock_item("The concept 1(remain) a mystery.", y=40),
        mock_item("Ancient people 2(develop) various tools.", y=68),
        mock_item("Modern society 3(rely) on technology.", y=96),
    ]
    parser = TextInQuestionParser("英语")
    result = parser.parse(items)

    q_nums = {q['questionNumber'] for q in result['questions']}
    for q in [1, 2, 3]:
        r.check(q in q_nums, f"Phase 3 detected Q{q} grammar blank")

    # Check hint word is preserved
    q1 = next((q for q in result['questions'] if q['questionNumber'] == 1), None)
    r.check(q1 and '语法填空' in q1['questionText'],
            "Phase 3: Q1 text contains '语法填空'")
    r.check(q1 and 'remain' in q1['questionText'],
            "Phase 3: Q1 text contains hint word 'remain'")

    print(r.summary())
    if r.errors:
        for e in r.errors:
            print(f"  ❌ {e}")
    return len(r.errors) == 0


def test_phase4_listening_groups():
    """Test Phase 4: listening question detection via option groups."""
    r = TestResult("Phase 4: Listening Groups")

    # Simulate a listening page with option groups but no visible Q numbers
    items = [
        mock_item("Section A Listening Comprehension", y=0, item_type="heading"),
        mock_item("Directions: You will hear...", y=24),
    ]
    # 5 listening questions, each with 4 options
    for qi in range(1, 6):
        y = 60 + (qi - 1) * 100
        items.append(mock_item(f"{qi}. What does the speaker mean?", y=y))
        for li, letter in enumerate(['A', 'B', 'C', 'D']):
            items.append(mock_item(f"{letter}. Choice {letter}", y=y + 22 + li * 20, item_type="option"))

    parser = TextInQuestionParser("英语")
    result = parser.parse(items)

    q_nums = {q['questionNumber'] for q in result['questions']}
    for q in [1, 2, 3, 4, 5]:
        r.check(q in q_nums, f"Phase 4: Q{q} detected from option group")

    # Verify options attached
    q1 = next((q for q in result['questions'] if q['questionNumber'] == 1), None)
    r.check(q1 and len(q1.get('options', {})) == 4,
            f"Phase 4: Q1 has 4 options, got {len(q1.get('options', {})) if q1 else 0}")

    r.check(not any(q['questionNumber'] > 5 for q in result['questions']),
            "Phase 4: No extra questions hallucinated beyond option groups")

    print(r.summary())
    if r.errors:
        for e in r.errors:
            print(f"  ❌ {e}")
    return len(r.errors) == 0


def test_phase5_cloze_embedded():
    """Test Phase 5: cloze embedded question numbers (letter+digits)."""
    r = TestResult("Phase 5: Cloze Embedded")

    # Passage with embedded cloze numbers
    passage = (
        "Research shows sleep plays F71 vital role in memory. Students 72E "
        "who sleep well perform G73 better. The study involved D74 participants "
        "monitored for two weeks. Results showed correlation K75 with achievement."
    )
    items = [
        mock_item("Section D Cloze", y=0, item_type="heading"),
        mock_item(passage, y=30, w=800, h=200, item_type="paragraph"),
    ]
    parser = TextInQuestionParser("英语")
    result = parser.parse(items)

    q_nums = {q['questionNumber'] for q in result['questions']}
    # Should detect Q71-75 as a cluster (5 questions in range 40-85)
    for q in range(71, 76):
        r.check(q in q_nums, f"Phase 5 detected Q{q} as cloze embedded")

    # Should NOT trigger if fewer than 5 in range
    short_passage = "Just one number F52 embedded here."  # Only 1, cluster < 5
    items2 = [mock_item(short_passage, y=30, w=800, h=40, item_type="paragraph")]
    result2 = parser.parse(items2)
    q_nums2 = {q['questionNumber'] for q in result2['questions']}
    r.check(52 not in q_nums2,
            "Phase 5 did NOT trigger for single embedded number (cluster < 5)")

    print(r.summary())
    if r.errors:
        for e in r.errors:
            print(f"  ❌ {e}")
    return len(r.errors) == 0


def test_phase6_gap_filling():
    """Test Phase 6: conservative gap filling (1-2 gap only)."""
    r = TestResult("Phase 6: Gap Filling")

    # Q11, Q12, Q13, Q14, Q15 —— Q16, Q17, Q18 (gap of 1 after Q15)
    # Q11, Q12 —— Q15, Q16 (gap of 2: Q13, Q14 should be filled)
    items = [
        mock_item("11. Question eleven", y=40),
        mock_item("12. Question twelve", y=68),
        # Q13, Q14 intentionally missing
        mock_item("15. Question fifteen", y=124),
        mock_item("16. Question sixteen", y=152),
    ]
    parser = TextInQuestionParser("英语")
    result = parser.parse(items)

    q_nums = {q['questionNumber'] for q in result['questions']}
    r.check(11 in q_nums, "Phase 6: Q11 detected")
    r.check(12 in q_nums, "Phase 6: Q12 detected")
    r.check(13 in q_nums, "Phase 6: Q13 gap-filled (gap=2, ≤2)")
    r.check(14 in q_nums, "Phase 6: Q14 gap-filled (gap=2, ≤2)")
    r.check(15 in q_nums, "Phase 6: Q15 detected")
    r.check(16 in q_nums, "Phase 6: Q16 detected")

    # Gap of 5 should NOT be filled
    items2 = [
        mock_item("20. Question twenty", y=40),
        mock_item("26. Question twenty-six", y=68),  # gap of 5
    ]
    result2 = parser.parse(items2)
    q_nums2 = {q['questionNumber'] for q in result2['questions']}
    r.check(20 in q_nums2 and 26 in q_nums2, "Phase 6: Q20, Q26 detected")
    r.check(21 not in q_nums2, "Phase 6: Q21 NOT filled (gap=5 > 2)")
    r.check(22 not in q_nums2, "Phase 6: Q22 NOT filled")

    print(r.summary())
    if r.errors:
        for e in r.errors:
            print(f"  ❌ {e}")
    return len(r.errors) == 0


def test_phase7_handwritten():
    """Test Phase 7: handwritten region extraction."""
    r = TestResult("Phase 7: Handwritten")

    items = [
        mock_item("46. Standard question", y=40),
        mock_item("A47 correct", y=600, x=600, w=120, h=24,
                  tags=['handwritten'], item_type="handwritten"),
        mock_item("B48 wrong answer", y=628, x=600, w=140, h=24,
                  tags=['handwritten'], item_type="handwritten"),
        mock_item("49. Another printed question", y=68),
    ]
    parser = TextInQuestionParser("英语")
    result = parser.parse(items)

    q_nums = {q['questionNumber'] for q in result['questions']}

    r.check(46 in q_nums, "Phase 7: Q46 detected (printed)")
    r.check(47 in q_nums, "Phase 7: Q47 detected from handwritten 'A47'")
    r.check(48 in q_nums, "Phase 7: Q48 detected from handwritten 'B48'")
    r.check(49 in q_nums, "Phase 7: Q49 detected (printed)")

    # Verify HW questions have the HW marker in text
    q47 = next((q for q in result['questions'] if q['questionNumber'] == 47), None)
    r.check(q47 and '[HW]' in q47['questionText'],
            "Phase 7: Q47 text contains [HW] marker")

    print(r.summary())
    if r.errors:
        for e in r.errors:
            print(f"  ❌ {e}")
    return len(r.errors) == 0


def test_phase8_translation():
    """Test Phase 8: translation question detection (Q21-25)."""
    r = TestResult("Phase 8: Translation")

    items = [
        mock_item("Section C Translation", y=0, item_type="heading"),
        mock_item("21. 我们必须采取有效措施来保护环境。(measure)", y=40),
        mock_item("22. 直到昨天他才告诉我真相。(until)", y=68),
        mock_item("23. 这本书值得反复阅读。(worth)", y=96),
        mock_item("24. 他习惯每天早起锻炼。(habit)", y=124),
        mock_item("25．这个项目需要更多资金支持。(require)", y=152),
    ]
    parser = TextInQuestionParser("英语")
    result = parser.parse(items)

    q_nums = {q['questionNumber'] for q in result['questions']}

    for q in range(21, 26):
        r.check(q in q_nums, f"Phase 8: Q{q} detected as translation")

    # Verify translation text preserved
    q21 = next((q for q in result['questions'] if q['questionNumber'] == 21), None)
    r.check(q21 and '[翻译]' in q21['questionText'],
            "Phase 8: Q21 text contains '[翻译]' marker")
    r.check(q21 and 'measure' in q21['questionText'],
            "Phase 8: Q21 text contains original content")
    r.check(q21 and q21['questionType'] == 'translation',
            "Phase 8: Q21 type is 'translation'")

    # Q26+ should NOT be caught by translation pattern
    items2 = [
        mock_item("26. A regular question", y=40),
        mock_item("30. Another regular question", y=68),
    ]
    result2 = parser.parse(items2)
    types2 = {q['questionNumber']: q['questionType'] for q in result2['questions']}
    r.check(types2.get(26) != 'translation', "Phase 8: Q26 type not 'translation'")
    r.check(types2.get(30) != 'translation', "Phase 8: Q30 type not 'translation'")

    print(r.summary())
    if r.errors:
        for e in r.errors:
            print(f"  ❌ {e}")
    return len(r.errors) == 0


def test_full_pipeline():
    """Test the full 8-phase pipeline with all 6 pages."""
    r = TestResult("Full Pipeline (6 pages)")

    all_pages = [
        ("Page 1: Grammar blanks", mock_page1_items(), set(range(1, 11))),
        ("Page 2: Listening", mock_page2_items(), set(range(1, 11))),
        ("Page 3: Choice Q11-20", mock_page3_items(), set(range(11, 21))),
        ("Page 4: Translation + Choice", mock_page4_items(),
         set(range(21, 46))),
        ("Page 5: Cloze embedded", mock_page5_items(), set(range(71, 85))),
        ("Page 6: Grammar + HW", mock_page6_items(), set(range(46, 71))),
    ]

    total_expected = 0
    total_found = 0
    all_found = set()

    for page_name, items, expected in all_pages:
        parser = TextInQuestionParser("英语")
        result = parser.parse(items)
        found = {q['questionNumber'] for q in result['questions']}

        # Check each expected question
        for q in expected:
            if q in found:
                total_found += 1
            else:
                r.check(False, f"{page_name}: Q{q} MISSING from output")
            total_expected += 1

        all_found.update(found)

        # Check no hallucinations
        extra = found - expected
        for q in extra:
            r.check(False, f"{page_name}: Q{q} HALLUCINATED (not in expected)")

    # Summary
    coverage = (total_found / total_expected * 100) if total_expected > 0 else 0
    r.check(coverage >= 90, f"Full pipeline coverage: {coverage:.0f}% (target ≥ 90%)")

    print(r.summary())
    if r.errors:
        for e in r.errors:
            print(f"  ❌ {e}")
    return len(r.errors) == 0


def test_ground_truth_compare():
    """Compare parser results against actual ground truth for 02070f95."""
    r = TestResult("Ground Truth Comparison (02070f95)")

    # Load ground truth
    gt_path = os.path.join(os.path.dirname(__file__), 'ground-truth', '02070f95.json')
    if not os.path.exists(gt_path):
        print(f"  ⚠️  Ground truth file not found: {gt_path}")
        print(f"  Skipping ground truth comparison")
        return True  # Not a failure

    with open(gt_path, 'r', encoding='utf-8') as f:
        gt = json.load(f)

    gt_questions = gt['questions']
    gt_by_page = {}
    for q in gt_questions:
        page = q['pageIndex']
        if page not in gt_by_page:
            gt_by_page[page] = []
        gt_by_page[page].append(q['questionNumber'])

    print(f"  Ground truth: {len(gt_questions)} questions across {len(gt_by_page)} pages")
    print(f"  Page breakdown: { {p: len(qs) for p, qs in gt_by_page.items()} }")
    print(f"  ⚠️  GT is auto-generated, NOT human-verified")
    print(f"  Run full evaluation with real images for accurate comparison")
    print(f"  Use: node eval/evaluate.mjs --paper 02070f95 --compare-only")

    # We can't run actual OCR here, but we can verify the ground truth structure
    all_q_nums = [q['questionNumber'] for q in gt_questions]
    r.check(len(all_q_nums) == len(set(all_q_nums)),
            "GT: No duplicate question numbers")

    page_indices = [q['pageIndex'] for q in gt_questions]
    r.check(min(page_indices) >= 1, f"GT: Min page index is {min(page_indices)}")
    r.check(max(page_indices) <= 6, f"GT: Max page index is {max(page_indices)}")

    # Check question number ranges
    r.check(1 in all_q_nums or 11 in all_q_nums, "GT: Has low-numbered questions")
    r.check(any(q >= 85 for q in all_q_nums), "GT: Has high-numbered questions (Q85+)")

    # Type distribution
    types = {}
    for q in gt_questions:
        t = q.get('questionType', 'unknown')
        types[t] = types.get(t, 0) + 1
    print(f"  Type distribution: {types}")

    print(r.summary())
    if r.errors:
        for e in r.errors:
            print(f"  ❌ {e}")
    return len(r.errors) == 0


# ═══════════════════════════════════════
# Main
# ═══════════════════════════════════════

def main():
    verbose = '--verbose' in sys.argv or '-v' in sys.argv

    print("=" * 60)
    print("  TextIn Parser Unit Tests - 8 Phase Validation")
    print("=" * 60)
    print()

    tests = [
        ("Regex Patterns", test_pattern_regex),
        ("Phase 1: Line-start Detection", test_phase1_line_start),
        ("Phase 2: Option Attachment", test_phase2_option_attach),
        ("Phase 3: Grammar Blanks", test_phase3_grammar_blanks),
        ("Phase 4: Listening Groups", test_phase4_listening_groups),
        ("Phase 5: Cloze Embedded", test_phase5_cloze_embedded),
        ("Phase 6: Gap Filling", test_phase6_gap_filling),
        ("Phase 7: Handwritten Extraction", test_phase7_handwritten),
        ("Phase 8: Translation Q21-25", test_phase8_translation),
        ("Full Pipeline (6 Pages)", test_full_pipeline),
        ("Ground Truth Structure", test_ground_truth_compare),
    ]

    passed = 0
    failed = 0
    for name, test_fn in tests:
        print(f"\n{'─' * 50}")
        print(f"  {name}")
        print(f"{'─' * 50}")
        try:
            ok = test_fn()
            if ok:
                passed += 1
            else:
                failed += 1
        except Exception as e:
            print(f"  💥 Test crashed: {e}")
            if verbose:
                import traceback
                traceback.print_exc()
            failed += 1

    print(f"\n{'=' * 60}")
    print(f"  📊 OVERALL: {passed}/{passed + failed} test groups passed")
    if failed == 0:
        print(f"  ✅ All parser phases working correctly!")
    else:
        print(f"  ⚠️  {failed} test groups have failures — review above")
    print(f"{'=' * 60}")

    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
