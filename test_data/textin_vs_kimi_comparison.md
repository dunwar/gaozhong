# TextIn OCR (gaozhong 管线) vs Kimi 2.6 Agent OCR — 完整对比报告
**试卷**: 02070f95 (高一英语期中, 6页) | **日期**: 2026-06-21

---

## 核心结论

| 指标 | TextIn + Parser (gaozhong) | Kimi 2.6 Agent |
|:---|:---|:---|
| **OCR 文本清洁度** | ⭐⭐⭐⭐⭐ 文本极干净 | ⭐⭐⭐ 中等 (大量字符级错误) |
| **题目结构解析** | ⭐⭐⭐ 结构化输出但解析错误多 | ⭐ 纯文本无解析 |
| **题目召回率** | **70.5%** (55/78题) | **~100%** (全文本覆盖) |
| **题型分类准确率** | **47%** (26/55) | N/A (不做分类) |
| **假题/虚警** | 14个假题号 | 0 |
| **听力学段覆盖** | ❌ Q1-10 全丢 | ✅ 完整 |
| **完形填空覆盖** | ❌ Q71-84 全丢 | ✅ 文本存在(但未结构化) |

---

## 1. OCR 文本质量 (Raw Text Fidelity)

### Kimi 2.6 Agent 的典型错误:
```
"Inagym"          → 应为 "In a gym"
"regutarly"       → 应为 "regularly"  
"concems"         → 应为 "concerns"
"stiake"          → 应为 "make"
"mire distracting"→ 应为 "more distracting"
"haye"            → 应为 "have"
"ffom"            → 应为 "from"
"sofs"            → 应为 "sort"
```
特征: **单词内部字母错误 + 空格丢失**, 低置信度行([28.0], [30.3])几乎不可读。

### TextIn OCR (xParse):
文本极其干净, 抽样对比未发现同类字符级错误。手写区域单独标注(bounding box + text)。但偶有标点/特殊字符误识别。

**结论: TextIn 的OCR引擎文本质量远优于 Kimi 2.6 Agent。**

---

## 2. 结构感知能力

| 能力 | TextIn | Kimi 2.6 |
|:---|:---|:---|
| 双栏拆分 | xParse 内置 | 显式 Left/Right 标注 |
| 标题层级 | outline_level (Part/Section) | 保留原始标题文本 |
| 置信度标注 | ❌ 无 | ✅ 每行标注 [xx.x] |
| 手写检测 | ✅ bounding box + text | ❌ 无 |
| 题目→选项绑定 | ✅ (parser) | ❌ 纯文本流 |

**结论: Kimi 的置信度标注有独特价值(可用于过滤低质量行), 但 TextIn xParse 的结构化能力更强。**

---

## 3. 题目解析 — TextIn Parser 的致命缺陷

### 3.1 题号错乱 (最严重)
Page 6 的 Q66-Q69 是完形填空选项, 但 parser:
- 将同样的选择题选项(A/B/C/D)同时解析为 Q1-Q5 和 Q66-Q69 → **重复计数**
- Q1-Q5 被错误分类为 `listening`, 实际是 `grammar`

### 3.2 相邻推断泛滥
9个题目被标记为 "[小范围推断] 相邻题号补缺" — 这些是 parser 猜测的题号:
- Q7, Q9, Q10, Q13, Q16, Q38, Q41, Q45, Q47, Q49 (无题干, 纯推断)

### 3.3 Stem/Option 混淆
Q6: questionText = "A.People all over the world had adapted it." — 这实际是**选项**不是题干。

### 3.4 完形填空题号映射完全错误
Page 2 的 Q71-Q84 (Cloze Section A), TextIn parser 输出为 Q1, Q12, Q73-Q79 — 所有题号都映射到了错误的段落。

---

## 4. 覆盖盲区 — 具体缺失

### TextIn 完全丢失的题段:

| 丢失题段 | 题数 | 原因推断 |
|:---|:---|:---|
| **Q1-Q10 听力** (Page 1) | 10 | Parser 将同一页的听力选项和 Q21-24 语法题混淆, 未识别Listening section |
| **Q71-Q84 完形** (Page 2) | 14 | Parser 将 cloze 题号映射到错误的文章段落 |
| **Q52-Q65 语法** (Page 4/6) | 14 | 选词填空(Section B)的题号嵌入文章, parser 无法提取 |
| **Q91** (Page 5) | 1 | 孤立缺失 |

**总计丢失 39/78 题, 直观失分率 50%。**

---

## 5. 与 Kimi 2.6 Agent 的关键差异

### Kimi 2.6 的优势:
1. **全量OCR不漏**: 所有页面所有文字都识别, 不存在"题段丢失"
2. **置信度元数据**: 可用于下游过滤低质量行
3. **专栏感知**: Left/Right 明确分隔
4. **原始文本完整**: 不做解析假设, 不引入 parser 错误

### Kimi 2.6 的劣势:
1. **OCR字符质量差**: 字母级错误频繁(~5-10%行含有错误)
2. **无结构解析**: 纯文本流, 不区分 stem/options/passage
3. **无题号提取**: 需要下游再做一次解析
4. **无手写检测**: 红笔标注完全不可见

### TextIn + Parser 的优势:
1. **OCR文本质量极高**: 几乎无误识
2. **结构化输出**: 题目→选项→文章 绑定
3. **手写区域检测**: 红笔标注坐标
4. **内置标题层级**: outline_level 可用于分区

### TextIn + Parser 的劣势:
1. **Parser 是瓶颈**: 70.5% 召回, 47% 题型准确, 14个假题
2. **大段内容丢失**: 听力全部丢失, 完形几乎全丢
3. **题号映射混乱**: 两套不同的Q1-Q5冲突
4. **相邻推断不可靠**: 9个推断题号无实际题干

---

## 6. 改进建议

| 优先级 | 问题 | 建议 |
|:---|:---|:---|
| 🔴 P0 | Q1-Q10 听力全丢 | Parser 需要识别 Listening Comprehension section 标记 |
| 🔴 P0 | Q71-Q84 完形全丢 | 修复 page/section 题号映射逻辑 |
| 🔴 P0 | 题型准确率 47% | 题型判断需基于 section 标题(非单题推断) |
| 🟡 P1 | 14个假题号 | 关闭 "[小范围推断]" 或加入置信度阈值 |
| 🟡 P1 | Stem/Option 混淆 | 利用 TextIn 的 outline_level 区分题干和选项 |
| 🟢 P2 | 双引擎融合 | Kimi 全文 + TextIn 结构化 = 互补方案 |
