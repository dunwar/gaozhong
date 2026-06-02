# gaozhong.online — 项目需求文档

> 版本: 2.2 (2026-06-02)
> 定位: 高中生学习分析平台 — 上传已批改试卷 → AI 识别错题 → 分科错题本 + 薄弱知识点分析
> 代码仓库: git@github.com:dunwar/gaozhong.git
> 在线地址: https://gaozhong.online

---

## 📖 给新 AI 接手前的速览

### 这个项目是做什么的？

高中生把老师已批改过的试卷拍照上传 → 系统自动识别红笔批改标记 → 判定每道题对错 → 整理成结构化错题本 → 生成薄弱知识点分析报告。

**不负责批改。** 批改由学校老师/学生互批完成。系统只「阅读批改标记 → 整理分析」。

### 技术栈一句话

Vue 3 (Vite + Tailwind) 前端 + Node.js (Express) API Server + Python Flask OpenCV 预处理 + SQLite (sql.js) 数据库，部署在腾讯云 Docker 容器内。

### 核心流水线（Scanner v4.2）

```
用户上传试卷图片
  ↓
Phase 0: Python Flask 预处理（色彩校正 + HSV红笔分离 + 去红 inpainting）
  ↓           ↓
去红图（OCR用）  红笔突出图（判错用）
  ↓           ↓
Phase 1: Zhipu glm-4.6v-flash / Kimi k2.6 VL OCR（双栏感知 + passage 提取）
  ↓           ↓
Phase 2: Zhipu DirectJudge 端到端双图判错（主路径）
  │  失败 → Phase 2b: VL 红笔分类 + 质心匹配（fallback）
  ↓
Phase 3: DeepSeek V4 Pro 批量分析 — 错题归类 + 知识点归因 + 薄弱点分析
```

---

## 1. 项目结构

```
gaozhong.online/
├── .env                          ← 环境变量（API Key，不入 git）
├── .env.example                  ← 环境变量模板
├── package.json                  ← 项目依赖（Vue3/Vite/Tailwind/Express/sql.js）
├── vite.config.js                ← Vite 构建配置
├── index.html                    ← HTML 入口
│
├── src/                          ← 前端源码
│   ├── main.js                   ← 入口
│   ├── App.vue                   ← 根组件
│   ├── style.css                 ← 全局样式（Tailwind）
│   ├── components/               ← 通用组件
│   │   ├── Header.vue            ← 导航栏
│   │   ├── Footer.vue            ← 页脚
│   │   ├── UploadArea.vue        ← 上传区域
│   │   └── EssayGradingResult.jsx ← 作文批改结果
│   ├── views/                    ← 页面视图
│   │   ├── Home.vue              ← 首页（双模块入口）
│   │   ├── PaperUpload.vue       ← 错题上传页 ✅
│   │   ├── PaperReview.vue       ← 试卷回顾（三面板布局）✅
│   │   ├── PaperConfirm.vue      ← 确认页
│   │   ├── PaperErrors.vue       ← 错题页
│   │   ├── ErrorWorkbook.vue     ← 错题本主页 ✅
│   │   ├── ErrorDetail.vue       ← 错题详情 ✅
│   │   ├── KnowledgeMap.vue      ← 知识点地图 ✅
│   │   ├── Upload.vue            ← 作文上传
│   │   ├── Result.vue            ← 作文结果
│   │   ├── Tasks.vue             ← 任务列表
│   │   ├── History.vue           ← 历史记录
│   │   ├── Login.vue             ← 登录
│   │   ├── Register.vue          ← 注册
│   │   ├── Password.vue          ← 密码
│   │   ├── ErrorList.vue         ← 错题列表（旧版，被替换）
│   │   ├── ErrorUpload.vue       ← 错题上传（旧版，被替换）
│   │   └── KnowledgeDashboard.vue ← 知识点看板（旧版，被替换）
│   ├── router/index.js           ← Vue Router 路由配置
│   ├── utils/                    ← 工具模块
│   │   ├── authStore.js          ← 认证状态
│   │   ├── taskStore.js          ← 任务状态
│   │   └── paperTaskPoller.js    ← 异步任务轮询
│   └── assets/                   ← 静态资源
│
├── api-server.js                 ← API 服务主文件（~2500行，核心后端）
├── api-server-v2-paper-task.js   ← V2 版本（备用）
├── db.js                         ← SQLite 数据库模块（sql.js WASM）
│
├── scanner-v3.mjs                ← 扫描器主模块（当前 v4.2）
│
├── prompts/                      ← AI Prompt 模板
│   ├── paper-workbook-scanner.js ← 错题整理扫描器 Prompt
│   ├── paper-scanner-v5.js       ← 双图增强版扫描 Prompt
│   ├── paper-analysis-v[1-4].js  ← 各版分析 Prompt
│   ├── paper-analyzer-v3.js      ← 分析器
│   ├── error-diagnosis.js        ← 错题诊断 Prompt
│   ├── grading-v[3-5].js         ← 作文评分 Prompt（v5 当前）
│   ├── scanner-english.js        ← 英语科目逻辑
│   ├── scanner-chinese.js        ← 语文科目逻辑
│   ├── scanner-math.js           ← 数学科目逻辑
│   ├── scanner-science.js        ← 理综科目逻辑
│   └── study-guidance-v1.js      ← 学习指导 Prompt
│
├── subject-logic/                ← 科目特定逻辑
│   ├── error-identification-logic.md  ← 错题判定决策树 v3.0
│   └── english-shanghai-gaokao.md     ← 上海高考英语题型定义
│
├── preprocess-server.py          ← Python Flask 预处理服务（OpenCV 红笔分离）→ 端口 5002
├── scripts/                      ← 工具脚本
│   ├── ocr-page.py               ← VL OCR 单页提取（Kimi k2.6）
│   ├── ocr-page-paddle.py        ← PaddleOCR 备用通道
│   ├── ocr-tencent.py            ← 腾讯云 OCR 备用通道
│   └── ...（测试脚本）
│
├── data/                         ← 运行时数据
│   └── grading.db                ← SQLite 数据库文件
│
├── dist/                         ← 构建输出（部署到生产目录）
├── output/                       ← 调试/测试输出（不入 git）
│
├── deploy.sh                     ← 一键部署脚本
├── deploy-host.sh                ← 宿主机部署
├── deploy-daemon.sh              ← 守护进程部署
├── deploy-api.sh                 ← API 服务单独部署
├── start-preprocess.sh           ← 预处理服务启动脚本
│
├── docs/
│   └── pipeline-analysis.md      ← 流水线分析文档
│
├── README.md                     ← 项目说明
├── HARNESS.md                    ← AI 测试工具说明
├── METHODOLOGY.md                ← 开发方法论
└── REQUIREMENTS.md               ← 本文件
```

