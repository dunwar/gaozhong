# gaozhong.online — 项目需求与部署文档

> 版本: 3.0 (2026-06-13)
> 定位: 高中生学习分析平台 — 上传已批改试卷 → AI 识别错题 → 分科错题本 + 薄弱知识点分析
> 代码仓库: git@github.com:dunwar/gaozhong.git
> 在线地址: https://gaozhong.online
> Scanner: v4.5 | 预处理: v8.3

---

## 📖 给新 AI 接手前的速览

### 这个项目是做什么的？

高中生把老师已批改过的试卷拍照上传 → 系统自动识别红笔批改标记 → 判定每道题对错 → 整理成结构化错题本 → 生成薄弱知识点分析报告。

**不负责批改。** 批改由学校老师/学生互批完成。系统只「阅读批改标记 → 整理分析」。

### 技术栈一句话

Vue 3 (Vite + Tailwind) 前端 + Node.js (Express) API Server + Python Flask OpenCV 预处理 + SQLite (sql.js) 数据库，部署在腾讯云 Docker 容器内。**新增 TextIn API（合合信息商用 OCR）作为主 OCR 引擎。**

### 核心流水线（Scanner v4.5）

```
用户上传试卷照片
  ↓
Phase 0.5: /prepare-pages — 裁切背景 + 自动旋转 + 双页水平分割 + 页面排序
  ↓
Phase 0: Python Flask 预处理（色彩校正 + HSV红笔分离 + 去红 inpainting）
  ↓           ↓
去红图（OCR用）  红笔突出图（判错用）
  ↓
Phase 1: ★TextIn xParse OCR（主引擎，99.7%准确率）→ 11阶段题目解析
  │  失败 → 回退: Zhipu glm-4.6v-flash VL OCR → Kimi k2.6 → Tencent OCR
  ↓
Phase 2: VL 红笔分类 + TextIn 手写区域交叉验证 + 质心匹配
  │  红笔质心 ←交叉验证→ TextIn 手写区域坐标 → 增强错题判定
  ↓
Phase 3: DeepSeek V4 Pro 批量分析 — 错题归类 + 知识点归因 + 薄弱点分析
  ↓
PaperReview.vue 三栏审核界面 — 人工确认/拒绝
```

---

## 1. 项目结构

