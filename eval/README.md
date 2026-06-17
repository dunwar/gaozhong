# eval/ — Scanner 评测体系

量化驱动迭代：每次改 prompt/逻辑前跑评测，改完再跑，用数字说话。

## 用法

```bash
cd ~/workspace/www/gaozhong.online

# 完整流程：扫描 + 对比 ground truth
node eval/evaluate.mjs --paper <paperId>

# 只跑扫描（保存结果，不对比）
node eval/evaluate.mjs --paper <paperId> --scan-only

# 只对比（用上次扫描结果 vs ground truth）
node eval/evaluate.mjs --paper <paperId> --compare-only

# JSON 输出（方便程序处理）
node eval/evaluate.mjs --paper <paperId> --compare-only --json
```

## 目录结构

```
eval/
├── README.md              ← 本文件
├── evaluate.mjs           ← 评测脚本
├── ground-truth/          ← 手工标注的正确答案
│   └── <paperId>.json     ← 每份试卷一个
└── results/               ← 自动生成的扫描结果和指标
    ├── <paperId>-scan.json
    └── <paperId>-metrics.json
```

## Ground Truth 格式

```json
{
  "paperId": "02070f95",
  "subject": "英语",
  "pages": 6,
  "verified": true,
  "questions": [
    {
      "questionNumber": 11,
      "pageIndex": 1,
      "questionType": "choice",
      "isError": false
    }
  ]
}
```

- `verified`: 必须人工核对图片后设为 `true`
- `isError`: 红笔标记判断为错题 → `true`

## 评测指标

| 指标 | 含义 |
|------|------|
| Question Recall | GT 题目被识别出的比例 |
| Question Precision | 扫描结果中真实存在的比例（排除幻觉） |
| Error Precision/Recall/F1 | 红笔判错的准确性 |
| Type Accuracy | 题型分类正确率 |
| Page Accuracy | 题号归属页面正确率 |
| Overall Score | 三项核心指标的均值 |

## 工作流

1. **选试卷** → 从 `/app/data/papers/` 挑一份有代表性的
2. **标注 GT** → 对照图片手写 ground truth JSON
3. **跑基线** → `node eval/evaluate.mjs --paper <id>` 得到当前分数
4. **改代码** → 修 prompt / 修逻辑
5. **重跑评测** → 对比改进幅度
6. **循环 4-5** → 直到达标
