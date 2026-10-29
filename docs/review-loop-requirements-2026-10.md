# 错题复习闭环 v2 — 需求设计（wrong-notebook 整合）

> 2026-10-30 起草，**2026-10-31 用户批准开工**。来源：wrong-notebook (wttwins v1.9.1) 深度测试结论（见记忆 wrong-notebook-analysis）。
> 原则：**只吸收功能层精华，不引入它的技术栈**。所有需求落在现有 Vue3+Express+sql.js 架构上。
>
> **已拍板决策（2026-10-31）**：①F1 练习生成免费+每日5次（当前用户少先支持，运营数据变化后可改）；②新建用户协议 `/terms` 并在注册页/充值页入口说明"价格根据实际情况调整，已到账点数不受影响"。

---

## 0. 总体规划

**北极星**：补完「周中批作文 / 考后整错题 / **考前出卷子**」月度循环的第三环。
**时间锚点**：上海高中期中考试约 11 月第 2 周（≈11/9-11/13），今天 10-30——**P0 必须在 11/7 前上线**，留一周给真实用户使用 + 一篇"考前出卷子"公众号文章。

| 编号 | 功能 | 优先级 | 工作量 | 依赖 |
|---|---|---|---|---|
| F1 | 同类题练习生成 + 练习卷打印 | **P0** | 2-3 天 | 无 |
| F2 | 错因卡片（mistake_status + 错因前置展示） | **P0** | 0.5 天 | 无 |
| F6 | 打印增强（答案页附解析/知识点开关） | P1 | 0.5 天 | F1（练习卷共用） |
| F3 | 错题数据导出备份 | P1 | 0.5 天 | 无 |
| F5 | PWA（添加到主屏幕） | P1 | 0.5 天 | 无 |
| F4 | 英语知识点标签树细化 + 薄弱点×练习联动 | P2 | 1 天 | F1 上线后 |

**现状核对结论**（2026-10-30 实查代码，需求按真实差距定范围）：
- 错因诊断已存在：`prompts/error-diagnosis.js` 产出 errorType/errorReason/knowledgePoint，但**埋在 correct_solution 字段里，ErrorDetail 页面零展示**（grep 无"错因"）→ F2 是展示层+字段补全，不是新建管线
- 知识点树已存在：`db.js seedKnowledgePoints` 5 学科，英语仅 4 类 16 标签（粒度粗）→ F4 是细化扩充，不是从零建
- PaperExport 已有 订正纸/重做卷 双模式 + 附答案页 + 截图优先 + 掌握度/日期筛选 → F6 仅加两个开关
- 练习生成、数据导出、PWA **完全空白** → F1/F3/F5 是真新建

---

## F1 同类题练习生成 + 练习卷打印【P0】

### 背景
wrong-notebook 实测（50s 出题，定语从句题变式质量好）验证了"从错题生成同类题"的可行性。我们的发布规划里"考前出卷子"一直空缺；期中考后用户有 13-20 道错题，正是出卷素材。wrong-notebook 的 `DEFAULT_SIMILAR_TEMPLATE`（12 变式技法+难度阶梯+语言规则）可直接改写复用。

### 用户故事
- 作为学生：期中考后整完错题，我想针对每道错题练 3 道同类题，考前再打一份"重做卷"自测
- 作为家长：我想知道孩子错的题到底练会没有，用生成的练习卷验证

### 功能需求
**FR1.1 单题生成**：ErrorDetail 页新增「练同类题」按钮 → 生成 3 道同考点变式题（难度=原题持平 1 道 + 略难 1 道 + 略易 1 道）→ 逐题显示题目/答案（折叠）/解析，可逐题"再出一道"
**FR1.2 批量练习卷**：ErrorWorkbook / PaperExport 页新增「生成练习卷」入口：勾选 N 道错题（默认=未掌握）→ 每题生成 1 道同类题 → 组卷 → 进入打印流（复用 PaperExport 模板：题目卷 + 答案页）
**FR1.3 练习记录**：生成的卷可标记"已完成"；页头显示"本次练习覆盖 X 个知识点"
**FR1.4 计费与限流**：**免费**（不扣点），登录用户每日限 5 次生成（单题或组卷各计 1 次），匿名不可用
  - *决策依据：练习是留存闭环的钩子不是收入点；DeepSeek 单次成本≈分钱级。【待运营四问确认，若付费意愿强可改为消耗 0.5 点】*