```
gaozhong.online/
├── .env                          ← 环境变量（API Key，不入 git）
├── .env.example                  ← 环境变量模板（含 TextIn 配置）
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
│   │   └── UploadArea.vue        ← 上传区域
│   ├── views/                    ← 页面视图（14个活跃页面）
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
│   │   └── Password.vue          ← 密码
│   ├── router/index.js           ← Vue Router 路由配置
│   └── utils/                    ← 工具模块
│       ├── authStore.js          ← 认证状态
│       ├── paperStore.js         ← 试卷任务状态
│       ├── taskStore.js          ← 作文任务状态
│       └── paperTaskPoller.js    ← 异步任务轮询
│
├── api-server.js                 ← API 服务主文件（~2500行，核心后端）
├── db.js                         ← SQLite 数据库模块（sql.js WASM）
│
├── scanner-v3.mjs                ← 扫描器主模块（当前 v4.5，~1700行）
│
├── src/textin/                   ← ★ TextIn OCR 集成模块（Python）
│   ├── __init__.py               ← 模块入口
│   ├── client.py                 ← TextIn API 客户端（擦除/OCR/xParse）
│   └── parser.py                 ← 11阶段题目解析 + 连续性推断
│
├── prompts/                      ← AI Prompt 模板（5个活跃版本）
│   ├── paper-scanner-v5.js       ← VL 红笔分类 Prompt（当前）
│   ├── paper-analysis-v4.js      ← DeepSeek 分析 Prompt（当前）
│   ├── error-diagnosis.js        ← 错题诊断 Prompt
│   ├── grading-v5.js             ← 作文评分 Prompt（当前）
│   └── study-guidance-v1.js      ← 学习指导 Prompt
│
├── subject-logic/                ← 科目特定逻辑
│   ├── error-identification-logic.md  ← 错题判定决策树 v3.0
│   └── english-shanghai-gaokao.md     ← 上海高考英语题型定义
│
├── archive/                      ← 历史文件归档（旧版 scanner/prompts/scripts）
│   ├── prompts/                  ← 12个旧版 prompt
│   ├── scripts/                  ← 15个实验脚本
│   └── 旧版 backend 文件
│
├── preprocess-server.py          ← Python Flask 预处理服务 v8.3 → 端口 5002
├── scripts/                      ← 工具脚本
│   └── test-scanner-v21.mjs      ← Scanner 测试
│
├── eval/                         ← 评测体系
│   ├── evaluate.mjs              ← 评测脚本
│   ├── ground-truth/             ← 标注数据（3份试卷）
│   └── results/                  ← 评测结果
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
├── start-preprocess.sh           ← 预处理服务启动脚本
│
├── test-api.sh                   ← API 冒烟测试
├── test-prod-verify.py           ← 生产验证脚本
├── test-scanner-v2/v4/v5.mjs     ← Scanner 测试脚本
├── test-scanner.sh               ← Scanner 测试入口
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
| ★ **OCR 文本提取（主）** | **TextIn xParse API** | **合合信息** | 99.7%印刷体识别率，精确坐标，手写区域定位 |
| ★ **题目解析** | **11阶段正则引擎** | **本地** | 97.9%检测率，确定性解析，无幻觉风险 |
| VL OCR（回退） | `kimi-k2.6` / `glm-4.6v-flash` | 阿里云百炼 / 智谱 | TextIn 失败时回退 |
| VL OCR（最后回退） | Tencent Cloud OCR | 腾讯云 | 所有远程模型失败时 |
| DirectJudge（端到端判错） | `glm-4.6v-flash` | 智谱 | 双图一次完成 OCR + 判错 |
| 红笔标记分类 | `glm-4.6v-flash` / `kimi-k2.6` | 智谱 / 阿里云百炼 | VL 识别 8 种标记类型 |
| ★ **红笔交叉验证** | **TextIn xParse + HSV** | **本地** | 手写区域坐标 + 红笔质心重叠 → 增强判定 |
| 文本分析 | `deepseek-v4-pro` | DeepSeek | 错题知识点归因、薄弱分析、学习指导 |
| 预处理（OpenCV） | Python Flask | 本地 5002 端口 | 裁切/旋转/分页 + HSV 红笔分离 + 去红 |

**⚠️ OpenClaw Gateway HTTP API 不支持多模态（图片会被静默丢弃），所有 VL/OCR 任务必须直连模型 API。TextIn API 通过 preprocess-server 代理调用，不需要直连。**

### 2.4 服务端口

| 端口 | 服务 | 版本 | 守护方式 |
|------|------|------|---------|
| 3001 | Node.js API Server | Scanner v4.5 | cron 心跳 + 自动重启 |
| 5002 | Python Flask 预处理 | **v8.3** (含 /prepare-pages, /textin/*) | cron 15min 巡检 |

### 2.5 批改标记模式

| 模式 | 值 | 场景 | 判定逻辑 |
|------|-----|------|----------|
| 红笔勾叉 | `check_cross` | 老师只打 ✓✗，不写答案 | ✗=错题，✓=对题 |
| 红笔标注 | `annotation` | 老师红笔写正确答案/批注 | AI 识别红笔标注内容判定 |
| 混合模式 | `mixed` | ✓✗ + 红笔标注混合 | AI 综合判断勾叉+标注 |

### 2.6 Scanner v4.5 功能总览

| 功能 | 版本 | 说明 |
|------|------|------|
| ★ **TextIn OCR 主引擎** | v4.4 | TextIn xParse 替代 VL OCR，99.7%印刷体识别率 |
| ★ **11阶段题目解析** | v4.4 | 确定性正则引擎，97.9%检测率 + 连续性推断 |
| ★ **页面准备（旋转+分页）** | v4.5 | 裁切背景 + 自动旋转 + 双页水平分割 + 页面排序 |
| ★ **TextIn 红笔交叉验证** | v4.5 | 手写区域坐标 + 红笔质心重叠 → 增强错题判定 |
| **去红处理 (De-red)** | v4.2 | OCR 前擦除红笔墨水（cv2.inpaint + TextIn GAN 可选）|
| **双栏感知** | v4.2 | VLM prompt 版面分析（单/双栏识别）|
| **Passage 提取** | v4.2 | 阅读理解文章独立提取，passageRef 链接题目 |
| **DirectJudge 双图判错** | v4.2 | 10 种标记分类 + 逐题判定 + 强制自检 |
| **三级回退链** | v4.4 | TextIn → Zhipu VL → Kimi VL → Tencent OCR |

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
# ═══ 首次部署或 TextIn 模块更新 ═══
# 1. 安装 Python 依赖
pip install requests Pillow numpy

# 2. 复制 src/textin/ 模块到生产目录
cp -r ~/.openclaw/workspace/www/gaozhong.online/src/textin /app/data/www/gaozhong.online/src/

# 3. 配置 TextIn 环境变量（在 .env 或 Docker 环境变量中）
# TEXTIN_APP_ID=dda97xxxxxxxxxxxxx
# TEXTIN_SECRET_CODE=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ═══ 日常部署 ═══
# 只改 scanner/preprocess/python 代码（动态 import，无需重启）
cp ~/.openclaw/workspace/www/gaozhong.online/scanner-v3.mjs /app/data/www/gaozhong.online/
cp ~/.openclaw/workspace/www/gaozhong.online/preprocess-server.py /app/data/www/gaozhong.online/
cp -r ~/.openclaw/workspace/www/gaozhong.online/src/textin /app/data/www/gaozhong.online/src/
bash /app/data/start-preprocess.sh  # 重启预处理服务

# 改 api-server.js 或前端代码（需要完整部署）
cd /home/node/.openclaw/workspace/www/gaozhong.online/
./deploy.sh    # 构建前端 + 复制 dist + 重启 API Server
```

