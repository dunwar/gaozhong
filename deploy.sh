#!/bin/bash
# gaozhong.online 自动部署脚本（容器内执行）
# 通过创建部署标记文件，配合宿主机 cron 实现自动部署

set -e

# 配置
PROJECT_NAME="gaozhong.online"
SOURCE_DIR="/home/node/.openclaw/workspace/www/gaozhong.online/src"
DEPLOY_TRIGGER="/app/data/.deploy-trigger-$PROJECT_NAME"
DEPLOY_LOG="/app/data/deploy.log"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${GREEN}=== OpenClaw 自动部署: $PROJECT_NAME ===${NC}"
echo ""

# 检查源目录
if [ ! -d "$SOURCE_DIR" ]; then
    echo -e "${RED}错误: 源目录不存在 $SOURCE_DIR${NC}"
    exit 1
fi

# 检查是否有构建步骤
BUILD_DIR="$SOURCE_DIR"
if [ -f "/home/node/.openclaw/workspace/www/gaozhong.online/package.json" ]; then
    echo -e "${YELLOW}检测到 package.json，执行构建...${NC}"
    cd "/home/node/.openclaw/workspace/www/gaozhong.online"
    
    if [ ! -d "node_modules" ]; then
        echo "安装依赖..."
        pnpm install
    fi
    
    echo "执行构建..."
    pnpm run build
    
    if [ -d "dist" ]; then
        BUILD_DIR="/home/node/.openclaw/workspace/www/gaozhong.online/dist"
    elif [ -d "build" ]; then
        BUILD_DIR="/home/node/.openclaw/workspace/www/gaozhong.online/build"
    fi
    echo -e "${GREEN}使用构建输出: $BUILD_DIR${NC}"
fi

# 创建部署标记文件
echo -e "${BLUE}创建部署标记...${NC}"

cat > "$DEPLOY_TRIGGER" << EOF
PROJECT_NAME=$PROJECT_NAME
SOURCE_DIR=$BUILD_DIR
DEPLOY_DIR=/var/www/gaozhong.online
NGINX_CONF_SRC=/var/lib/openclaw/workspace/nginx-configs/gaozhong.online.conf
NGINX_CONF_DST=/etc/nginx/conf.d/gaozhong.online.conf
TIMESTAMP=$(date +%s)
EOF

echo "$(date '+%Y-%m-%d %H:%M:%S') - $PROJECT_NAME - 部署标记已创建" >> "$DEPLOY_LOG"

echo -e "${GREEN}✅ 部署标记已创建${NC}"
echo ""

# 检查宿主机是否有自动部署守护进程
if [ -f "/proc/1/root/usr/local/bin/openclaw-deployd" ]; then
    echo -e "${BLUE}检测到宿主机部署守护进程，发送信号...${NC}"
    # 可以尝试通过其他方式通知宿主机
fi

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}  请执行以下命令完成部署:${NC}"
echo -e "${YELLOW}========================================${NC}"
echo ""
echo -e "${GREEN}  bash /var/lib/openclaw/workspace/www/gaozhong.online/deploy-host.sh${NC}"
echo ""
echo "或者使用快捷命令（如果已配置）:"
echo -e "${GREEN}  deploy-gaozhong${NC}"
echo ""
echo -e "${YELLOW}========================================${NC}"

echo ""
echo -e "${GREEN}=== 部署准备完成 ===${NC}"
echo -e "${BLUE}网站地址: http://gaozhong.online${NC}"
echo -e "${BLUE}IP 地址: http://111.229.116.98${NC}"
