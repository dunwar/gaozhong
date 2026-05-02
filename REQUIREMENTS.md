# gaozhong.online - 需求文档 (V2)

> 最后更新: 2026-05-02 | 版本: V2 | 状态: 规划中

## 1. 项目概述

面向高中生的整卷错题分析平台。学生上传整张试卷照片（含批改答案），后台 AI 进行全卷分析，自动生成分科目错题本、薄弱知识点报告和个性化学习指导，形成"诊断→整理→指导→改进"的完整学习闭环。

## 2. 核心功能

### 2.1 用户系统 ✅
- [x] 邮箱+密码注册（默认地区：上海）
- [x] 登录 / JWT 鉴权
- [x] 修改密码（含首次登录强制改密）
- [x] 路由守卫（未登录重定向）
- [x] 管理员功能（查看用户列表）

### 2.2 AI 作文批改 ✅
- [x] 五维评分（内容/结构/语言/逻辑/创意，各 20 分，满分 100）
- [x] OCR 识别手写作文（DashScope qwen-vl-plus）
- [x] DeepSeek V4 Pro AI 评分 + 评语 + 修改建议
- [x] 整体评价 + 字数统计
- [x] 异步任务队列（并发上限 3）
- [x] 批改历史（登录用户/游客双模式）

### 2.3 错题上传（原"错题诊断"，V2 重做）🔄
**场景**：学生当天做完试卷后，一次性上传整张试卷照片（含批改答案），后台 AI 全卷分析。

- [ ] 页面重做：`ErrorUpload.vue`，支持多张试卷图片同时上传
- [ ] 学科选择：数学 / 物理 / 化学 / 生物 / 英语 / 语文
- [ ] 支持一次性提交多张试卷，逐张进入后台队列处理
- [ ] 队列复用现有 `errorQueue`，前端轮询全部任务进度
- [ ] 显示"X/Y 张已分析完成"进度
- [ ] 可选填试卷名称（如"2024 上海一模数学"）
- [ ] 保留手动逐题录入作为兜底入口（不删）

### 2.4 AI 整卷分析 Prompt ✅
- [x] 新建 `prompts/paper-analysis-v1.js`（初始版本）
- [x] 新建 `prompts/paper-analysis-v2.js`（v2 增强：批改标记识别规则）
- [x] 单 Prompt 模板 + 各学科差异化分析指令（模板变量 `{subject}` `{ocrText}`）
- [x] 输入：整张试卷 OCR 文本 + 学科
- [x] 输出：结构化 JSON（每道错题：题目/学生答案/错误类型/原因/正确解法/知识点 + gradingEvidence）
- [x] 版本管理模式参考 `prompts/grading-v5.js`
- [x] v2 新增：8 种批改标记含义速查表、判断优先级、6 种歧义场景处理、分学科特殊约定
- [x] OCR 指令增强：区分教师红笔批改和学生笔迹

### 2.5 错题本（V2 重构）🔄
支持**三种分组视图**，用户可切换：

| 视图 | 分组依据 | 使用场景 |
|------|---------|---------|
| 📄 按试卷 | 每次上传的试卷 | 查看某次考试错题详情 |
| 📅 按时间 | 本月 / 本学期 / 本学年 | 阶段性复习 |
| 📚 按科目 | 学科分类 | 单科专项突破 |

每种视图下展示：错题数量、错误类型分布、涉及知识点数量。

- [ ] 重构 `ErrorList.vue`，实现三视图切换
- [ ] 保留 `ErrorDetail.vue` 错题详情页

### 2.6 AI 学习指导 🆕
- [ ] 新建 `prompts/study-guidance-v1.js`
- [ ] 输入：科目 + 时间范围 + 该范围内所有错题
- [ ] 输出：学习状态评估 + 薄弱知识模块 + 优先级排序 + 具体学习建议
- [ ] 新增 API：`POST /paper/guidance`（异步任务）
- [ ] 前端入口：知识点仪表盘或错题本的"AI 分析"按钮
- [ ] 默认时间范围：本学期开始至今