---

## 2. 核心功能 & 状态

### 2.1 前端页面

| 路由 | 视图 | 功能 | 状态 |
|------|------|------|------|
| `/` | Home.vue | 首页：作文批改 + 错题整理双模块入口 | ✅ |
| `/paper/upload` | PaperUpload.vue | 错题上传：科目选择、多文件(≤10)、队列 | ✅ |
| `/paper/confirm/:id` | PaperConfirm.vue | 试卷确认 | ✅ |
| `/paper/:id/errors` | PaperErrors.vue | 试卷错题 | ✅ |
| `/paper/review/:id` | PaperReview.vue | 试卷回顾：三面板（原图+文字题+错题清单）| ✅ |
| `/error/list` | ErrorWorkbook.vue | 错题本：按试卷/时间/科目/列表分组 | ✅ |
| `/error/:id` | ErrorDetail.vue | 错题详情 | ✅ |
| `/knowledge` | KnowledgeMap.vue | 知识点：薄弱TOP、科目分布、搜索 | ✅ |
| `/upload` | Upload.vue | 作文上传 | ✅ |
| `/result/:id` | Result.vue | 作文结果 | ✅ |
| `/tasks` | Tasks.vue | 我的任务 | ✅ |
| `/history` | History.vue | 历史记录 | ✅ |
| `/login` | Login.vue | 登录 | ✅ |
| `/register` | Register.vue | 注册 | ✅ |
| `/password` | Password.vue | 密码修改 | ✅ |

### 2.2 后端 API

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

