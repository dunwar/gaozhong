# -*- coding: utf-8 -*-
"""exam_pipeline — TextIn v3 智能抽取 + 本地五层完善流水线（识别主力，2026-08 设计）

替代 llm_parser 的 LLM 解析层：
  TextIn v3 entity_extraction（每页，dewarp=1）
    → L1 题号修复（丢高位数字/尾数缺口匹配，跨页）
    → L2 缺失恢复（本地OCR截断题号行，如 '2.A.' → Q22）
    → L3 学生答案（OCR handwritten 标签孤立字母 → 就近归属）
    → L4 bbox 构建（题号citations + 同栏下题号边界）
    → L5 校验分层（连续性/选项数/恢复标记 → 置信度）

设计依据: eval 实验 2026-08-26/27（高一下95题GT + 澜大29题GT）
  基础 86/95 → +dewarp 89 → +L1 93 → +L2 94/95（98.9%），澜大 29/29
"""
import json
import logging
import os
import re
import urllib.request
import urllib.error
import base64
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

TEXTIN_BASE = "https://api.textin.com"
ENDPOINT_V3_EXTRACT = "/ai/service/v3/entity_extraction"

# ── Schema：嵌套上限 object→array→object，options 用字符串格式 ──
EXAM_SCHEMA = {
    "type": "object",
    "properties": {
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "questionNumber": {"type": "string", "description": "试卷印刷题号数字，如 \"25\""},
                    "questionType": {"type": "string", "description": "题型：听力/单项选择/完形填空/阅读理解/选词填空/句子填空/翻译/写作"},
                    "questionText": {"type": "string", "description": "题干完整文字"},
                    "options": {"type": "string", "description": "该题的选项，格式 \"A.选项A内容 B.选项B内容 C.选项C内容 D.选项D内容\"；无选项的题留空字符串"},
                    "passageText": {"type": "string", "description": "该题所属的共享文章/短文全文（阅读理解、完形填空、语篇填空才有；单独题留空字符串）"},
                },
                "required": ["questionNumber", "questionType", "questionText", "options", "passageText"]
            }
        }
    },
    "required": ["questions"]
}


# ═══════════════════════════════════════════════════════════════════════
# v3 API 客户端
# ═══════════════════════════════════════════════════════════════════════

