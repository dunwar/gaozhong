#!/usr/bin/env node
/**
 * gaozhong.online - AI 作文批改 API 服务
 * 
 * 架构：直连大模型 API
 * 模型分工：
 *   - 图片识别/OCR: 阿里云百炼 qwen-vl-plus
 *   - 作文批改: DeepSeek v4 pro
 * 
 * Prompt 管理：prompts/ 目录下独立文件，方便迭代优化
 * 环境变量：
 *   DASHSCOPE_API_KEY - 百炼 API Key（OCR 用）
 *   DEEPSEEK_API_KEY  - DeepSeek API Key（批改用）
 *   MODEL_OCR         - OCR 模型（默认 qwen-vl-plus）
 *   MODEL_GRADING     - 批改模型（默认 deepseek-v4-pro）
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
      .filter(line => line.trim() && !line.trim().startsWith('#'))
      .forEach(line => {
        // 移除行内注释
        const cleanLine = line.split('#')[0].trim();
        if (!cleanLine) return;
        const eqIdx = cleanLine.indexOf('=');
        if (eqIdx === -1) return;
        const key = cleanLine.substring(0, eqIdx).trim();
        const val = cleanLine.substring(eqIdx + 1).trim();
        if (val && !process.env[key]) process.env[key] = val;
      });
  }
}
loadEnv();

const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL_OCR = process.env.MODEL_OCR || 'qwen-vl-plus';
const MODEL_GRADING = process.env.MODEL_GRADING || 'deepseek-v4-pro';

// 验证 Key
if (!DEEPSEEK_KEY) {
  console.error('❌ 错误: DEEPSEEK_API_KEY 未设置，请创建 .env 文件');
  process.exit(1);
}

// 日志
function log(level, msg, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }));
}

// ========== Prompt 模板处理 ==========

function renderPrompt(template, topic = '', text = '') {
  return template
    .replace(/\{作文题目材料\}/g, topic || '(无)')
    .replace(/\{作文内容\}/g, text);
}

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

// ========== API 请求封装 ==========

// 通用 API 请求
function apiRequest({ hostname, path, apiKey, body, timeout = 120000 }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(data)
      },
      timeout
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.substring(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`解析失败: ${e.message}`)); }
      });
    });
    req.on('error', e => reject(new Error(`请求失败: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(data);
    req.end();
  });
}

// 百炼 API 请求（用于 OCR）
function dashscopeRequest(body) {
  return apiRequest({
    hostname: 'dashscope.aliyuncs.com',
    path: '/compatible-mode/v1/chat/completions',
    apiKey: DASHSCOPE_KEY,
    body
  });
}

// DeepSeek API 请求（用于批改）
function deepseekRequest(body) {
  return apiRequest({
    hostname: 'api.deepseek.com',
    path: '/v1/chat/completions',
    apiKey: DEEPSEEK_KEY,
    body
  });
}

// ========== 业务逻辑 ==========

async function gradeText(text, topic) {
  const prompt = renderPrompt(GRADING_PROMPT, topic, text);
  log('info', '文本批改', { provider: 'DeepSeek', model: MODEL_GRADING, promptVersion: PROMPT_VERSION, textLen: text.length });
  
  const result = await deepseekRequest({
    model: MODEL_GRADING,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    max_tokens: 4000
  });

  return parseResult(result);
}

async function gradeImage(imageUrl, topic) {
  log('info', '图片批改', { provider: 'DashScope', model: MODEL_OCR, promptVersion: PROMPT_VERSION });
  
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

  // 尝试修复常见 JSON 问题（尾部逗号）
  try {
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
      providers: {
        ocr: { name: 'DashScope', model: MODEL_OCR },
        grading: { name: 'DeepSeek', model: MODEL_GRADING }
      },
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
  console.log(`🚀 gaozhong.online AI API 已启动`);
  console.log(`📍 端口: ${PORT}`);
  console.log(`🔍 健康检查: http://localhost:${PORT}/health`);
  console.log(`📝 批改接口: POST /analyze`);
  console.log(`🤖 OCR: ${MODEL_OCR} (DashScope) | 批改: ${MODEL_GRADING} (DeepSeek) | Prompt: ${PROMPT_VERSION}`);
});