### 2.7 知识点仪表盘 🔄
- [x] 基础仪表盘（错题总览 + 学科分布 + 错误类型分布 + Top 薄弱点）
- [ ] V2 增强：增加"最近试卷"维度、数据来源改为整卷分析结果

## 3. 学科支持（V2 扩展）

| 学科 | 状态 |
|------|:---:|
| 数学 | ✅ |
| 物理 | ✅ |
| 化学 | ✅ |
| 英语 | ✅ |
| 语文 | ✅ |
| 生物 | 🆕 |

## 4. 数据库变更（V2）

```sql
-- 新增：试卷会话表
CREATE TABLE paper_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  title TEXT,              -- 用户可选填试卷名
  image_count INTEGER,    -- 上传图片数
  status TEXT DEFAULT 'pending',  -- pending/processing/done/error
  created_at TEXT DEFAULT (datetime('now'))
);

-- 修改：错题表新增关联字段
ALTER TABLE error_problems ADD COLUMN session_id INTEGER REFERENCES paper_sessions(id);
ALTER TABLE error_problems ADD COLUMN paper_index INTEGER;  -- 同一 session 内的第几张卷子
```

## 5. API 变更（V2）

| 端点 | 方法 | 说明 | 状态 |
|------|------|------|:---:|
| `POST /paper/analyze` | POST | 接收图片 base64，OCR → AI 分析 → 写入错题 | 🆕 |
| `POST /paper/guidance` | POST | AI 学习指导（科目+时间范围） | 🆕 |
| `GET /paper/sessions` | GET | 用户试卷会话列表 | 🆕 |
| `GET /errors?view=paper\|time\|subject` | GET | 错题列表（支持三视图分组） | 🔄 |
| 现有作文批改 API | - | 不变 | ✅ |

## 6. 路由规划（V2）

| 路径 | 页面 | 变更 |
|------|------|:---:|
| `/error-upload` | 错题上传（原"错题诊断"） | 🔄 重做 |
| `/errors` | 错题本（三视图） | 🔄 重构 |
| `/error/:id` | 错题详情 | ✅ 保留 |
| `/knowledge` | 知识点仪表盘 | 🔄 增强 |
| `/essay` | 作文批改 | ✅ 保留 |

## 7. 技术架构

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| 前端 | Vue 3 + Vite | SPA，部署为静态文件 |
| 后端 API | Node.js (原生 http) | 端口 3001 |
| 数据库 | SQLite (better-sqlite3) | 挂载卷持久化 |
| 鉴权 | JWT (jsonwebtoken + bcrypt) | 7 天过期 |
| AI 分析 | DeepSeek V4 Pro | 整卷分析 + 错题诊断 + 学习指导 |
| OCR | DashScope qwen-vl-plus | 试卷图片识别 |
| 网关 | Nginx (宿主机) | 反向代理 + 静态文件服务 |

## 8. 实施顺序（V2）

| 步骤 | 内容 |
|:---:|------|
| 1 | Prompt: `paper-analysis-v1.js`（六科差异化指令） |
| 2 | Prompt: `study-guidance-v1.js` |
| 3 | 数据库：`paper_sessions` 表 + `error_problems` 改表 |
| 4 | API: `/paper/analyze`、`/paper/guidance`、列表接口调整 |
| 5 | 前端：错题上传页（多图 + 队列轮询） |
| 6 | 前端：错题本（三种分组视图） |
| 7 | 前端：AI 学习指导模块 |
| 8 | 构建部署 + 测试 |

## 9. 变更记录

| 日期 | 变更 | 状态 |
|------|------|------|
| 2026-04-27 | 项目启动，选型 Vue 3 + Node.js | ✅ |
| 2026-05-01 | Part 1 部署 + 用户管理系统 | ✅ |
| 2026-05-01 | Part 2 SQLite 持久化 | ✅ |
| 2026-05-01 | Prompt v5 优化 | ✅ |
| 2026-05-02 | Phase A-C 错题诊断核心功能 (V1) | ✅ |
| 2026-05-02 | V2 需求确认：整卷错题上传 + 三视图错题本 + AI 学习指导 | ✅ |
