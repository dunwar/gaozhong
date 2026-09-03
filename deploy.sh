#!/bin/bash
# gaozhong.online 一键部署脚本 (v2.0)
# 从开发目录构建 → 部署到生产目录 → 重启服务 → 提示 Nginx 重载

set -e

DEV_DIR="/home/node/.openclaw/workspace/www/gaozhong.online"
PROD_DIR="/app/data/www/gaozhong.online"
NGINX_CONF="/app/data/nginx-configs/gaozhong.online.conf"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== 部署 gaozhong.online ===${NC}"
echo "开发目录: $DEV_DIR"
echo "生产目录: $PROD_DIR"

# 0. 确认在 main 分支
echo -e "\n${YELLOW}[0/5] 确认分支...${NC}"
cd "$DEV_DIR"
CUR_BRANCH=$(git branch --show-current)
if [ "$CUR_BRANCH" != "main" ]; then
    echo -e "${YELLOW}当前在 $CUR_BRANCH 分支，切换到 main...${NC}"
    git checkout main
fi
git pull origin main
DEPLOY_REV=$(git rev-parse --short HEAD)
echo -e "${GREEN}✅ main 分支已更新 ($DEPLOY_REV)${NC}"

# 1. 安装依赖 + 构建
echo -e "\n${YELLOW}[1/5] 构建前端...${NC}"
cd "$DEV_DIR"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm build
echo -e "${GREEN}✅ 构建完成${NC}"

# 2. 部署 dist 到生产目录
echo -e "\n${YELLOW}[2/5] 部署静态文件...${NC}"
rm -rf "$PROD_DIR/dist"
cp -r "$DEV_DIR/dist" "$PROD_DIR/"
echo -e "${GREEN}✅ dist → $PROD_DIR/dist${NC}"

# 3. 部署后端服务 (api-server + scanner + preprocess + src)
echo -e "\n${YELLOW}[3/5] 部署后端服务...${NC}"
# 备份旧版
cp "$PROD_DIR/api-server.js" "$PROD_DIR/api-server.js.bak.$(date +%Y%m%d_%H%M)" 2>/dev/null || true
cp "$PROD_DIR/preprocess-server.py" "$PROD_DIR/preprocess-server.py.bak.$(date +%Y%m%d_%H%M)" 2>/dev/null || true

# API Server
cp "$DEV_DIR/api-server.js" "$PROD_DIR/"
cp "$DEV_DIR/db.js" "$PROD_DIR/"
cp "$DEV_DIR/scanner-v3.mjs" "$PROD_DIR/"
cp -r "$DEV_DIR/prompts" "$PROD_DIR/"

# Preprocess Server + TextIn module + launcher
cp "$DEV_DIR/preprocess-server.py" "$PROD_DIR/"
cp "$DEV_DIR/start-preprocess.sh" "$PROD_DIR/"
mkdir -p "$PROD_DIR/src/textin"
cp -r "$DEV_DIR/src/textin/"*.py "$PROD_DIR/src/textin/" 2>/dev/null || true
cp -r "$DEV_DIR/src/textin/__pycache__" "$PROD_DIR/src/textin/" 2>/dev/null || true

# Eval tools
mkdir -p "$PROD_DIR/eval"
cp -r "$DEV_DIR/eval/"*.mjs "$DEV_DIR/eval/"*.py "$PROD_DIR/eval/" 2>/dev/null || true
cp -r "$DEV_DIR/eval/ground-truth" "$PROD_DIR/eval/" 2>/dev/null || true

# 确保 .env 存在
if [ ! -f "$PROD_DIR/.env" ] && [ -f "$DEV_DIR/.env" ]; then
    cp "$DEV_DIR/.env" "$PROD_DIR/"
fi
echo -e "${GREEN}✅ API Server + Scanner + Preprocess + TextIn 已更新${NC}"

# 4. 重启服务
echo -e "\n${YELLOW}[4/5] 重启服务...${NC}"

# 重启 API Server (Node.js)
# 2026-09-03 修复：不再依赖 pid 文件（会失效），pkill 杀净所有实例（含孤儿进程）再启动
if pkill -f "node api-server.js" 2>/dev/null; then
    echo "已停止旧 API 进程（pkill 全量）"
    sleep 2
    pkill -9 -f "node api-server.js" 2>/dev/null || true
else
    echo "无运行中的 API 进程"
fi
cd "$PROD_DIR"
nohup node api-server.js > api-server.log 2>&1 &
echo $! > api-server.pid
sleep 3
if curl -s --max-time 5 http://localhost:3001/health | grep -q "ok"; then
    echo -e "${GREEN}✅ API 服务已启动 PID:$(cat api-server.pid)${NC}"
else
    echo -e "${RED}❌ API 服务启动失败，查看日志: tail $PROD_DIR/api-server.log${NC}"
    exit 1
fi

# 重启 Preprocess Server (gunicorn，与 /app/data/start-preprocess.sh 和 guard 保持一致)
# 2026-09-03 修复：原裸 python3 启动为 dev 模式，生产必须 gunicorn（timeout 600）
if pkill -f "gunicorn.*preprocess-server" 2>/dev/null; then
    echo "已停止旧 Preprocess (gunicorn)"
    sleep 2
    pkill -9 -f "gunicorn.*preprocess-server" 2>/dev/null || true
else
    echo "无运行中的 Preprocess 进程"
fi
rm -f /tmp/preprocess-gunicorn.pid
bash /app/data/start-preprocess.sh || { echo -e "${RED}❌ Preprocess 启动失败${NC}"; exit 1; }

# 5. 健康检查
echo -e "\n${YELLOW}[5/5] 健康检查...${NC}"
sleep 2
API_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health 2>/dev/null || echo "fail")
PP_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5002/ 2>/dev/null || echo "fail")
echo "  API Server:  $API_HEALTH"
echo "  Preprocess:  $PP_HEALTH"

# 完成
echo -e "\n${GREEN}=== 部署完成 ===${NC}"
echo ""
echo "部署摘要:"
echo "  Branch:  main ($DEPLOY_REV)"
echo "  文件:    api-server.js, scanner-v3.mjs, preprocess-server.py, src/textin/*.py"
echo ""
echo -e "${YELLOW}⚠️  如需 Nginx 重载：${NC}"
echo "  sudo cp /var/lib/openclaw/nginx-configs/gaozhong.online.conf /etc/nginx/conf.d/"
echo "  sudo nginx -t && sudo nginx -s reload"
echo ""
echo "验证: curl http://localhost:3001/health"

