# 归档文件说明

本目录存放不再使用但保留备查的开发历史文件。

## 归档内容

### 后端备选文件
- `api-server-v2-paper-task.js` — V2 版本的 paper task 实现（备用）
- `replace-execute-paper-task.py` — 函数替换工具脚本（一次性使用）
- `scanner-v1.mjs` — 旧版扫描器 v2.1
- `ocr-extractor.js` — 旧版 OCR 提取器
- `smart-merger.js` — 旧版 OCR+VL 合并器

### 旧版 Prompt（`prompts/`）
- grading-v3/v4 — 已被 grading-v5.js 替代
- paper-analysis-v1/v2/v3 — 已被 paper-analysis-v4.js 替代
- paper-scanner-v4 — 已被 paper-scanner-v5.js 替代
- paper-analyzer-v3 / paper-workbook-scanner — 旧版分析器
- scanner-{chinese,english,math,science}.js — 学科专用 prompt（已整合到 paper-scanner-v5）

### 实验脚本（`scripts/`）
OCR 实验、红色检测实验、假设验证脚本等开发过程中产生的实验性代码。

### 旧测试文件
- `test-scanner-v1.mjs` — 依赖已归档的 scanner-v1.mjs
