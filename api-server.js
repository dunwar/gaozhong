#!/usr/bin/env node
/**
 * gaozhong.online - AI 作文批改 API 服务
 * 
 * 架构：直连阿里云百炼 API，不经过 OpenClaw Gateway
 * 模型分工：
 *   - 图片识别/OCR: qwen-vl-plus
 *   - 作文批改: qwen3.6-plus
 * 
 * Prompt 管理：prompts/ 目录下独立文件，方便迭代优化
 * 环境变量：
 *   DASHSCOPE_API_KEY - 百炼 API Key
 *   MODEL_OCR - OCR 模型（默认 qwen-vl-plus）
 *   MODEL_GRADING - 批改模型（默认 qwen3.6-plus）
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 导入 Prompt 模板
import { GRADING_PROMPT, PROMPT_VERSION } from './prompts/grading-v3.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

// 加载环境变量
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf-8')
      .split('\n')
      .filter(line => line.trim() && !line.startsWith('#'))
      .forEach(line => {
        const [key, ...valParts] = line.split('=');
        const val = valParts.join('=').trim();
        if (!process.env[key.trim()]) process.env[key.trim()] = val;
      });
  }
}
loadEnv();

const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY;
const MODEL_OCR = process.env.MODEL_OCR || 'qwen-vl-plus';
const MODEL_GRADING = process.env.MODEL_GRADING || 'qwen3.6-plus';

// 验证 Key
if (!DASHSCOPE_KEY) {
  console.error('❌ 错误: DASHSCOPE_API_KEY 未设置，请创建 .env 文件');
  process.exit(1);
}

// 日志
function log(level, msg, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }));
}

// ========== Prompt 模板处理 ==========

// 渲染 Prompt 模板（替换 {topic} 和 {text} 变量）
function renderPrompt(template, topic = '', text = '') {
  return template
    .replace(/\{topic\}/g, topic || '(无)')
    .replace(/\{text\}/g, text);
}

// 图片批改 Prompt
function createVisionPrompt(topic = '') {
  return `你是资深高中语文教师。请完成两个任务：

任务1：仔细识别图片中的手写/印刷作文文字，尽量还原原文。
任务2：依据上海高考作文评分标准进行批改（满分70分）。

${topic ? `【作文题目】${topic}` : ''}

严格返回以下JSON（不要其他文字）：
{
  "recognizedText": "识别出的原文",
  "totalScore": 0-70,
  "grade": "档位",
  "essayType": "议论文/记叙文/其他",
  "dimensions": {"内容": 0-20, "结构": 0-20, "语言": 0-20, "创新": 0-20},
  "wordCount": 字数,
  "strengths": ["亮点1","亮点2"],
  "weaknesses": ["不足1","不足2"],
  "suggestions": ["建议1","建议2"],
  "overallComment": "总评",
  "gradingReason": "定档依据",
  "revisions": [
    {"location": "位置", "original": "原文", "suggested": "修改后", "reason": "修改理由"}
  ]
}`;
}

// ========== DashScope API 请求 ==========

function dashscopeRequest(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'dashscope.aliyuncs.com',
      path: '/compatible-mode/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DASHSCOPE_KEY}`,
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 120000
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`DashScope HTTP ${res.statusCode}: ${raw.substring(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(raw);
          resolve(json);
        } catch (e) {
          reject(new Error(`解析响应失败: ${e.message}`));
        }
      });
    });
    req.on('error', e => reject(new Error(`请求失败: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时(120s)')); });
    req.write(data);
    req.end();
  });
}

// ========== 业务逻辑 ==========

async function gradeText(text, topic) {
  const prompt = renderPrompt(GRADING_PROMPT, topic, text);
  log('info', '文本批改', { model: MODEL_GRADING, promptVersion: PROMPT_VERSION, textLen: text.length });
  
  const result = await dashscopeRequest({
    model: MODEL_GRADING,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 3000
  });

  return parseResult(result);
}

async function gradeImage(imageUrl, topic) {
  log('info', '图片批改', { model: MODEL_OCR, promptVersion: PROMPT_VERSION });
  
  const result = await dashscopeRequest({
    model: MODEL_OCR,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: createVisionPrompt(topic) },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    }],
    temperature: 0.3,
    max_tokens: 4000
  });

  return parseResult(result);
}

function parseResult(result) {
  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 返回为空');

  // 清理 markdown 代码块
  let cleaned = content
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  // 尝试解析
  try { return JSON.parse(cleaned); } catch {}

  // 提取第一个 JSON 对象
  try {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch {}

  // 尝试修复常见 JSON 问题
  try {
    // 移除尾部逗号
    let fixed = cleaned.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    return JSON.parse(fixed);
  } catch {}

  throw new Error('AI 返回格式错误，无法解析 JSON');
}

// ========== 路由 ==========

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(new Error('JSON 格式错误')); } });
    req.on('error', reject);
  });
}

function json(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, {
      status: 'ok',
      service: 'gaozhong-ai-api',
      models: { ocr: MODEL_OCR, grading: MODEL_GRADING },
      prompt: { version: PROMPT_VERSION, file: 'prompts/grading-v3.js' }
    });
  }

  // POST /analyze 或 /api/analyze
  if (req.method === 'POST' && (req.url === '/analyze' || req.url === '/api/analyze')) {
    try {
      const body = await parseBody(req);
      log('info', '收到请求', { hasFile: !!body.file, hasText: !!body.text, url: req.url });

      if (!body.file && !body.text) {
        return json(res, 400, { error: '请提供 text（文本）或 file（图片base64）' });
      }

      const topic = body.topic || '';
      let result;

      if (body.file && body.file.startsWith('data:image')) {
        result = await gradeImage(body.file, topic);
      } else if (body.text) {
        result = await gradeText(body.text, topic);
      } else {
        return json(res, 400, { error: '不支持的文件格式' });
      }

      log('info', '批改完成', { score: result.totalScore, grade: result.grade, type: result.essayType });
      return json(res, 200, { success: true, result });

    } catch (err) {
      log('error', '批改失败', { error: err.message });
      return json(res, 500, { error: err.message });
    }
  }

  json(res, 404, { error: 'Not Found', endpoints: ['/health', '/analyze'] });
});

server.listen(PORT, () => {
  console.log(`🚀 gaozhong.online AI API 已启动 (直连百炼)`);
  console.log(`📍 端口: ${PORT}`);
  console.log(`🔍 健康检查: http://localhost:${PORT}/health`);
  console.log(`📝 批改接口: POST /analyze`);
  console.log(`🤖 OCR: ${MODEL_OCR} | 批改: ${MODEL_GRADING} | Prompt: ${PROMPT_VERSION}`);
});
