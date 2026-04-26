#!/bin/bash
# OpenClaw 自动部署守护进程（宿主机运行）
# 监控 /var/lib/openclaw/.deploy-trigger-* 文件并执行部署

DEPLOY_DIR="/var/lib/openclaw"
LOG_FILE="/var/log/openclaw-deployd.log"
PID_FILE="/var/run/openclaw-deployd.pid"

# 日志函数
log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

# 检查是否已在运行
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if ps -p "$OLD_PID" > /dev/null 2>&1; then
        log "部署守护进程已在运行 (PID: $OLD_PID)"
        exit 1
    fi
fi

# 保存 PID
echo $$ > "$PID_FILE"

log "========================================"
log "OpenClaw 自动部署守护进程启动"
log "========================================"

# 清理函数
cleanup() {
    log "收到退出信号，正在关闭..."
    rm -f "$PID_FILE"
    exit 0
}

trap cleanup SIGTERM SIGINT

# 主循环
while true; do
    # 查找所有部署触发文件
    for trigger in "$DEPLOY_DIR"/.deploy-trigger-*; do
        if [ -f "$trigger" ]; then
            # 读取部署配置
            PROJECT_NAME=$(grep "PROJECT_NAME=" "$trigger" | cut -d'=' -f2)
            SOURCE_DIR=$(grep "SOURCE_DIR=" "$trigger" | cut -d'=' -f2)
            DEPLOY_TARGET=$(grep "DEPLOY_DIR=" "$trigger" | cut -d'=' -f2)
            NGINX_CONF_SRC=$(grep "NGINX_CONF_SRC=" "$trigger" | cut -d'=' -f2)
            NGINX_CONF_DST=$(grep "NGINX_CONF_DST=" "$trigger" | cut -d'=' -f2)
            
            log "检测到部署任务: $PROJECT_NAME"
            
            # 执行部署
            if [ -d "$SOURCE_DIR" ]; then
                log "开始部署 $PROJECT_NAME..."
                
                # 确保目标目录存在
                mkdir -p "$DEPLOY_TARGET"
                
                # 复制文件
                if command -v rsync >/dev/null 2>&1; then
                    rsync -av --delete --exclude='.*' --exclude='node_modules' "$SOURCE_DIR/" "$DEPLOY_TARGET/"
                else
                    rm -rf "$DEPLOY_TARGET"/*
                    cp -r "$SOURCE_DIR"/* "$DEPLOY_TARGET/"
                fi
                
                # 设置权限
                chown -R nginx:nginx "$DEPLOY_TARGET" 2>/dev/null || chown -R root:root "$DEPLOY_TARGET"
                chmod -R 755 "$DEPLOY_TARGET"
                
                # 更新 Nginx 配置
                if [ -f "$NGINX_CONF_SRC" ]; then
                    cp "$NGINX_CONF_SRC" "$NGINX_CONF_DST"
                    log "Nginx 配置已更新"
                fi
                
                # 测试并重载 Nginx
                if nginx -t >/dev/null 2>&1; then
                    nginx -s reload
                    log "Nginx 已重载"
                    log "✅ $PROJECT_NAME 部署成功"
                else
                    log "❌ Nginx 配置测试失败"
                fi
            else
                log "❌ 源目录不存在: $SOURCE_DIR"
            fi
            
            # 删除触发文件
            rm -f "$trigger"
            log "部署标记已清理"
        fi
    done
    
    # 每 5 秒检查一次
    sleep 5
done
