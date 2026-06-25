"""
Local test script: validate OCR preprocessing without calling LLM API.
Tests _clean_ocr_text() and _split_glued_items() against real TextIn data.
"""
import sys, os, json, re

# Setup path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'gaozhong', 'src', 'textin'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'gaozhong', 'src', 'textin'))

# Direct import by reading the file
LLM_PARSER_PATH = os.path.join(os.path.dirname(__file__), '..', 'src', 'textin', 'llm_parser.py')
exec(open(os.path.abspath(LLM_PARSER_PATH), encoding='utf-8').read())


def load_test_pages():
    """Load TextIn raw JSON test data files."""
    test_dir = os.path.join(os.path.dirname(__file__), '..', 'test_data')
    pages = []
    for i in range(1, 7):
        fpath = os.path.join(test_dir, f'textin_raw_p{i}.json')
        if os.path.exists(fpath):
            with open(fpath, encoding='utf-8') as f:
                data = json.load(f)
            # Extract detail items
            detail = data.get('detail', data.get('result', {}).get('detail', []))
            pages.append(detail)
            print(f"Page {i}: {len(detail)} detail items")
        else:
            print(f"Page {i}: NOT FOUND")
    return pages


def test_clean_patterns():
    """Test _clean_ocr_text against known粘连 patterns."""
    print("\n" + "="*70)
    print("TEST: _clean_ocr_text() against known patterns")
    print("="*70)

    test_cases = [
        # (input, description, expected_contains)
        ("A43.The insurance company the risk of flooding", "选项+题号粘连 A43.", "43."),
        ("D41.The ancient skill of navigating", "选项+题号粘连 D41.", "41."),
        ("CC.burn the midnight oil 45.When Sarah saw the video", "重复选项+内容+题号 CC.45.", "45."),
        ("impossible to translateI 46 .A Japanese designer", "句子+题号粘连 46", "46."),
        ("lack of a preciseK47", "词尾+题号粘连 K47", "47"),
        ("AC.WwSSdo13. 3.Why does the writer", "垃圾前缀+题号 3.", "3."),
        ("B,C.What farming techniques they developed 3. A.Chopsticks", "重复选项 B,C. + 题号3", "3."),
        ("CD75.A.extensive", "垃圾前缀+题号 75", "75"),
        ("otherI61 .Nobel-prizewinning scientists", "句子+题号粘连 61", "61."),
        ("market 64 .This holds that having", "句中题号 64", "64"),
        ("A1.What does the phrase \"a bum rap\"", "选项+题号1", "1."),
        ("D2.Which of the following passwords", "选项+题号2", "2."),
    ]

    passed = 0
    failed = 0
    for text, desc, expected in test_cases:
        cleaned = _clean_ocr_text(text)
        ok = expected in cleaned
        status = "PASS" if ok else "FAIL"
        if ok:
            passed += 1
        else:
            failed += 1
        print(f"\n[{status}] {desc}")
        print(f"  Input:    {text[:90]}")
        print(f"  Cleaned:  {cleaned[:90]}")
        if not ok:
            print(f"  Expected to contain: {expected}")

    print(f"\n{'='*70}")
    print(f"RESULTS: {passed}/{passed+failed} passed, {failed} failed")
    return failed == 0


def test_split_items():
    """Test _split_glued_items."""
    print("\n" + "="*70)
    print("TEST: _split_glued_items()")
    print("="*70)

    test_cases = [
        ("CC.burn the midnight oil 45.When Sarah saw the video", "粘连选项+题号", 2),
        ("A43.The insurance company the risk of flooding", "选项+题号", 1),  # _clean_ocr_text handles this
        ("impossible to translateI 46 .A Japanese designer", "句子+题号", 1),
    ]

    for text, desc, min_parts in test_cases:
        cleaned = _clean_ocr_text(text)
        parts = _split_glued_items(cleaned)
        ok = len(parts) >= min_parts
        status = "PASS" if ok else "INFO"
        print(f"\n[{status}] {desc}")
        print(f"  Input:  {text[:80]}")
        print(f"  Parts ({len(parts)}):")
        for i, p in enumerate(parts):
            print(f"    [{i}] {p[:100]}")


def test_format_items():
    """Test _format_items on real data, focusing on known problem areas."""
    print("\n" + "="*70)
    print("TEST: _format_items() on real data (problem areas)")
    print("="*70)

    pages = load_test_pages()
    if not pages:
        print("No test data found!")
        return

    # Check pages containing Q43-Q47 range (Grammar section)
    # Based on ground truth, these should be on pages 4-6
    for pi, page_items in enumerate(pages):
        formatted = _format_items(page_items)
        lines = formatted.split('\n')

        # Find lines mentioning 43, 44, 45, 46, 47
        problem_lines = []
        for li, line in enumerate(lines):
            if re.search(r'\b(4[3-7])\b', line):
                problem_lines.append((li, line))

        if problem_lines:
            print(f"\n--- Page {pi+1}: Q43-47 lines ---")
            for li, line in problem_lines[:20]:
                print(f"  L{li}: {line[:150]}")


def test_format_known_problems():
    """Specifically check that known粘连 items are split/cleaned."""
    print("\n" + "="*70)
    print("TEST: Known problem items from textin_all_pages.txt")
    print("="*70)

    pages = load_test_pages()
    if not pages:
        return

    # Search for the specific粘连 items we identified
    search_terms = [
        ("burn the midnight oil", "Q44 opt C + Q45"),
        ("translateI", "Q45-Q46粘连"),
        ("preciseK47", "Q47粘连"),
        ("WwSSdo13", "垃圾前缀"),
    ]

    for pi, page_items in enumerate(pages):
        page_text = _format_items(page_items)
        for term, desc in search_terms:
            if term.lower() in page_text.lower():
                # Find the specific line
                for line in page_text.split('\n'):
                    if term.lower() in line.lower():
                        print(f"\nPage {pi+1} [{desc}]:")
                        print(f"  {line[:200]}")
                        break


if __name__ == '__main__':
    all_pass = True
    all_pass = test_clean_patterns() and all_pass
    test_split_items()
    test_format_items()
    test_format_known_problems()

    print("\n" + "="*70)
    if all_pass:
        print("ALL TESTS PASSED")
    else:
        print("SOME TESTS FAILED — review regex patterns")
    print("="*70)