部署后验证：
```bash
# 检查预处理服务
curl http://localhost:5002/health              # → {"status":"ok"}

# 检查 TextIn 配置
curl http://localhost:5002/textin/ping          # → {"textin_configured":true}

# 检查 API 服务
curl http://localhost:3001/health               # → 正常响应
```

用户还需在宿主机执行：`sudo nginx -s reload`

### 4.3 Git 提交规范

- 每完成一个子任务 → commit（5-15 分钟粒度）
- 格式：`type: 描述`（feat/fix/docs/style/refactor/deploy）
- Commit 后 push 到 `git@github.com:dunwar/gaozhong.git`

---

## 5. 🔬 识别质量评测体系（Scanner Benchmark）

> **铁律**：任何 scanner 代码改动（prompt、模型、流程、参数）必须经过评测验证后才能合并。
> **目标**：量化驱动迭代，消灭"感觉好多了"式盲目修改。

### 5.0 评测工作流（每次改代码必走）

```
1. 改代码前：git stash，跑当前版本的评测 baseline
2. git stash pop，应用改动
3. 跑同样试卷的评测
4. 对比：召回率、精确率、题号准确率、错题判定
5. 任何试卷指标下降 >5% → 不合并，分析原因
```

### 5.1 测试集（Ground Truth）

位置：`eval/ground-truth/`

```
eval/ground-truth/
  <session_id>/
    meta.json          ← 试卷元信息（科目、年级、页数）
    ground-truth.json  ← 人工标注的标准答案
```

**ground-truth.json 格式**：
```json
{
  "version": 1,
  "annotator": "人工标注",
  "totalQuestions": 47,
  "questions": [
    {
      "questionNumber": 1,
      "questionType": "cloze",
      "questionText": "Though the cow...",
      "isError": false
    }
  ],
  "passages": [
    { "index": 0, "text": "阅读理解文章全文..." }
  ]
}
```

**选卷原则**：
- 至少 3 张试卷（2页、3页、6页各一张）
- 覆盖英语、数学等科目
- 包含双栏排版、阅读理解、完形填空等不同版面
- 每月新增 1 张标注试卷