def call_v3_extract(image_b64: str, app_id: str, secret_code: str,
                    timeout: int = 120) -> Optional[Dict]:
    """单页调用 TextIn v3 智能抽取。返回完整响应 JSON 或 None。"""
    body = json.dumps({
        "file": {"file_base64": image_b64, "file_name": "page.jpg"},
        "schema": EXAM_SCHEMA,
        "parse_options": {
            "parse_mode": "scan",
            "crop_dewarp": 1,   # 切边矫正：恢复页面边缘小题（实验+3题）
            "get_image": "none",
            "formula_level": 0
        },
        "extract_options": {"generate_citations": True}
    }).encode('utf-8')

    req = urllib.request.Request(TEXTIN_BASE + ENDPOINT_V3_EXTRACT, data=body, headers={
        'Content-Type': 'application/json',
        'x-ti-app-id': app_id,
        'x-ti-secret-code': secret_code,
    })
    # 无代理 opener（Windows 系统代理对大 POST 假性 429/重置）
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for attempt in range(3):
        try:
            with opener.open(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            if data.get('code') == 200:
                return data
            if data.get('code') == 40306:  # qps 超限
                import time
                time.sleep(5 * (attempt + 1))
                continue
            logger.error("v3 extract code=%s msg=%s", data.get('code'), data.get('message'))
            return None
        except urllib.error.HTTPError as e:
            logger.error("v3 extract HTTP %s", e.code)
            return None
        except Exception as e:
            logger.error("v3 extract error: %s", e)
            return None
    return None


# ═══════════════════════════════════════════════════════════════════════
# 适配层：v3 响应 → 我们的题目格式
# ═══════════════════════════════════════════════════════════════════════

def _pos_to_bbox(pos: List[int]) -> Dict:
    """8点坐标 → {x,y,w,h}"""
    if not pos or len(pos) < 8:
        return {'x': 0, 'y': 0, 'w': 0, 'h': 0}
    xs = pos[0::2]
    ys = pos[1::2]
    return {'x': int(min(xs)), 'y': int(min(ys)),
            'w': int(max(xs) - min(xs)), 'h': int(max(ys) - min(ys))}


def _parse_options(opt_str: str) -> Dict:
    """"A.xx B.yy C.zz D.ww" → {A:xx,...}"""
    out = {}
    s = (opt_str or '').strip()
    if not s:
        return out
    parts = re.split(r'\s+(?=[A-F][.、])', s)
    for p in parts:
        m = re.match(r'^([A-F])[.、]\s*(.+)$', p.strip())
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out


_TYPE_MAP = {
    '听力': 'listening', '单项选择': 'choice', '选择题': 'choice',
    '完形填空': 'cloze', '阅读理解': 'reading', '选词填空': 'word_fill',
    '句子填空': 'sentence_fill', '语法填空': 'grammar_fill',
    '翻译': 'translation', '写作': 'writing',
}


def parse_v3_page(v3_json: Dict, page_index_1based: int) -> List[Dict]:
    """v3 单页响应 → 我们格式的题目列表（含 citations 坐标）。"""
    qs = (v3_json.get('result', {}).get('extracted_schema', {}) or {}).get('questions') or []
    cites = (v3_json.get('result', {}).get('citations', {}) or {}).get('questions') or []
    page = v3_json.get('result', {}).get('pages', [{}])[0] or {}
    page_w = page.get('width') or 0
    page_h = page.get('height') or 0

    out = []
    for q, c in zip(qs, cites):
        raw_qn = str(q.get('questionNumber', '')).strip()
        try:
            qn = int(raw_qn)
        except ValueError:
            qn = 0
        # 题号坐标（阅读序锚点 + L4 用）
        qn_bbox = {'x': 0, 'y': 0, 'w': 0, 'h': 0}
        brs = (c or {}).get('questionNumber', {}).get('bounding_regions') or []
        if brs:
            qn_bbox = _pos_to_bbox(brs[0].get('position'))
        # 题干/选项坐标并集（bbox 备用）
        tx_boxes = []
        for key in ('questionText', 'options'):
            for br in (c or {}).get(key, {}).get('bounding_regions') or []:
                if br.get('position'):
                    tx_boxes.append(_pos_to_bbox(br['position']))

        out.append({
            'questionNumber': qn,
            'questionType': _TYPE_MAP.get(q.get('questionType', ''), q.get('questionType', 'choice')),
            'questionText': (q.get('questionText') or '').strip(),
            'options': _parse_options(q.get('options', '')),
            'passageText': (q.get('passageText') or '').strip(),
            'pageIndex': page_index_1based,
            'qnBbox': qn_bbox,           # 题号自身位置
            'textBboxes': tx_boxes,      # 题干/选项区域
            'pageWidth': page_w,
            'pageHeight': page_h,
            'studentAnswer': '',
            'confidence': 'high',
            '_source': 'textin-v3',
        })
    return out


# ═══════════════════════════════════════════════════════════════════════
# L1 题号修复（跨页，阅读序回退 → 丢高位数字 → 缺口尾数匹配）
# ═══════════════════════════════════════════════════════════════════════

def _reading_order_key(q: Dict) -> Tuple:
    return (q.get('pageIndex', 0), q.get('qnBbox', {}).get('y', 0) or 0,
            q.get('qnBbox', {}).get('x', 0) or 0, q.get('questionNumber', 0))


def fix_question_numbers(questions: List[Dict]) -> List[Dict]:
    """L1: 丢高位题号修复（段级集合对齐版，对双栏乱序免疫）。

    模式（实验实证）: 两位数题号在页面边缘丢十位 —— 88→"8", 90→"10"。
    双栏页的 citations y 序不等于阅读序，逐题检测不可靠；
    改用页级数值集合推理:
      页 P 的"低位嫌疑段" S（连续小数字、明显低于前后页衔接）
      前后衔接缺口 G = (前页末, 本页高位段首) 之间缺失的号
      |S|==|G| 且个位一一对应 → 整段修复
    误伤防护: 无一一对应不修（宁放过不改错）。
    """
    fixes = []
    if not questions:
        return fixes
    existing = {q['questionNumber'] for q in questions if q['questionNumber']}
    pages = sorted({q.get('pageIndex', 0) for q in questions})
    qmap = {}
    for q in questions:
        if q['questionNumber']:
            qmap.setdefault(q['pageIndex'], {})[q['questionNumber']] = q

    for pi in pages:
        nums = sorted(qmap.get(pi, {}))
        if not nums:
            continue
        # 前页最大题号 / 后页最小题号
        prev_max = max((max(qmap[p]) for p in pages if p < pi and qmap.get(p)), default=None)
        # 本页高位段首 = 本页大于 prev_max 的最小号（无 prev_max 时取本页最大段）
        highs = [n for n in nums if prev_max is None or n > prev_max]
        if not highs:
            continue
        hi_start = min(highs)
        # 低位嫌疑段: 本页小于 prev_max 的连续数字（且 < hi_start）
        lows = [n for n in nums if n < hi_start]
        if not lows or prev_max is None:
            continue
        # 缺口 = (prev_max, hi_start) 中全局缺失的号
        gap = [m for m in range(prev_max + 1, hi_start) if m not in existing]
        if not gap or len(gap) > 8:
            continue
        # 嫌疑段与缺口逐个位对应（数值序）
        if len(lows) != len(gap):
            continue
        ok = all(l % 10 == g % 10 or str(g).endswith(str(l)) for l, g in zip(lows, gap))
        if not ok:
            continue
        for l, g in zip(lows, gap):
            q = qmap[pi][l]
            fixes.append({'page': pi, 'from': l, 'to': g})
            existing.discard(l)
            existing.add(g)
            q['_qnOriginal'] = l
            q['_qnCorrected'] = True
            q['questionNumber'] = g
            q['confidence'] = 'medium'
            logger.info("L1题号修复: Q%s → Q%s (page %s, 段对齐 %s→%s)", l, g, pi, lows, gap)
    questions.sort(key=lambda x: (x.get('pageIndex', 0), x['questionNumber']))
    return fixes


# ═══════════════════════════════════════════════════════════════════════
# L2 缺失恢复（本地 OCR 截断题号行）
# ═══════════════════════════════════════════════════════════════════════

_RE_TRUNC_QN = re.compile(r'^([1-9])[.、]\s*(?:A[.、])?\s*(.*)$')
_RE_ANCHOR = re.compile(r'Questions?\s+(\d+)\s*(?:through|to|-|–)\s*(\d+)', re.I)


def recover_missing_questions(questions: List[Dict], ocr_items_by_page: Dict[int, List[Dict]]) -> List[Dict]:
    """L2: 用本地 OCR detail items 恢复缺失题号的题。

    依据（实验实证）: 截断题号行 '1.A.at ease' = Q21、'2.A.targeted' = Q22。
    规则: 期望号（区间锚点/连续性）在 OCR 里找尾数匹配的截断行 → 建最小题记录。
    """
    recovered = []
    if not questions:
        return recovered
    existing = {q['questionNumber'] for q in questions if q['questionNumber']}

    # 期望号集：锚点区间 ∪ 邻居连续外推
    expect = set()
    for pi, items in ocr_items_by_page.items():
        for it in items:
            m = _RE_ANCHOR.search(it.get('text', '') or '')
            if m:
                a, b = int(m.group(1)), int(m.group(2))
                if 0 < a < b < 300 and b - a < 120:
                    expect.update(range(a, b + 1))
    for q in questions:
        if q['questionNumber']:
            expect.update(range(max(1, q['questionNumber'] - 1), q['questionNumber'] + 2))
    missing = sorted(m for m in expect if m not in existing)
    if not missing:
        return recovered

    for pi, items in sorted(ocr_items_by_page.items()):
        for it in items:
            txt = (it.get('text', '') or '').strip()
            m = _RE_TRUNC_QN.match(txt)
            if not m:
                continue
            d = int(m.group(1))
            tail_rest = m.group(2)
            # 该页已有正常题号 d 就不是截断行（正常单数字题）
            if any(q['questionNumber'] == d and q['pageIndex'] == pi for q in questions):
                continue
            cands = [x for x in missing if str(x).endswith(str(d))]
            if len(cands) != 1:
                continue
            target = cands[0]
            pos = it.get('position') or []
            bbox = _pos_to_bbox(pos)
            questions.append({
                'questionNumber': target,
                'questionType': 'choice',
                'questionText': tail_rest[:200],
                'options': {},
                'passageText': '',
                'pageIndex': pi,
                'qnBbox': bbox,
                'textBboxes': [bbox] if bbox['w'] else [],
                'pageWidth': 0, 'pageHeight': 0,
                'studentAnswer': '',
                'confidence': 'low',
                '_source': 'ocr-recovered',
                '_qnOriginal': d,
            })
            existing.add(target)
            missing.remove(target)
            recovered.append(target)
            logger.info("L2缺失恢复: OCR行 %r → Q%d (page %d)", txt[:30], target, pi)

    questions.sort(key=lambda x: (x.get('pageIndex', 0), x['questionNumber']))
    return recovered


# ═══════════════════════════════════════════════════════════════════════
# L3 学生答案（handwritten 标签孤立字母 → 就近归属）
# ═══════════════════════════════════════════════════════════════════════

_RE_ANSWER_TOKEN = re.compile(r'^[A-Za-z]{1,12}$')


def attach_student_answers(questions: List[Dict], ocr_items_by_page: Dict[int, List[Dict]]) -> int:
    """L3: OCR 里 handwritten 标签的孤立字母/单词 → 几何就近归属题目。

    依据（实验实证）: TextIn 原始 OCR 对学生手写输出独立 item + tags:['handwritten']，
    如 'C' at [770,38]。这比 LLM 抽取的 studentAnswer（实测不可信）和 VL 读图都干净。
    """
    attached = 0
    for pi, items in ocr_items_by_page.items():
        page_qs = [q for q in questions if q.get('pageIndex') == pi and q.get('qnBbox')]
        if not page_qs:
            continue
        for it in items:
            tags = it.get('tags') or []
            if 'handwritten' not in tags:
                continue
            txt = (it.get('text', '') or '').strip()
            if not _RE_ANSWER_TOKEN.match(txt):
                continue
            pos = it.get('position') or []
            bb = _pos_to_bbox(pos)
            if not bb['w']:
                continue
            # 就近题号（手写答案通常紧贴题号行，y 差小者胜）
            best, best_dy = None, 10 ** 9
            for q in page_qs:
                qb = q['qnBbox']
                dy = abs((bb['y'] + bb['h'] / 2) - (qb['y'] + qb['h'] / 2))
                if dy < best_dy:
                    best, best_dy = q, dy
            if best is not None and best_dy < 120 and not best.get('studentAnswer'):
                best['studentAnswer'] = txt.upper()
                attached += 1
    if attached:
        logger.info("L3学生答案: 归属 %d 处", attached)
    return attached


# ═══════════════════════════════════════════════════════════════════════
# L4 bbox 构建（题号 citations + 同栏下题号边界）
# ═══════════════════════════════════════════════════════════════════════

def build_question_bboxes(questions: List[Dict]) -> int:
    """L4: 每题 bbox = 题号位置到（同栏）下一题号 y 的竖向条带 ∪ 题干/选项区域并集。

    判错（红笔质心匹配）需要每题的判定区域；此几何构建替代 itemIndices 回显重建，
    且对 L2 恢复的题同样有效。
    """
    built = 0
    by_page = {}
    for q in questions:
        by_page.setdefault(q.get('pageIndex', 0), []).append(q)
    for pi, qs in by_page.items():
        qs.sort(key=lambda x: (x.get('qnBbox', {}).get('y', 0) or 0,
                               x.get('qnBbox', {}).get('x', 0) or 0))
        for i, q in enumerate(qs):
            qb = q.get('qnBbox') or {}
            if not qb.get('h') and not q.get('textBboxes'):
                continue
            xs = [qb.get('x', 0)]
            ys = [qb.get('y', 0)]
            xe = [qb.get('x', 0) + qb.get('w', 0)]
            ye = [qb.get('y', 0) + qb.get('h', 0)]
            for tb in q.get('textBboxes') or []:
                xs.append(tb['x']); ys.append(tb['y'])
                xe.append(tb['x'] + tb['w']); ye.append(tb['y'] + tb['h'])
            # 竖向延伸到同栏下一题号（x 有重叠视为同栏）
            nxt = None
            for j in range(i + 1, len(qs)):
                nb = qs[j].get('qnBbox') or {}
                if not nb.get('h'):
                    continue
                if nb['x'] < xe[0] and nb['x'] + nb['w'] > xs[0]:  # x 有交集
                    nxt = nb
                    break
            if nxt:
                ye.append(nxt['y'] + 2)
            pad = 12
            page_w = q.get('pageWidth') or 0
            x1 = max(0, min(xs) - pad)
            y1 = max(0, min(ys) - pad)
            x2 = max(xe) + pad
            y2 = max(ye) + pad
            if page_w:
                x2 = min(x2, page_w)
            q['bbox'] = {'x': int(x1), 'y': int(y1),
                         'w': int(max(8, x2 - x1)), 'h': int(max(8, y2 - y1))}
            built += 1
    return built


# ═══════════════════════════════════════════════════════════════════════
# L5 校验分层
# ═══════════════════════════════════════════════════════════════════════

def validate_questions(questions: List[Dict]) -> List[Dict]:
    """L5: 置信分层 — low/medium 进复核黄灯，high 自动通过。"""
    issues = []
    nums = sorted(q['questionNumber'] for q in questions if q['questionNumber'])
    for i in range(1, len(nums)):
        gap = nums[i] - nums[i - 1]
        if gap > 30:
            issues.append({'type': 'big_gap', 'from': nums[i - 1], 'to': nums[i]})
    for q in questions:
        if not q['questionNumber']:
            q['confidence'] = 'low'
            issues.append({'type': 'empty_qn', 'page': q.get('pageIndex')})
        elif q.get('_source') == 'ocr-recovered':
            q['confidence'] = 'low'
        elif q.get('_qnCorrected'):
            q['confidence'] = 'medium'
        elif q.get('questionType') in ('choice', 'listening') and not q.get('options'):
            q['confidence'] = 'medium'
    return issues


# ═══════════════════════════════════════════════════════════════════════
# 编排：整卷流水线
# ═══════════════════════════════════════════════════════════════════════

def run_refinement(questions: List[Dict], ocr_items_by_page: Dict[int, List[Dict]]) -> Dict:
    """对 parse_v3_page 的合并结果跑 L1→L5。返回统计。"""
    stats = {}
    stats['qnFixes'] = fix_question_numbers(questions)
    stats['recovered'] = recover_missing_questions(questions, ocr_items_by_page)
    stats['answersAttached'] = attach_student_answers(questions, ocr_items_by_page)
    stats['bboxesBuilt'] = build_question_bboxes(questions)
    # 跨页去重（保留先出现的页；P4 幽灵'1'让位 P1 真Q1）
    seen = set()
    deduped = []
    for q in sorted(questions, key=lambda x: (x.get('pageIndex', 0), x['questionNumber'] or 10**6)):
        n = q['questionNumber']
        if n and n in seen:
            continue
        if n:
            seen.add(n)
        deduped.append(q)
    if len(deduped) != len(questions):
        logger.info("跨页去重: %d → %d", len(questions), len(deduped))
        questions[:] = deduped
    stats['issues'] = validate_questions(questions)
    return stats