**FR1.5 埋点**：`trackEvent('practice', 'generate', 来源)` / `('practice', 'print', 卷型)`，对齐现有 13 处埋点

### 技术设计
- **模型**：DeepSeek V4 Pro（复用 `deepseekRequest()`，api-server.js:333），temperature 0.7，max_tokens 3000/题
- **Prompt**：新建 `prompts/practice-v1.js`——以 wrong-notebook 模板为底，改三点：①输出 JSON 数组（我们已有 JSON 修复状态机，不用 XML）②注入学生年级（高一）③英语题干保持英文、解析中文（沿用其语言规则，实测有效）
- **新表**：
  ```sql
  practice_sessions (id, user_id, source_error_ids TEXT/*JSON数组*/, title, status/*generated|done*/,
                    created_at, updated_at)
  practice_items    (id, session_id, source_error_id, question_text, answer_text, analysis,
                    knowledge_point, difficulty/*easy|medium|hard*/, created_at)
  ```
- **新端点**（均需登录）：
  - `POST /api/practice/generate` `{errorIds[], mode:'single'|'paper'}` → 202 + sessionId，入队异步生成（复用现有队列模式），前端轮询
  - `GET  /api/practice/:id` → 卷子内容（生成中/完成/失败态）
  - `POST /api/practice/:id/complete` → 标记完成
  - 每日限流：查 `practice_sessions` 当日该 user 计数 ≥5 → 429
- **前端**：`src/views/PracticeDetail.vue`（新）+ ErrorDetail/ErrorWorkbook 入口按钮；PaperExport 加第三模式「练习卷」（数据源=practice_sessions，模板复用，mode='practice'）
- **失败处理**：单题生成失败不阻塞整卷（该题位显示"生成失败可重试"）；全部失败退回重试入口

### 边界与异常
- 题干为空/乱码的错题（历史数据）→ 生成入口置灰，tooltip"该题文本不完整，先在详情页补全"
- 阅读理解带 passage 的题 → prompt 传入题干+passage 前 300 字符，变式只改题不重写文章
- 生成内容安全：解析中英文混杂按现有论文批改同规范

### 验收标准
1. 挑 10 道真实错题（含选择/填空/阅读），生成 30 题：≥27 题考点一致（人审），≥25 题英文题干语法通顺
2. 3 题组卷→打印预览：题目卷无答案、答案页含答案+解析，分页正确
3. 未登录点击→引导登录；登录用户第 6 次/天→429 提示
4. 埋点在百度统计后台可见 practice/generate 事件

---

## F2 错因卡片【P0】

### 背景
错因诊断数据已在（errorType/errorReason/knowledgeExplanation），但用户看不到。wrong-notebook 的三字段设计（mistake_status 做错了/不会做 + wrong_answer 学生答案 + mistake_analysis 错因）经实测是有价值的展示层。

### 功能需求
**FR2.1 mistake_status 映射**（零新增 AI 成本——confirm 时已有判定证据）：
- 红笔叉/语义判错 → `wrong_attempt`（做错了）
- 确认为错但无笔迹证据 → `not_attempted`（不会做/未作答）
- 证据不明 → `unknown`
**FR2.2 ErrorDetail 页错因卡片**：题干下方常驻卡片：`【做错了】你的答案 C ｜ 正确答案 A ｜ 错因：时态混淆…`（unknown 时只显示"错因待补充"）
**FR2.3 错题本列表角标**：ErrorWorkbook 每题行首加小标签（做错了🔴/不会做🟡），可筛选
**FR2.4 埋点**：`('workbook', 'filter_mistake_status')`