### 5.2 评测脚本

位置：`eval/evaluate.mjs`

运行方式：
```bash
node eval/evaluate.mjs --version HEAD          # 当前版本
node eval/evaluate.mjs --version cdf102b        # 指定 git commit
node eval/evaluate.mjs --session 3623c60f       # 单张试卷
```

**评测指标**：

| 指标 | 定义 | 权重 |
|------|------|------|
| 题目召回率 | 识别到的题目数 / 实际题目数 | ⭐⭐⭐ |
| 题号精确率 | 题号正确的数量 / 识别到的题目数 | ⭐⭐⭐ |
| 题型准确率 | 题型标注正确的数量 / 识别到的题目数 | ⭐⭐ |
| 错题召回率 | 正确识别的错题数 / 实际错题数 | ⭐⭐⭐ |
| 错题精确率 | 真正错题数 / 标记为错题的总数 | ⭐⭐⭐ |
| 总耗时 | 端到端扫描时间 | ⭐ |

**输出格式**：
```
═══════════════════════════════════════════
📊 Scanner 评测报告 — v4.3 (c4d3824)
═══════════════════════════════════════════
试卷 3623c60f (2p, 英语):
  题目召回: 26/47 (55.3%)
  题号精确: 24/26 (92.3%)
  题型准确: 20/26 (76.9%)
  错题判定: 2/2 召回, 0 误报
  耗时: 150s

试卷 04412a9f (3p):
  ...

═══════════════════════════════════════════
汇总 (3 张试卷):
  总题目召回: XX/XXX (XX%)
  总错题判定: XX/XX 召回, XX 误报
═══════════════════════════════════════════
```

### 5.3 版本对比基线

首次建立时，对比 v4.2 vs v4.3，择优作为基准版本。

| 版本 | Commit | 日期 | 主要变更 |
|------|--------|------|----------|
| v4.2 | `938329c` | 2026-05-31 | 去红 + DirectJudge + 双栏感知 |
| v4.3 | `c4d3824` (HEAD) | 2026-06-07 | 重试逻辑 + 指数退避 + no-reasoning prompt |

对比后，**胜出版本的评测结果作为 baseline 写入** `eval/baselines/<version>.json`。

### 5.4 回归检测规则

- 题目召回率下降 >5% → ❌ 阻止合并
- 错题精确率下降（误报增加）→ ❌ 阻止合并
- 题号精确率下降 >3% → ⚠️ 需人工确认
- 耗时增加 >30% → ⚠️ 需人工确认
- 所有指标持平或改善 → ✅ 可合并

### 5.5 评测历史记录

每次评测结果保存在 `eval/results/<timestamp>_<version>.json`，供追踪趋势。

---

## 6. 已知问题 & 待完成

### 6.1 高优先级

| # | 问题 | 详情 |
|---|------|------|
| 1 | **TextIn 凭证未配置 → 自动回退** | 未设 TEXTIN_APP_ID/SECRET_CODE 时自动用 VL OCR，功能正常但识别率较低 |
| 2 | **Preprocess 周期性崩溃** | gunicorn worker 达 max-requests=100 后退出，约每 2h。cron guard 15min 巡检恢复 |
| 3 | **Ground truth 数据缺失** | eval/ground-truth/ 仅 3 份 meta.json，无标注数据，无法量化评测 |
| 4 | **TextIn 无法区分红/蓝手写** | xParse 所有手写标记为 `handwritten`，无颜色字段。已通过 HSV 质心交叉验证缓解 |
| 5 | **DeepSeek JSON 解析失败** | questionText 为空时返回中文抱怨而非 JSON，已有 fallback |

### 6.2 中优先级

| # | 问题 | 详情 |
|---|------|------|
| 6 | **11阶段解析仅支持英语** | 中文/数学/理综题型格式需额外正则模式 |
| 7 | **仅英语科目有逻辑文件** | subject-logic/ 下只有英语，语文/数学待添加 |
| 8 | **api-server.js 过大** | ~2500行，建议拆分为独立路由模块 |
| 9 | **并发优化** | VL_CONCURRENCY 固定值 2，可动态调整 |

