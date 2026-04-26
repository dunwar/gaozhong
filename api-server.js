#!/usr/bin/env node
/**
 * gaozhong.online - AI 作文批改 API 服务
 * 运行在宿主机上，接收前端请求，调用 OpenClaw AI 服务进行批改
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3001;
const OPENCLAW_GATEWAY = 'http://127.0.0.1:18789';

// 作文批改 Prompt 模板（上海高考标准）
function createEssayPrompt(essayText, topic = '') {
  return `依据以下上海高考语文作文评分标准，对以下作文进行严格评分：

【评分标准】
上海高考语文作文满分 70 分，采用综合分档评分制，从内容、结构、语言、创新四大维度综合评定。

一类卷（63-70 分）：准确把握题意，立意深刻，选材恰当，中心突出，内容充实，感情真挚，结构严谨，有新意，有文采。
二类卷（52-62 分）：符合题意，立意较深刻，选材较恰当，中心明确，内容较充实，感情真实，结构完整，语言通顺。
三类卷（39-51 分）：基本符合题意，立意一般，选材尚恰当，中心尚明确，内容尚充实，结构基本完整，语言基本通顺。
四类卷（21-38 分）：偏离题意，立意或选材不当，中心不明确，内容单薄，结构不够完整，语言欠通顺。
五类卷（0-20 分）：脱离题意，内容空洞或不成文。

${topic ? `【作文题目】\n${topic}\n` : ''}

【作文内容】
${essayText}

请按以下 JSON 格式返回评分结果（不要返回其他内容）：
{
  "totalScore": 总分(0-70),
  "grade": "档位(如：二类上)",
  "dimensions": {
    "内容": 分数(0-20),
    "结构": 分数(0-20),
    "语言": 分数(0-20),
    "创新": 分数(0-20)
  },
  "strengths": ["亮点1", "亮点2", "亮点3"],
  "weaknesses": ["不足1", "不足2"],
  "suggestions": ["建议1", "建议2", "建议3"],
  "overallComment": "总评文字"
}`;
}

// 解析请求体
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// 发送 JSON 响应
function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

// 调用 OpenClaw AI 服务
function callOpenClaw(prompt) {
  return new Promise((resolve, reject) => {
    const command = `curl -s -X POST ${OPENCLAW_GATEWAY}/chat -H 'Content-Type: application/json' -d '${JSON.stringify({ message: prompt }).replace(/'/g, "'\\''")}'`;
    
    exec(command, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`AI 服务调用失败: ${error.message}`));
        return;
      }
      
      try {
        const response = JSON.parse(stdout);
        resolve(response.message || response.content || response);
      } catch (e) {
        // 尝试从文本中提取 JSON
        const jsonMatch = stdout.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          resolve(JSON.parse(jsonMatch[0]));
        } else {
          reject(new Error('AI 返回格式解析失败'));
        }
      }
    });
  });
}

// 创建 HTTP 服务器
const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    sendJSON(res, 200, { ok: true });
    return;
  }

  // 健康检查
  if (req.method === 'GET' && req.url === '/health') {
    sendJSON(res, 200, { status: 'ok', service: 'gaozhong-ai-api' });
    return;
  }

  // 作文批改接口
  if (req.method === 'POST' && req.url === '/api/analyze') {
    try {
      const body = await parseBody(req);
      
      if (!body.file && !body.text) {
        sendJSON(res, 400, { error: '请提供作文内容（file 或 text）' });
        return;
      }

      // 如果有文件（base64），这里可以添加 OCR 处理
      // 目前假设直接传入文本
      const essayText = body.text || body.ocr_result || '[图片内容待 OCR 识别]';
      const topic = body.topic || '';

      const prompt = createEssayPrompt(essayText, topic);
      const result = await callOpenClaw(prompt);

      sendJSON(res, 200, { success: true, result });
    } catch (error) {
      console.error('批改失败:', error);
      sendJSON(res, 500, { error: error.message || '批改失败，请稍后重试' });
    }
    return;
  }

  // 404
  sendJSON(res, 404, { error: 'Not Found' });
});

// 启动服务
server.listen(PORT, () => {
  console.log(`🚀 gaozhong.online AI API 服务已启动`);
  console.log(`📍 监听端口: ${PORT}`);
  console.log(`🔗 健康检查: http://localhost:${PORT}/health`);
});
