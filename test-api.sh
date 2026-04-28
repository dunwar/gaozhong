#!/bin/bash
# 测试 gaozhong.online AI 作文批改服务

API_URL="http://localhost:3001"

echo "=== 测试 gaozhong.online AI 作文批改服务 ==="
echo ""

# 1. 健康检查
echo "1. 健康检查..."
HEALTH=$(curl -s "$API_URL/health")
echo "   响应: $HEALTH"
echo ""

# 2. 测试文本批改
echo "2. 测试文本批改..."
TEST_ESSAY="今天天气很好，我和朋友一起去公园玩。公园里有很多花，很漂亮。我们玩得很开心。"
TEST_TOPIC="周末的一天"

echo "   作文内容: $TEST_ESSAY"
echo "   题目: $TEST_TOPIC"
echo ""
echo "   正在调用 AI 批改..."

RESULT=$(curl -s -X POST "$API_URL/api/analyze" \
  -H "Content-Type: application/json" \
  -d "{\"text\":\"$TEST_ESSAY\",\"topic\":\"$TEST_TOPIC\"}")

echo "   响应:"
echo "$RESULT" | jq '.' 2>/dev/null || echo "$RESULT"
echo ""

# 3. 检查错误处理
echo "3. 测试错误处理（空内容）..."
ERROR_RESULT=$(curl -s -X POST "$API_URL/api/analyze" \
  -H "Content-Type: application/json" \
  -d '{}')
echo "   响应: $ERROR_RESULT"
echo ""

echo "=== 测试完成 ==="