POST /grading/submit          — 提交作文批改
GET  /grading/status/:taskId  — 批改状态
GET  /grading/result/:taskId  — 批改结果
GET  /grading/history         — 批改历史
```

### 2.3 模型分工

| 任务 | 模型 | Provider | 说明 |
|------|------|----------|------|
| VL OCR（图片识别） | `kimi-k2.6` / `glm-4.6v-flash` | 阿里云百炼 / 智谱 | 印刷体识别、题目结构提取 |
| DirectJudge（端到端判错） | `glm-4.6v-flash` | 智谱 | 双图（原图+红笔图）一次完成 OCR + 判错 |
| 红笔标记分类 | `glm-4.6v-flash` / `kimi-k2.6` | 智谱 / 阿里云百炼 | VL 识别红笔标记类型（✗/✓/字母/圈/划线/注释）|
| 文本分析（知识点归因） | `deepseek-v4-pro` | DeepSeek | 错题知识点归因、薄弱分析、学习指导 |
| 预处理（OpenCV） | Python Flask | 本地 5002 端口 | 矫正、HSV 红笔分离、去红 inpainting（v8.1）|

**⚠️ OpenClaw Gateway HTTP API 不支持多模态（图片会被静默丢弃），所有 VL/OCR 任务必须直连模型 API。**

### 2.4 服务端口

| 端口 | 服务 | 版本 | 守护方式 |
|------|------|------|---------|
| 3001 | Node.js API Server | v2.0-async, Scanner v4.2 | cron 心跳 + 自动重启 |
| 5002 | Python Flask 预处理 | v8.1 | cron 15min 巡检（preprocess-guard）|

### 2.5 批改标记模式

| 模式 | 值 | 场景 | 判定逻辑 |
|------|-----|------|----------|
| 红笔勾叉 | `check_cross` | 老师只打 ✓✗，不写答案 | ✗=错题，✓=对题 |
| 红笔标注 | `annotation` | 老师红笔写正确答案/批注 | AI 识别红笔标注内容判定 |
| 混合模式 | `mixed` | ✓✗ + 红笔标注混合 | AI 综合判断勾叉+标注 |

### 2.6 Scanner v4.2 新增功能

| 功能 | 版本 | 说明 |
|------|------|------|
| **去红处理 (De-red)** | v4.2 | OCR 前用 cv2.inpaint 擦除原图中红笔墨水，避免红线穿字导致 OCR 错误 |
| **双栏感知 OCR** | v4.2 | VLM prompt 增加版面分析步骤（先识别单/双栏，再逐栏读取）|
| **Passage 提取** | v4.2 | 阅读理解文章通过 passages 数组独立提取，passageRef 链接题目 |
| **DirectJudge 升级** | v4.2 | 端到端判错 prompt 增强：10 种标记分类表 + 逐题判定流程 + 强制自检 |
| **Zhipu VL 通道** | v4.1/v4.2 | 新增智谱 glm-4.6v-flash 作为 OCR + DirectJudge + 红笔分类的主力模型 |

---

## 3. 数据库设计

使用 SQLite (sql.js WASM)，数据文件 `data/grading.db`。核心表：

- `users` — 用户（邮箱+密码哈希）
- `paper_sessions` — 试卷会话（含 scan_data, ai_raw）
- `error_problems` — 识别出的错题
- `knowledge_points` — 知识点
- `error_knowledge_tags` — 错题-知识点关联
- `grading_records` — 作文批改记录
- `error_reviews` — 错题复核记录

---

## 4. 部署流程

### 4.1 ⚠️ 双目录结构（最容易出错的点）

| 角色 | 容器内路径 | 用途 |
|------|-----------|------|
| **开发目录** | `/home/node/.openclaw/workspace/www/gaozhong.online/` | Git 同步、编码 |
| **生产目录** | `/app/data/www/gaozhong.online/` | Nginx 静态文件、API Server 运行 |

**规则：** 改代码只改开发目录 → 复制到生产目录 → scanner 动态 import 即时生效，无需重启 API Server。

### 4.2 部署命令

```bash
# 只改 scanner/preprocess/python 代码（动态 import，无需重启）
cp ~/.openclaw/workspace/www/gaozhong.online/scanner-v3.mjs /app/data/www/gaozhong.online/
cp ~/.openclaw/workspace/www/gaozhong.online/preprocess-server.py /app/data/www/gaozhong.online/
bash /app/data/start-preprocess.sh  # 重启预处理服务

