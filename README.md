# gaozhong.online — 高中在线学习分析平台

拍试卷、整错题、查弱项，AI 驱动的高中学习分析工具。

## 核心功能

- **📸 试卷扫描** — 上传已批改的试卷，AI 自动识别红色批改痕迹，判断对错
- **📊 错题整理** — 自动归类错题，生成结构化错题本（按学科/时间/题型分类）
- **🧠 知识地图** — 错题关联知识点，生成薄弱知识点的针对性分析报告
- **📝 作文批改** — AI 作文评分（上海高考 70 分制），5 维度评估 + 修改建议

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Vue 3 + Vite 8 + Tailwind CSS 4 + Vue Router 5 |
| 后端 | Node.js + Express 5 |
| 数据库 | SQLite (sql.js WASM) |
| 图像预处理 | Python Flask + OpenCV |
| AI 模型 | 智谱 GLM-4.6V / Kimi K2.6（VL/OCR）、DeepSeek V4 Pro（文本分析） |

## 快速开始

```bash
# 安装依赖
pnpm install

# 前端开发
pnpm dev

# 构建
pnpm build
```

### 环境变量

参考 `.env.example` 配置 API 密钥：

```
DASHSCOPE_API_KEY=xxx    # 阿里云 DashScope（Kimi 通道）
MODEL_OCR=xxx            # VL OCR 模型
MODEL_GRADING=xxx        # 文本评分模型
```

### 后端服务

- `api-server.js` — Express API 服务器（端口 3001）
- `preprocess-server.py` — 图像预处理服务（端口 5002）
- `deploy.sh` — 一键部署脚本

## 项目文档

详细文档见 [REQUIREMENTS.md](./REQUIREMENTS.md)，包含：
- 系统架构与数据流
- API 接口文档
- 评测体系说明
- 已知问题与待办事项

## 部署

```bash
# 完整部署（构建前端 + 重启 API）
bash deploy.sh

# 启动预处理服务
bash start-preprocess.sh

# 部署守护进程
bash deploy-daemon.sh
```
