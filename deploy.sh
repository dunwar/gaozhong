#!/bin/bash
# gaozhong.online 一键部署脚本
# 从开发目录构建 → 部署到生产目录 → 提示 Nginx 重载

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

# 1. 安装依赖 + 构建
echo -e "\n${YELLOW}[1/4] 构建前端...${NC}"
cd "$DEV_DIR"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm build
echo -e "${GREEN}✅ 构建完成${NC}"

# 2. 部署 dist 到生产目录
echo -e "\n${YELLOW}[2/4] 部署静态文件...${NC}"
rm -rf "$PROD_DIR/dist"
cp -r "$DEV_DIR/dist" "$PROD_DIR/"
echo -e "${GREEN}✅ dist → $PROD_DIR/dist${NC}"

# 3. 部署 API 服务
echo -e "\n${YELLOW}[3/4] 部署 API 服务...${NC}"
# 备份旧版
cp "$PROD_DIR/api-server.js" "$PROD_DIR/api-server.js.bak.$(date +%Y%m%d_%H%M)" 2>/dev/null || true
# 复制新文件
cp "$DEV_DIR/api-server.js" "$PROD_DIR/"
cp -r "$DEV_DIR/prompts" "$PROD_DIR/"
# 确保 .env 存在
if [ ! -f "$PROD_DIR/.env" ] && [ -f "$DEV_DIR/.env" ]; then
    cp "$DEV_DIR/.env" "$PROD_DIR/"
fi
echo -e "${GREEN}✅ API Server + prompts 已更新${NC}"

# 4. 重启 API 服务
echo -e "\n${YELLOW}[4/4] 重启 API 服务...${NC}"
OLD_PID=$(cat "$PROD_DIR/api-server.pid" 2>/dev/null)
if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" && echo "已停止旧进程 PID:$OLD_PID"
fi
cd "$PROD_DIR"
nohup node api-server.js > api-server.log 2>&1 &
echo $! > api-server.pid
sleep 1
if kill -0 "$(cat api-server.pid)" 2>/dev/null; then
    echo -e "${GREEN}✅ API 服务已启动 PID:$(cat api-server.pid)${NC}"
else
    echo -e "${RED}❌ API 服务启动失败，查看日志: tail $PROD_DIR/api-server.log${NC}"
    exit 1
fi

# 完成
echo -e "\n${GREEN}=== 部署完成 ===${NC}"
echo ""
echo -e "${YELLOW}⚠️  还需在宿主机执行 Nginx 重载：${NC}"
echo "  sudo cp /var/lib/openclaw/nginx-configs/gaozhong.online.conf /etc/nginx/conf.d/"
echo "  sudo nginx -t && sudo nginx -s reload"
echo ""
echo "验证: curl http://localhost:3001/health"
