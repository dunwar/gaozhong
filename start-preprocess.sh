#!/bin/bash
# gaozhong.online — Preprocess v8.3 gunicorn launcher
# Managed by gunicorn: 2 workers, auto-restart, memory-safe

cd /app/data/www/gaozhong.online

# 加载环境变量（TextIn 凭证等）
if [ -f .env ]; then
    export $(grep -v '^#' .env | grep -v '^$' | xargs)
    echo "✅ Loaded .env"
fi

PID_FILE=/tmp/preprocess-gunicorn.pid
GUNICORN=/home/node/.local/bin/gunicorn

# Kill old process if running
if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
    echo "Preprocess already running (PID $(cat $PID_FILE))"
    exit 0
fi

# Clean stale PID
rm -f "$PID_FILE"

$GUNICORN \
    -w 4 \
    --timeout 600 \
    --max-requests 200 \
    --max-requests-jitter 30 \
    --bind 0.0.0.0:5002 \
    --access-logfile /tmp/preprocess-gunicorn.log \
    --error-logfile /tmp/preprocess-gunicorn-err.log \
    --pid "$PID_FILE" \
    --daemon \
    "preprocess-server:app"

sleep 2

if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
    echo "✅ Preprocess v8.0 (gunicorn) started, PID $(cat $PID_FILE)"
else
    echo "❌ Failed to start preprocess"
    exit 1
fi
