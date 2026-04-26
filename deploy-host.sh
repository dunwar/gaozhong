#!/bin/bash
# gaozhong.online 部署脚本（宿主机执行）
# 此脚本需要在宿主机上运行
# 位置: /opt/deploy-gaozhong.sh

set -e

# 配置
PROJECT_NAME="gaozhong.online"
SOURCE_DIR="/var/lib/openclaw/workspace/www/gaozhong.online"
DEPLOY_DIR="/var/www/gaozhong.online"
NGINX_CONF="/var/lib/openclaw/workspace/nginx-configs/gaozhong.online.conf"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${GREEN}=== 开始部署 $PROJECT_NAME ===${NC}"
echo -e "${BLUE}源目录: $SOURCE_DIR${NC}"
echo -e "${BLUE}部署目录: $DEPLOY_DIR${NC}"
echo ""

# 1. 检查源目录
if [ ! -d "$SOURCE_DIR" ]; then
    echo -e "${RED}错误: 源目录不存在 $SOURCE_DIR${NC}"
    exit 1
fi

# 2. 检查是否有构建步骤（如果有 package.json 且包含 build 脚本）
BUILD_DIR="$SOURCE_DIR"
if [ -f "$SOURCE_DIR/package.json" ]; then
    echo -e "${YELLOW}检测到 package.json，执行构建...${NC}"
    cd "$SOURCE_DIR"
    
    # 检查是否有 node_modules
    if [ ! -d "node_modules" ]; then
        echo "安装依赖..."
        if command -v pnpm &> /dev/null; then
            pnpm install
        elif command -v npm &> /dev/null; then
            npm install
        else
            echo -e "${RED}错误: 未找到 npm 或 pnpm${NC}"
            exit 1
        fi
    fi
    
    # 执行构建
    echo "执行构建..."
    if command -v pnpm &> /dev/null; then
        pnpm run build
    else
        npm run build
    fi
    
    # 假设构建输出在 dist 目录（可根据项目调整）
    if [ -d "$SOURCE_DIR/dist" ]; then
        BUILD_DIR="$SOURCE_DIR/dist"
        echo -e "${GREEN}使用构建输出目录: $BUILD_DIR${NC}"
    elif [ -d "$SOURCE_DIR/build" ]; then
        BUILD_DIR="$SOURCE_DIR/build"
        echo -e "${GREEN}使用构建输出目录: $BUILD_DIR${NC}"
    fi
fi

# 3. 确保部署目录存在
echo "确保部署目录存在..."
mkdir -p "$DEPLOY_DIR"

# 4. 复制文件到部署目录
echo "复制文件到生产目录..."
rsync -av --delete \
    --exclude='.*' \
    --exclude='node_modules' \
    --exclude='package*.json' \
    --exclude='deploy.sh' \
    "$BUILD_DIR/" "$DEPLOY_DIR/"

# 5. 设置权限
echo "设置文件权限..."
chown -R nginx:nginx "$DEPLOY_DIR" 2>/dev/null || chown -R root:root "$DEPLOY_DIR"
chmod -R 755 "$DEPLOY_DIR"

# 6. 检查并更新 Nginx 配置
echo "检查 Nginx 配置..."
if [ -f "$NGINX_CONF" ]; then
    cp "$NGINX_CONF" /etc/nginx/conf.d/
    echo -e "${GREEN}Nginx 配置已更新${NC}"
fi

# 7. 测试并重载 Nginx
echo "测试 Nginx 配置..."
if nginx -t; then
    echo -e "${GREEN}Nginx 配置测试通过${NC}"
    echo "重载 Nginx..."
    nginx -s reload
    echo -e "${GREEN}Nginx 已重载${NC}"
else
    echo -e "${RED}Nginx 配置测试失败！${NC}"
    exit 1
fi

# 8. 验证部署
echo ""
echo -e "${BLUE}验证部署...${NC}"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost)
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "301" ] || [ "$HTTP_CODE" = "302" ]; then
    echo -e "${GREEN}✅ HTTP 测试通过 (状态码: $HTTP_CODE)${NC}"
else
    echo -e "${YELLOW}⚠️ HTTP 测试返回状态码: $HTTP_CODE${NC}"
fi

echo ""
echo -e "${GREEN}=== 部署完成 ===${NC}"
echo -e "${GREEN}🌐 访问地址: http://gaozhong.online${NC}"
echo -e "${GREEN}🌐 访问地址: http://111.229.116.98${NC}"
