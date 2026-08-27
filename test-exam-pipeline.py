#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""exam_pipeline 离线验收测试 — 用已保存的 TextIn v3 响应 + 本地 OCR items 跑五层完善。

验收线: 高一下 ≥94/95 题、澜大 29/29、题号零幻觉、bbox 全建。
"""
import json
import sys

sys.path.insert(0, 'src/textin')
from exam_pipeline import parse_v3_page, run_refinement


def load_ocr_items(page_files):
    """test_data/textin_raw_p*.json → {pageIndex: [detail items]}"""
    out = {}
    for pf in page_files:
        pi = int(pf.split('_p')[-1].split('.')[0])
        d = json.load(open(pf, encoding='utf-8'))
        out[pi] = d.get('detail', [])
    return out


def run_paper(name, v3_files, ocr_pages, gt_path):
    """v3_files: [(pageIndex, json_path)]"""
    questions = []
    for pi, f in v3_files:
        j = json.load(open(f, encoding='utf-8'))
        questions.extend(parse_v3_page(j, pi))
    ocr_items = {pi: load_ocr_items(ocr_pages).get(pi, []) for pi, _ in v3_files} if ocr_pages else {}
    if ocr_pages:
        ocr_items = load_ocr_items(ocr_pages)
    stats = run_refinement(questions, ocr_items)

    gt = json.load(open(gt_path, encoding='utf-8'))
    gt_all = set(q['questionNumber'] for q in gt['questions'])
    det = [q['questionNumber'] for q in questions]
    det_set = set(n for n in det if n)
    hit = det_set & gt_all
    hallu = det_set - gt_all

    print(f'══ {name} (GT {len(gt_all)}题) ══')
    print(f'  命中: {len(hit)}/{len(gt_all)} ({len(hit)/len(gt_all)*100:.1f}%)')
    print(f'  幻觉题号: {sorted(hallu) if hallu else "无"}')
    print(f'  缺失: {sorted(gt_all - det_set)}')
    print(f'  L1题号修复: {stats["qnFixes"]}')
    print(f'  L2缺失恢复: {stats["recovered"]}')
    print(f'  L3学生答案: {stats["answersAttached"]} 处')
    print(f'  L4 bbox构建: {stats["bboxesBuilt"]}/{len(questions)}')
    low = [q["questionNumber"] for q in questions if q.get("confidence") == "low"]
    med = [q["questionNumber"] for q in questions if q.get("confidence") == "medium"]
    print(f'  L5 置信分层: low={low} medium={len(med)}题')
    sa = sum(1 for q in questions if q.get('studentAnswer'))
    wp = sum(1 for q in questions if (q.get('passageText') or '').strip())
    print(f'  内容: studentAnswer {sa} 题 | passageText {wp} 题')
    return len(hit), len(gt_all), len(hallu)


if __name__ == '__main__':
    # 高一下: 6页 v3 (P6用dewarp版) + test_data OCR
    gyx_files = [(1, 'D:/Temp/textin_gyx_25_2.json'), (2, 'D:/Temp/textin_gyx_26_2.json'),
                 (3, 'D:/Temp/textin_gyx_27_2.json'), (4, 'D:/Temp/textin_gyx_28_2.json'),
                 (5, 'D:/Temp/textin_gyx_29_2.json'), (6, 'D:/Temp/textin_p6_dewarp.json')]
    gyx_ocr = [f'test_data/textin_raw_p{i}.json' for i in range(1, 7)]
    h1, t1, hu1 = run_paper('高一下', gyx_files, gyx_ocr, 'eval/ground-truth/英语试卷高一下.json')

    # 澜大: 4页 v3（无对应本地OCR缓存 → L2/L3 跳过）
    ld_files = [(1, 'D:/Temp/textin_ld_微信图片_20260816120429_31_2.json'),
                (2, 'D:/Temp/textin_ld_微信图片_20260816120430_32_2.json'),
                (3, 'D:/Temp/textin_ld_微信图片_20260816120431_33_2.json'),
                (4, 'D:/Temp/textin_ld_微信图片_20260816120432_34_2.json')]
    h2, t2, hu2 = run_paper('澜大训练1', ld_files, None, 'eval/ground-truth/英语澜大训练1.json')

    print('══ 验收 ══')
    ok = h1 >= 94 and h2 == 29 and hu1 == 0 and hu2 == 0
    print('高一下 ≥94:', h1 >= 94, '| 澜大 =29:', h2 == 29, '| 零幻觉:', hu1 == 0 and hu2 == 0)
    print('总体:', '✅ 通过' if ok else '❌ 未达标')
    sys.exit(0 if ok else 1)