### 技术设计
- `error_problems` 加列：`mistake_status TEXT DEFAULT ''`（一条 ALTER，db.js 启动迁移块）
- 映射时机：api-server confirm 写入 error_problems 处（已有 vlMarks/semanticJudge 数据在 scan_data），一行派生
- wrong_answer/correct_answer 列已存在，直接展示
- ErrorDetail.vue 新增卡片区块；数据不足的存量错题显示占位

### 验收标准
1. 新确认的错题 100% 带 mistake_status；存量错题显示占位不报错
2. 「不会做」筛选在错题本可用且结果正确
3. 全流程无新增 AI 调用（成本零）

---

## F6 打印增强【P1】

- 现状：订正纸/重做卷双模式已有，答案页只有答案
- **FR6.1** 重做卷/练习卷的「附答案页」旁加两个 checkbox：`附解析`、`附知识点`（数据源 correct_solution / knowledge_explanation，已存在）
- **FR6.2** 练习卷（F1）与重做卷共用此逻辑
- 验收：三个开关任意组合打印预览正确；默认只勾"附答案页"（与现行为一致）

## F3 错题数据导出【P1】

- **FR3.1** ErrorWorkbook 设置区「导出备份」按钮 → `GET /api/export`（登录态）→ 下载 JSON：`{version, exportedAt, error_problems[], knowledge_tags[], reviews[], practice_sessions[]}`
- **FR3.2** 文件名 `gaozhong-错题备份-YYYYMMDD.json`；仅导出本人数据
- 背景：家长换机/多设备顾虑 + 数据主权信任（wrong-notebook 有此功能，我们作为收费产品更该有）
- 验收：导出文件可被 json.load；字段含错题全文/标签/掌握态；他人 ID 数据不泄露（越权测试）

## F5 PWA【P1】

- **FR5.1** `public/manifest.webmanifest`（name/short_name/theme_color/icons 192+512）+ index.html `<link>` + apple-touch-icon
- **FR5.2** 不做 Service Worker 离线缓存（避免更新缓存坑，手机加主屏只用 manifest 即可）
- 验收：iOS Safari「添加到主屏幕」出现独立图标与名称，打开无地址栏（standalone）

## F4 英语标签树细化 + 薄弱点×练习联动【P2，期中考后】

- 现状：英语树 4 类 16 标签（时态语态/非谓语动词/从句…），粒度撑不起"连续三次错从句"级洞察
- **FR4.1** 扩充英语树至 ~8 类 45 标签：吸收 wrong-notebook 高中段（从句细分定语/名词性/状语、时态细分八种、完形技巧、听力策略等），**INSERT-only 迁移**（不动存量 16 个，parent_id 挂靠）
- **FR4.2** 打标升级：error-diagnosis prompt 注入候选标签清单（wrong-notebook 的做法，实测它 35/35 学科全对说明清单注入有效），要求从中选择；自由文本→树匹配兜底走现有 `searchKnowledgePoints`
- **FR4.3** KnowledgeMap 薄弱点卡片加「练这一块」按钮 → 直达 F1 组卷（errorIds=该知识点下未掌握错题）
- 验收：新确认错题打标 90%+ 落在树上；KnowledgeMap→练习链路一键可达

---

## 实施顺序与里程碑

```
10-31 ~ 11-01  F1 核心（表/端点/prompt/单题生成）
11-02 ~ 11-03  F1 组卷+打印模式 + F2 错因卡片（半天）
11-04          F6 + F5（各半天）→ 内部验收
11-05 ~ 11-06  真机回归 + 部署 + 公众号《考前出卷子》文章
11-07          期中前就绪 ✅
11-中          期中考 = 错题爆发点（双卷流量）
11-下          F3 导出 → F4 标签树+联动
```

**风险与对策**：
- prompt 出题质量不达验收线 → 预留 11-03 一整天调 prompt（wrong-notebook 模板已含 12 变式技法，起点不低）
- DeepSeek 偶发超时 → 复用现有退避；失败题位可单独重试
- 期中流量把生成队列打满 → 每日 5 次限流 + 队列可见（复用现有排队 UI 模式）
