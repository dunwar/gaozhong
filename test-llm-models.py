#!/usr/bin/env python
"""真实批次大小请求探测：哪个智谱免费模型能吃下大批次解析（顺带验证 passage 提取）。"""
import json
import os
import re
import sys
import time

os.environ['DEEPSEEK_API_URL'] = 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
os.environ['LLM_PARSE_TIMEOUT'] = '300'
_key = re.search(r'^ZHIPU_API_KEY=(.*)$', open('.env', encoding='utf-8').read(), re.M).group(1).strip().strip('"')
os.environ['DEEPSEEK_API_KEY'] = _key

sys.path.insert(0, 'src/textin')
import llm_parser as lp

# 用真实 TextIn detail 构造 P4-P6 批次（112+52+49=213 items，大批次）
pages = []
for i in [4, 5, 6]:
    d = json.load(open(f'test_data/textin_raw_p{i}.json', encoding='utf-8'))
    pages.append(d['detail'])
flat = []
for off, items in enumerate(pages):
    for it in items:
        flat.append((3 + off, it))
formatted = lp._format_section_items(flat)
prompt = lp._build_batch_prompt(3, pages, formatted)
print(f'prompt 大小: {len(prompt)} 字符, {len(flat)} items')

for model in ['glm-4.5-flash', 'glm-4-flash-250414', 'glm-4.6v-flash']:
    lp.LLM_MODEL = model
    t0 = time.time()
    print(f'\n── {model} ──')
    try:
        res = lp._call_llm(prompt, max_tokens=int(os.environ.get('LLM_PARSE_TOKENS_BATCH', '24576')))
        if res is None:
            print('  结果: 失败（见上方日志）')
        else:
            qs = res.get('questions', [])
            with_passage = [q for q in qs if (q.get('passageText') or '').strip()]
            print(f'  结果: {len(qs)} 题, 耗时 {time.time()-t0:.0f}s')
            print(f'  题号: {sorted(q["questionNumber"] for q in qs)[:20]}')
            print(f'  passageText 非空题数: {len(with_passage)}')
            if with_passage:
                p = max(with_passage, key=lambda q: len(q['passageText']))
                print(f'  最长 passage: Q{p["questionNumber"]} {len(p["passageText"])} 字符 | {p["passageText"][:80]}...')
    except Exception as e:
        print(f'  异常: {e}')
    time.sleep(5)
