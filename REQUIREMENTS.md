# gaozhong.online — 错题整理模块需求文档

> 版本: 1.0 (2026-05-12)
> 定位: 学生电子错题本 — 上传已批改试卷 → AI 识别错题 → 按科目/时间/试卷整理 → 薄弱知识点分析

---

## 1. 产品定位

不做批改。学校/学生自己做批改动作。只做「阅读已有批改标记 → 判定对错 → 整理分析」。

核心价值：帮学生减负提效，把已批改的试卷变成结构化的错题本 + 知识点地图。

---

## 2. 已实现功能

### 2.1 前端页面

| 路由 | 视图 | 功能 | 状态 |
|------|------|------|------|
| `/` | Home.vue | 双模块介绍（作文+错题） | ✅ |
| `/paper/upload` | PaperUpload.vue | 错题上传：科目选择、多文件(≤10)、队列显示 | ✅ |
| `/error/list` | ErrorWorkbook.vue | 错题本：按试卷/时间/科目/列表分组查看 | ✅ |
| `/knowledge` | KnowledgeMap.vue | 知识点：薄弱点TOP、科目分布、搜索 | ✅ |
| `/review/:sessionId` | PaperReview.vue | 试卷回顾：查看整卷分析结果 | ✅ |
| (未挂载) | ErrorDetail.vue | 错题详情 | ⬜ 已有代码，待集成 |
| (未挂载) | ErrorList.vue | 错题列表（旧版） | ⬜ 已有代码，被 ErrorWorkbook 替代 |
| (未挂载) | ErrorUpload.vue | 错题上传（旧版） | ⬜ 已有代码，被 PaperUpload 替代 |
| (未挂载) | KnowledgeDashboard.vue | 知识点看板（旧版） | ⬜ 已有代码，被 KnowledgeMap 替代 |

### 2.2 后端 API（已实现）

```
POST /paper/analyze          — 提交试卷分析（异步队列）
GET  /paper/task/:taskId      — 轮询任务状态
GET  /paper/sessions          — 试卷列表
GET  /paper/:sessionId/review — 查看分析结果
GET  /paper/:sessionId/images/:pageIndex — 试卷原图
GET  /paper/:sessionId/thumb/:pageIndex  — 缩略图

GET  /error/list?view=paper|time|subject|list — 错题列表
GET  /error/:id               — 错题详情
GET  /error/stats             — 错题统计

GET  /knowledge/search        — 知识点搜索
GET  /knowledge/stats         — 知识点统计
```

### 2.3 分析流水线 (Scanner v1.0)

```
阶段0: 预处理（色彩校正 + 红笔分离 opencv）
阶段1: VL 双图单次调用 → 红笔标记检测 + 题目区域识别
阶段2: ImageMagick 裁剪 → 逐题 VL 双图判错
阶段3: DeepSeek 批量分析错题
```

- 科目逻辑文件: `subject-logic/error-identification-logic.md` + `english-shanghai-gaokao.md`
- Prompt 文件: `prompts/paper-workbook-scanner.js`
- 红笔判定规则: 决策树 + 标记分类表
- 支持题型: choice / fill_blank / reading / dictation / translation / writing

### 2.4 导航结构

```
高中在线
├── ✏️ 作文批改
│   ├── 作文批改 → /upload
│   ├── 我的任务 → /tasks
│   └── 历史记录 → /history
└── 📔 错题整理
    ├── 错题上传 → /paper/upload
    ├── 错题本   → /error/list
    └── 知识点   → /knowledge
```

---

## 3. 待完成 / 已知问题

### 3.1 高优先级

| # | 问题 | 说明 |
|---|------|------|
| 1 | **默写题型 bbox 遗漏** | 阶段1 VL 对默写题型检测不全（11道 vs 应有30道）。已加 `dictation` 类型+密集布局提示，R4 测试检测到 38 道，需用户确认实际准确度 |
| 2 | **第2页错题数过度检出** | R4: yingyu33 第1页6道正确，第2页检出30道。需确认是默写真实错误数还是 VL 误判 |
| 3 | **crop 文件命名冲突** | 两页 VL 都从 1 编号 → 第2页覆盖第1页文件。不影响判错，影响前端展示 |
| 4 | **DeepSeek JSON 解析失败** | 当 questionText 为空时，DeepSeek 返回中文抱怨而非 JSON。已有 fallback 占位符 |

### 3.2 中优先级

| # | 问题 | 说明 |
|---|------|------|
| 5 | **科目逻辑文件不支持非高考题型** | 只定义了上海高考 + 少量日常练习类型，需持续补充 |
| 6 | **仅英语科目有逻辑文件** | 语文、数学待添加 `subject-logic/chinese-*.md` `math-*.md` |
| 7 | **PaperReview.vue 前端展示** | 已有试卷回顾页但未完全验证与新流水线的兼容性 |
| 8 | **旧版视图清理** | ErrorDetail/ErrorList/ErrorUpload/KnowledgeDashboard 存在但未挂载路由 |

### 3.3 低优先级

| # | 问题 | 说明 |
|---|------|------|
| 9 | **PDF/Word 上传** | 前端接受 PDF/Word 但后端需要转换层（当前只处理图片） |
| 10 | **并发处理优化** | 当前 VL_SCAN_CONCURRENCY 固定值，可考虑按题目数动态调整 |
| 11 | **API Server 静默崩溃** | 已多次发生，需 systemd 守护（已有 cron 心跳重启但非根治） |

---

## 4. 数据现状

| 指标 | 数值 |
|------|------|
| 错题总数 | 448 |
| 试卷数 | 74 |
| 完成 | 61 |
| 失败 | 13 |

---

## 5. 下一步建议

1. **确认识别准确度**: 用户确认 yingyu33 第2页（默写）的实际错题数，以判断 VL 判错是否准确
2. **补充语文/数学逻辑文件**: 按用户此前优先级「英语→语文→数学」
3. **修复 crop 文件命名**: 改为 `q{pageIndex}_{qnum}` 格式
4. **整合旧版视图**: ErrorDetail 集成到 ErrorWorkbook，清理冗余
5. **API Server 守护**: 添加 systemd service 防崩溃