### 6.3 功能规划

| # | 功能 | 详情 |
|---|------|------|
| 10 | **训练 YOLO 红笔检测模型** | 需 500+ 标注样本，替代纯 CV 方案 |
| 11 | **补充多科 ground truth** | 目标 50+ 份标注试卷 |
| 12 | **pdf/Word 支持** | 前端接受但后端需转换层 |
| 13 | **Preprocess systemd 守护** | 根治周期性崩溃 |
| 14 | **TextIn 红笔检测专用模型** | TextIn 上线后接入，直接返回红笔区域坐标 |

---

## 7. 关键决策记录

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
| **2026-06-07** | **Scanner v4.3 — 重试逻辑 + 指数退避 + no-reasoning prompt；76/99q** |
| **2026-06-09** | **建立识别质量评测体系 — 量化驱动迭代，消灭盲目修改** |
| **2026-06-13** | **v3.0 — TextIn OCR 集成：99.7%识别率 + 11阶段解析 + 页面准备(旋转/分页/排序) + Phase 2 混合交叉验证** |

---

## 8. TextIn 故障排查

### 8.1 确认 TextIn 是否启用

```bash
curl http://localhost:5002/textin/ping
# {"status":"ok","textin_configured":true}  ← 已启用
# {"status":"not_configured","textin_configured":false} ← 未配置，使用 VL 回退
```

### 8.2 Scanner 日志关键信息

```
[scanner v4.5] Scanning N pages (TextIn=true, ...)  ← TextIn 已启用
[scanner] Page 1: trying TextIn xParse...            ← 尝试 TextIn
[scanner] Page 1: TextIn ok — 45 questions           ← 成功
[scanner] Page 2: TextIn failed (timeout), falling back to VL  ← 失败回退
```

### 8.3 常见问题

| 症状 | 原因 | 解决 |
|------|------|------|
| TextIn 始终不工作 | 环境变量未设或错误 | 检查 `echo $TEXTIN_APP_ID`，确认在启动 preprocess-server 的 shell 中已 export |
| `textin_configured: false` | preprocess-server 未读取到环境变量 | 在 `start-preprocess.sh` 中添加 `export TEXTIN_APP_ID=xxx` |
| TextIn 超时 | 网络问题或 API 限流 | 检查服务器能否访问 `api.textin.com`，查看 TextIn 控制台配额 |
| `0 handwritten regions` | 页面手写内容少或 xParse 未检测到 | 正常情况，不影响 OCR；交叉验证降级为纯 VL/质心模式 |

### 8.4 禁用 TextIn（回退到纯 VL）

```bash
# 取消环境变量即可，无需改代码
unset TEXTIN_APP_ID
unset TEXTIN_SECRET_CODE
# 重启 preprocess-server
bash /app/data/start-preprocess.sh
```

---

## 9. 协同开发注意事项

1. **修改前先对比生产目录**：`diff -rq ~/workspace/www/gaozhong.online/ /app/data/www/gaozhong.online/`
2. **生产是权威**：如果生产版本比 workspace 新 → 先同步到 workspace 并 commit
3. **不改环境配置**：openclaw.json、模型配置等未经用户同意不得修改
4. **TextIn 模块同步**：`src/textin/` 目录修改后需一并复制到生产目录
5. **评测铁律**：任何 scanner 改动必须跑 `node eval/evaluate.mjs` 对比效果
4. **Scanner 动态 import**：`scanner-v3.mjs` 通过 `await import()` 加载，代码改动即时生效，无需重启 API Server
5. **Prompt 改动慎重**：所有 prompt 文件经多轮迭代验证，改动需先出方案再确认
6. **不要走 Gateway 做 VL**：图片识别必须直连模型 API（阿里云百炼 / 智谱）
7. **Preprocess 崩溃是已知问题**：每 2h 自动重启，guard cron 每 15min 保底，不需要人工干预

---

_本文档由 AI 助手维护，任何模型接手前应完整阅读此文件 + server-environment.md_