# 改 api-server.js 或前端代码（需要完整部署）
cd /home/node/.openclaw/workspace/www/gaozhong.online/
./deploy.sh    # 构建前端 + 复制 dist + 重启 API Server
```

用户还需在宿主机执行：`sudo nginx -s reload`

### 4.3 Git 提交规范

- 每完成一个子任务 → commit（5-15 分钟粒度）
- 格式：`type: 描述`（feat/fix/docs/style/refactor/deploy）
- Commit 后 push 到 `git@github.com:dunwar/gaozhong.git`

---

## 5. 已知问题 & 待完成

### 5.1 高优先级

| # | 问题 | 详情 |
|---|------|------|
| 1 | **Preprocess 周期性崩溃** | gunicorn worker 达到 max-requests=100 后 master 也退出，约每 2h 一次。cron guard 15min 巡检自动恢复，非根治 |
| 2 | **GitHub Push 被密钥检测阻挡** | 旧 commit df5368e/00f1731 含腾讯云 Secret ID，需去 GitHub 安全页面解除或清理历史 |
| 3 | **默写题型 bbox 遗漏** | VL 对默写题型检测不全，已优化 prompt 但未完全验证 |
| 4 | **DeepSeek JSON 解析失败** | questionText 为空时 DeepSeek 返回中文抱怨而非 JSON，已有 fallback |

### 5.2 中优先级

| # | 问题 | 详情 |
|---|------|------|
| 5 | **仅英语科目有逻辑文件** | subject-logic/ 下只有英语，语文/数学待添加 |
| 6 | **旧版组件清理** | ErrorList/ErrorUpload/KnowledgeDashboard 存在但路由指向新版 |
| 7 | **并发优化** | VL_CONCURRENCY 固定值，可动态调整 |

### 5.3 功能规划

| # | 功能 | 详情 |
|---|------|------|
| 8 | **整卷分析异步化** | 减少用户等待时间 |
| 9 | **PDF/Word 支持** | 前端接受但后端需转换层 |
| 10 | **HTTPS 配置** | Let's Encrypt 证书 |
| 11 | **Preprocess systemd 守护** | 根治周期性崩溃问题 |

---

## 6. 关键决策记录

| 日期 | 决策 |
|------|------|
| 2026-04-27 | 选定方案 B：阿里云百炼 qwen 系列模型 |
| 2026-04-28 | 确立作文批改 Prompt 规范 |
| 2026-04-29 | 六条核心工程原则 |
| 2026-04-30 | v5 prompt 效果最优；默认模型切 DeepSeek V4 Pro |
| 2026-05-02 | 产品定位：从"作文批改工具"→"整卷学习分析平台" |
| 2026-05-03 | 错题识别优化：修正 RGB→BGR、题号去重、无题干过滤；耗时 190s→90s |
| 2026-05-04 | OCR 切换至 Kimi k2.6（直连阿里云百炼，不走 Gateway）|
| 2026-05-12 | Scanner v3.x — VL 红笔分类替代盲阈值；连通域质心匹配 |
| 2026-05-23 | 发现双目录分叉问题：生产版 PaperReview（692行三面板）比 workspace（484行两面板）更新 |
| 2026-05-24 | Scanner v4.0 — 放弃多轮VL，改为 per-page parallel + retry |
| 2026-05-26 | Preprocess v8.0 — gunicorn 守护 + 2 workers，修复 ~8h 挂起问题 |
| 2026-05-31 | 更新 REQUIREMENTS.md v2.0 + Zhipu VL (glm-4.6v-flash) 集成 |
| **2026-06-02** | **Scanner v4.2 — 三大改进：去红预处理 + 双栏感知 OCR prompt + DirectJudge 升级** |

---

## 7. 协同开发注意事项

1. **修改前先对比生产目录**：`diff -rq ~/workspace/www/gaozhong.online/ /app/data/www/gaozhong.online/`
2. **生产是权威**：如果生产版本比 workspace 新 → 先同步到 workspace 并 commit
3. **不改环境配置**：openclaw.json、模型配置等未经用户同意不得修改
4. **Scanner 动态 import**：`scanner-v3.mjs` 通过 `await import()` 加载，代码改动即时生效，无需重启 API Server
5. **Prompt 改动慎重**：所有 prompt 文件经多轮迭代验证，改动需先出方案再确认
6. **不要走 Gateway 做 VL**：图片识别必须直连模型 API（阿里云百炼 / 智谱）
7. **Preprocess 崩溃是已知问题**：每 2h 自动重启，guard cron 每 15min 保底，不需要人工干预

---

_本文档由 AI 助手维护，任何模型接手前应完整阅读此文件 + server-environment.md_
