# 探针: 对高一下 P1-P3 原图跑当前 xParse, 检查缺失题号的行是否存在
import sys, re, json
from pathlib import Path

sys.path.insert(0, '.')
from src.textin.client import TextInClient

env = {}
for line in Path('.env').read_text(encoding='utf-8').splitlines():
    if '=' in line and not line.startswith('#'):
        k, _, v = line.partition('=')
        env[k.strip()] = v.strip()

client = TextInClient(env['TEXTIN_APP_ID'], env['TEXTIN_SECRET_CODE'], timeout=120)

WANT = {
    1: list(range(11, 21)),
    2: [22, 23],
    3: [63, 64, 65],
}
FILES = {
    1: r'..\错题\英语试卷高一下\微信图片_20260816120425_25_2.jpg',
    2: r'..\错题\英语试卷高一下\微信图片_20260816120425_26_2.jpg',
    3: r'..\错题\英语试卷高一下\微信图片_20260816120426_27_2.jpg',
}

for pi in (1, 2, 3):
    r = client.parse_document(FILES[pi])
    items = r.raw_json.get('detail', []) if r.success else []
    print(f'P{pi}: items={len(items)} success={r.success}')
    found = {}
    for it in items:
        m = re.match(r'^[A-Za-z]{0,3}\s*(\d{1,3})\s*[.、]', (it.get('text') or '').strip())
        if m and int(m.group(1)) in WANT[pi]:
            found[int(m.group(1))] = (it.get('text') or '')[:44]
    print(f'  目标{WANT[pi]} → 找到: {sorted(found.keys())}')
    for n in sorted(found):
        print(f'    {n}: {found[n]!r}')
    json.dump(items, open(f'D:/Temp/xparse_now_p{pi}.json', 'w', encoding='utf-8'), ensure_ascii=False)
