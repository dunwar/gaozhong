#!/bin/bash
# gaozhong.online 一键部署脚本
# 在 OpenClaw 容器内执行，自动完成构建 + Nginx 部署

set -e

PROJECT="gaozhong.online"
SRC_DIR="/app/data/www/gaozhong.online"
NGINX_CONF_SRC="/app/data/nginx-configs/gaozhong.online.conf"
NGINX_CONF_DST="/var/lib/openclaw/nginx-configs/gaozhong.online.conf"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== 部署 $PROJECT ===${NC}"

# 1. 安装依赖 + 构建
echo "构建项目..."
cd "$SRC_DIR"
pnpm install
pnpm build

# 2. 更新 Nginx 配置
echo "更新 Nginx 配置..."
if [ -f "$NGINX_CONF_SRC" ]; then
    cp "$NGINX_CONF_SRC" /var/lib/openclaw/nginx-configs/gaozhong.online.conf 2>/dev/null || true
fi

# 3. 验证
echo -e "${GREEN}✅ 构建完成${NC}"
echo "请将以下 Nginx 配置应用到宿主机并重启 Nginx:"
echo ""
echo -e "${YELLOW}--- 在宿主机执行 ---${NC}"
echo "cp /var/lib/openclaw/nginx-configs/gaozhong.online.conf /etc/nginx/conf.d/"
echo "nginx -t && nginx -s reload"
echo -e "${YELLOW}-------------------${NC}"
