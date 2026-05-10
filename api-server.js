#!/usr/bin/env node
/**
 * gaozhong.online - AI 作文批改 API 服务 (v2 - 异步队列版)
 *
 * 架构：提交即返回 taskId → 后台队列处理 → 客户端轮询结果
 * 并发控制：最多 3 个同时批改，队列深度上限 200
 * 模型分工：OCR(kimi-code) → 批改(deepseek-v4-pro)
 * Prompt：prompts/grading-v5.js
 *
 * 环境变量：
 *   KIMI_API_KEY      - 阿里云百炼 API Key（OCR 用 kimi-k2.6）
 *   DEEPSEEK_API_KEY  - DeepSeek API Key（批改用）
 */

import express from 'express';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { GRADING_PROMPT, PROMPT_VERSION } from './prompts/grading-v5.js';
import { ERROR_DIAGNOSIS_PROMPT } from './prompts/error-diagnosis.js';
import { renderPaperAnalysisPrompt } from './prompts/paper-analysis-v4.js';
import { STUDY_GUIDANCE_PROMPT_V1 } from './prompts/study-guidance-v1.js';
import { PAPER_SCANNER_VERSION, buildScannerMessages, postFilter, classifyErrors } from './prompts/paper-scanner-v5.js';
import { initDB, saveDB, saveRecord, getRecord, getHistory, getStats, createUser, getUserByEmail, getUserById, updateUser, changePassword, listUsers, saveErrorProblem, saveErrorKnowledgeTags, getErrorProblem, listErrorProblems, getErrorStats, getKnowledgeStats, getErrorsByKnowledgePoint, searchKnowledgePoints, createPaperSession, updatePaperSession, getPaperSession, listPaperSessions, listErrorsByPaper, listErrorsByTime, listErrorsBySubject, listErrorsForGuidance } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const MAX_CONCURRENT = 3;
const PAPER_MAX_CONCURRENT = 2;     // 整卷分析独立并发（任务重）
const MAX_QUEUE_DEPTH = 200;
const TASK_TTL_MS = 60 * 60 * 1000; // 1 小时
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟清理一次

// ========== 环境变量 ==========
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf-8')
      .split('\n')
      .filter(line => line.trim() && !line.trim().startsWith('#'))
      .forEach(line => {
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

const KIMI_KEY = process.env.KIMI_API_KEY;
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL_OCR = process.env.MODEL_OCR || 'kimi-k2.6';
const MODEL_GRADING = process.env.MODEL_GRADING || 'deepseek-v4-pro';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRES_IN = '7d';
const BCRYPT_ROUNDS = 10;

if (!DEEPSEEK_KEY) {
  console.error('❌ 错误: DEEPSEEK_API_KEY 未设置');
  process.exit(1);
}

import { execFileSync } from 'child_process';

// ========== HTTPS 连接池（高频复用，防连接泄漏） ==========
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  timeout: 120_000,
  keepAliveMsecs: 30_000
});

// ========== 日志 ==========
function log(level, msg, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }));
}

// ========== Task 队列系统 ==========
const tasks = new Map();

function createTaskId() {
  return crypto.randomUUID().slice(0, 8);
}

function createTask(input) {
  const id = createTaskId();
  const task = {
    id,
    status: 'queued',
    input,
    result: null,
    error: null,
    progress: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  tasks.set(id, task);
  return task;
}

function updateTask(id, patch) {
  const task = tasks.get(id);
  if (!task) return null;
  Object.assign(task, patch, { updatedAt: Date.now() });
  return task;
}

// ========== 并发队列 ==========
class ConcurrencyQueue {
  constructor(maxConcurrent) {
    this.max = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this.running < this.max && this.queue.length > 0) {
      const item = this.queue.shift();
      this.running++;
      item.fn()
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => { this.running--; this._drain(); });
    }
  }

  get pending() { return this.queue.length; }
  get active() { return this.running; }
}

const gradingQueue = new ConcurrencyQueue(MAX_CONCURRENT);

// 错题诊断 + 学习指导队列（任务较轻）
const errorQueue = new ConcurrencyQueue(MAX_CONCURRENT);
const ERROR_TASK_TTL_MS = 60 * 60 * 1000;

// 整卷分析独立队列（任务重，防阻塞错题诊断）
const paperQueue = new ConcurrencyQueue(PAPER_MAX_CONCURRENT);
const errorTasks = new Map();

// V2 队列
const paperTasks = new Map();
const PAPER_TASK_TTL_MS = 2 * 60 * 60 * 1000;
const guidanceTasks = new Map();
const GUIDANCE_TASK_TTL_MS = 60 * 60 * 1000;

// ========== 定期清理过期 task ==========
setInterval(() => {
  const now = Date.now();
  for (const [m, ttl] of [[tasks, TASK_TTL_MS], [errorTasks, ERROR_TASK_TTL_MS], [paperTasks, PAPER_TASK_TTL_MS], [guidanceTasks, GUIDANCE_TASK_TTL_MS]]) {
    for (const [id, task] of m) { if (now - task.createdAt > ttl) m.delete(id); }
  }
}, CLEANUP_INTERVAL_MS);

// ========== 限流器（简单令牌桶） ==========
// ========== 用户每日 Token 预算 ==========
const userTokenBudget = new Map();            // userId → { date, used }
const USER_DAILY_TOKEN_LIMIT = 10_000_000;     // 普通用户每日 1000 万 token
const ADMIN_EMAIL = 'admin@gaozhong.online';

function checkUserTokenBudget(userId, estimatedTokens) {
  if (!userId) return { allowed: true };       // 游客不限制
  const today = new Date().toISOString().slice(0, 10);
  const entry = userTokenBudget.get(userId);
  if (!entry || entry.date !== today) {
    userTokenBudget.set(userId, { date: today, used: estimatedTokens });
    return { allowed: true, used: estimatedTokens, limit: USER_DAILY_TOKEN_LIMIT };
  }
  entry.used += estimatedTokens;
  if (entry.used > USER_DAILY_TOKEN_LIMIT) {
    return { allowed: false, used: entry.used, limit: USER_DAILY_TOKEN_LIMIT };
  }
  return { allowed: true, used: entry.used, limit: USER_DAILY_TOKEN_LIMIT };
}

// 每日清理过期预算
setInterval(() => {
  const today = new Date().toISOString().slice(0, 10);
  for (const [uid, entry] of userTokenBudget) {
    if (entry.date !== today) userTokenBudget.delete(uid);
  }
}, 60 * 60 * 1000);

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60_000;   // 1 分钟窗口
const RATE_LIMIT_MAX = 20;          // 每 IP 每分钟最多 20 次提交

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return { allowed: true };
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return { allowed: false, retryAfter: Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW - now) / 1000) };
  }
  return { allowed: true };
}

// 组合校验：IP 限流 + 用户 Token 预算
function checkLimits(req, estimatedTokens = 5000) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const rl = checkRateLimit(ip);
  if (!rl.allowed) return { allowed: false, error: '请求过于频繁', retryAfter: rl.retryAfter, status: 429 };

  // admin 跳过 token 限制
  if (req.user?.email === ADMIN_EMAIL) return { allowed: true };

  const userId = req.user?.id;
  const budget = checkUserTokenBudget(userId, estimatedTokens);
  if (!budget.allowed) {
    return { allowed: false, error: `今日 Token 额度已用完（${(budget.used/1e6).toFixed(1)}M/${USER_DAILY_TOKEN_LIMIT/1e6}M），请明天再试`, status: 429 };
  }
  return { allowed: true, budget };
}

// ============ 以下：原有业务逻辑（保持完整） ============

// Prompt 渲染
function renderPrompt(template, topic = '', text = '') {
  return template
    .replace(/\{作文题目材料\}/g, topic || '(无)')
    .replace(/\{作文内容\}/g, text);
}

// 通用 API 请求
function apiRequest({ hostname, path, apiKey, body, port = null, timeout = 120_000 }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const isHttp = !!port; // 指定端口时使用 HTTP（如 Gateway 代理）
    const transport = isHttp ? http : https;
    const options = {
      hostname,
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(data)
      },
      timeout
    };
    if (!isHttp) options.agent = httpsAgent;
    const req = transport.request(options, (res) => {
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

function kimiRequest(body) {
  // 阿里云百炼 DashScope（kimi-k2.6 支持 vision，长超时）
  if (KIMI_KEY) {
    return apiRequest({
      hostname: 'dashscope.aliyuncs.com',
      path: '/compatible-mode/v1/chat/completions',
      apiKey: KIMI_KEY,
      body,
      timeout: 300_000
    });
  }
  throw new Error('KIMI_API_KEY not configured');
}

function deepseekRequest(body) {
  return apiRequest({
    hostname: 'api.deepseek.com',
    path: '/v1/chat/completions',
    apiKey: DEEPSEEK_KEY,
    body
  });
}

// 解析 Markdown 批改结果（完整保留 v5 解析器）
function parseMarkdownResult(content) {
  const result = {
    totalScore: 0, grade: '', essayType: '', wordCount: 0,
    dimensions: {}, rawScore: 0,
    adjustments: { plus: [], minus: [] }, adjustedScore: 0,
    strengths: [], weaknesses: [], suggestions: [],
    overall: '', gradingReason: '', revisions: [],
    oneSentenceSummary: '', fullCommentary: content, rawMarkdown: content
  };

  try {
    const scorePatterns = [
      /最终评分[：:]\s*(\d+)\s*分\s*\/\s*70\s*分/,
      /最终得分[：:]\s*(\d+)\s*分/,
      /\*\*最终得分[：:]\s*(\d+)\s*分\*\*/,
      /最终[：:]\s*(\d+)\s*分/
    ];
    for (const p of scorePatterns) {
      const m = content.match(p);
      if (m) { result.totalScore = parseInt(m[1]); break; }
    }

    const gradePatterns = [/（([^）]+)类卷[^）]*）/, /\*\*（([^）]+)类卷[^）]*）\*\*/, /档位[：:]\s*([^，\n]+)/, /评为[：:]\s*([^，\n]+)/];
    for (const p of gradePatterns) {
      const m = content.match(p);
      if (m) { result.grade = m[1].trim() + '类卷'; break; }
    }

    const wcPatterns = [/字数[：:]\s*(\d+)/, /(\d+)\s*字[，,。]/, /全文[：:]\s*(\d+)\s*字/];
    for (const p of wcPatterns) {
      const m = content.match(p);
      if (m) { result.wordCount = parseInt(m[1]); break; }
    }

    const sumPatterns = [/一句话总结[\s\n]*([\s\S]*?)(?=\n\n|$)/, /一句话概括[\s\n]*([\s\S]*?)(?=\n\n|$)/, /总结[：:][\s\n]*([\s\S]*?)(?=\n\n|$)/];
    for (const p of sumPatterns) {
      const m = content.match(p);
      if (m) { result.oneSentenceSummary = m[1].trim().replace(/[""]/g, '').substring(0, 200); break; }
    }

    const reasonPatterns = [/定档理由[\s\n]*([\s\S]*?)(?=\n---|\n###|\n##|$)/, /总体评价[\s\n]*([\s\S]*?)(?=\n---|\n###|\n##|$)/];
    for (const p of reasonPatterns) {
      const m = content.match(p);
      if (m) { result.gradingReason = m[1].trim().substring(0, 500); break; }
    }

    // 整体评价（3-4 句总评）
    const overallPatterns = [/整体评价[\s\n]*([\s\S]*?)(?=\n---|\n###\s|$)/, /总评[：:][\s\n]*([\s\S]*?)(?=\n---|\n###\s|$)/];
    for (const p of overallPatterns) {
      const m = content.match(p);
      if (m) { result.overall = m[1].trim().substring(0, 500); break; }
    }

    // 五维得分
    const dimKeys = ['审题立意', '思辨深度', '结构布局', '语言表达', '素材运用'];
    const dimFullNames = { '审题立意': 20, '思辨深度': 20, '结构布局': 20, '语言表达': 20, '素材运用': 20 };
    for (const dimKey of dimKeys) {
      const dimRegex = new RegExp(`####\\s*${dimKey}[（(](\\d+)/(\\d+)分?[）)]`, 'g');
      const dimMatch = dimRegex.exec(content);
      if (dimMatch) {
        const score = parseInt(dimMatch[1]);
        const full = parseInt(dimMatch[2]) || dimFullNames[dimKey] || 20;
        const sectionStart = content.indexOf(dimMatch[0]);
        const remaining = content.slice(sectionStart + dimMatch[0].length);
        const nextHeading = remaining.match(/\n####\s/);
        const sectionEnd = nextHeading ? sectionStart + dimMatch[0].length + nextHeading.index : content.length;
        let evalText = content.slice(sectionStart + dimMatch[0].length, sectionEnd)
          .replace(/^[-#\s*]+/gm, '').replace(/\n{2,}/g, '\n').trim().substring(0, 400);
        const deductionMatch = evalText.match(/扣分原因[：:]\s*([^\n]+)/);
        const deductionReason = deductionMatch ? deductionMatch[1].trim() : '';
        const strengths = [];
        const strengthMatches = evalText.matchAll(/[•·\-\*]\s*(?:\[如为亮点\]\s*)?原文引用[：:]\s*["""]([^""\n]+)["""]\s*——\s*([^\n]+)/g);
        for (const sm of strengthMatches) strengths.push(`${sm[1]} —— ${sm[2]}`);
        result.dimensions[dimKey] = { score, full, evaluation: evalText || '暂无评价', deductionReason, strengths: strengths.length > 0 ? strengths : undefined };
      }
    }

    // 加减分
    const plusSection = content.match(/\*\*加分项[：:]\*\*\s*([\s\S]*?)(?=\*\*扣分项|\*\*分数计算|\*\*加减分项|$)/);
    if (plusSection) {
      const items = plusSection[1].match(/[•·\-\*]\s*([^\n]+)/g);
      if (items) items.forEach(item => {
        const clean = item.replace(/[•·\-\*]\s*/, '').trim();
        const pts = clean.match(/[（(]([+\-]?\d+)分?[）)]/);
        result.adjustments.plus.push({ reason: clean.replace(/[（(][^）)]*[）)]/g, '').trim(), points: pts ? parseInt(pts[1]) : 0 });
      });
    }
    const minusSection = content.match(/\*\*扣分项[：:]\*\*\s*([\s\S]*?)(?=\*\*分数计算|分数计算|具体修改|$)/);
    if (minusSection) {
      const items = minusSection[1].match(/[•·\-\*]\s*([^\n]+)/g);
      if (items) items.forEach(item => {
        const clean = item.replace(/[•·\-\*]\s*/, '').trim();
        const pts = clean.match(/[（(]([+\-]?\d+)分?[）)]/);
        result.adjustments.minus.push({ reason: clean.replace(/[（(][^）)]*[）)]/g, '').trim(), points: pts ? parseInt(pts[1]) : 0 });
      });
    }

    const calcPatterns = [/维度得分之和[：:]\s*(\d+)/, /各维度得分之和[：:]\s*(\d+)/, /维度总分[：:]\s*(\d+)/];
    for (const p of calcPatterns) {
      const m = content.match(p);
      if (m) { result.rawScore = parseInt(m[1]); break; }
    }
    const adjPatterns = [/调整后\d+分制[：:]\s*(\d+)/, /调整后总分[：:]\s*(\d+)/, /加减后[：:]\s*(\d+)/];
    for (const p of adjPatterns) {
      const m = content.match(p);
      if (m) { result.adjustedScore = parseInt(m[1]); break; }
    }

    // 修改建议
    const revPattern = /####\s*修改\s*\d+[：:]\s*([^\n]+)\s*\n\s*\*\*位置\*\*[：:]\s*([^\n]+)\s*\n\s*\*\*原文\*\*[：:]\s*["""]?([^""\n]+)["""]?\s*\n\s*\*\*问题分析\*\*[：:]\s*([^\n]+)\s*\n\s*\*\*修改建议\*\*[：:]\s*["""]?([^""\n]+)["""]?\s*\n\s*\*\*修改理由\*\*[：:]\s*([^\n]+)/g;
    let revMatch;
    while ((revMatch = revPattern.exec(content)) !== null) {
      result.revisions.push({
        category: revMatch[1].trim(), location: revMatch[2]?.trim() || '',
        original: revMatch[3]?.trim() || '', suggested: revMatch[5]?.trim() || '',
        reason: revMatch[6]?.trim() || ''
      });
    }

    // 建议
    const suggMatch = content.match(/\*\*对该学生的建议[：:]\*\*\s*\n([\s\S]*?)(?=\n###|\n---|$)/);
    if (suggMatch) {
      const items = suggMatch[1].match(/\d+\.\s*([^\n]+)/g);
      if (items) result.suggestions = items.map(s => s.replace(/^\d+\.\s*/, '').trim());
    }

    // 升格路径
    const u2 = content.match(/要进入二类卷[，(（][^\n]*，需要[：:]\s*([^\n]+)/);
    const u1 = content.match(/要进入一类卷[，(（][^\n]*，需要[：:]\s*([^\n]+)/);
    if (u2 || u1) result.upgradePath = { toClass2: u2 ? u2[1].trim() : '', toClass1: u1 ? u1[1].trim() : '' };

  } catch (err) {
    log('warn', '解析 Markdown 出错', { error: err.message });
  }

  if (result.totalScore === 0 && result.grade === '') {
    result.grade = '解析中';
  }
  return result;
}

function parseResult(result) {
  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 返回为空');

  if (PROMPT_VERSION === 'v5') {
    const parsed = parseMarkdownResult(content);
    if (parsed.totalScore > 0) return parsed;
    return { totalScore: 0, grade: '解析中', essayType: '未知', fullCommentary: content, parseError: '自动解析失败，请查看完整评语' };
  }

  let cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  try {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch {}
  try {
    return JSON.parse(cleaned.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']'));
  } catch {}
  throw new Error('AI 返回格式错误');
}

async function gradeText(text, topic) {
  const prompt = renderPrompt(GRADING_PROMPT, topic, text);
  log('info', '文本批改', { provider: 'DeepSeek', model: MODEL_GRADING, version: PROMPT_VERSION, textLen: text.length });
  const result = await deepseekRequest({
    model: MODEL_GRADING,
    messages: [{ role: 'user', content: prompt }],
    temperature: 1,
    max_tokens: 6000
  });
  return parseResult(result);
}

async function gradeImage(imageUrl, topic) {
  log('info', 'OCR 识别', { provider: 'Kimi', model: MODEL_OCR });
  const ocrResult = await kimiRequest({
    model: MODEL_OCR,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '请仔细识别图片中的作文文字，尽量完整还原原文。只返回识别出的文字内容，不要其他分析。' },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    }],
    temperature: 1,
    max_tokens: 4000
  });

  const recognizedText = ocrResult.choices?.[0]?.message?.content || '';
  if (!recognizedText) throw new Error('OCR 识别失败');
  log('info', 'OCR 完成', { textLen: recognizedText.length });
  return await gradeText(recognizedText, topic);
}

// ========== Task 执行器 ==========
async function executeTask(task) {
  const { input } = task;
  try {
    updateTask(task.id, { status: 'processing', progress: { stage: input.type === 'image' ? 'ocr' : 'grading', message: '正在批改中...' } });
    let result;
    if (input.type === 'image') {
      updateTask(task.id, { progress: { stage: 'ocr', message: '正在识别图片文字...' } });
      result = await gradeImage(input.file, input.topic);
    } else {
      updateTask(task.id, { progress: { stage: 'grading', message: 'AI 正在批改作文...' } });
      result = await gradeText(input.text, input.topic);
    }

    // ✅ 先写入数据库，再更新 task 状态（保证数据不丢失）
    try {
      saveRecord({
        id: task.id,
        userId: input.userId || null,
        status: 'done',
        essayText: input.text || '',
        essayTopic: input.topic || '',
        inputType: input.type || 'text',
        totalScore: result.totalScore || 0,
        grade: result.grade || '',
        wordCount: result.wordCount || 0,
        dimensions: result.dimensions || {},
        adjustments: result.adjustments || { plus: [], minus: [] },
        revisions: result.revisions || [],
        suggestions: result.suggestions || [],
        rawMarkdown: result.rawMarkdown || result.fullCommentary || '',
        rawScore: result.rawScore || 0,
        adjustedScore: result.adjustedScore || 0,
        gradingReason: result.gradingReason || '',
        oneSentenceSummary: result.oneSentenceSummary || '',
        upgradePath: result.upgradePath || {},
        createdAt: task.createdAt
      });
      log('info', 'DB 保存成功', { taskId: task.id });
    } catch (dbErr) {
      log('error', 'DB 保存失败，但结果仍可在内存中获取', { taskId: task.id, error: dbErr.message });
    }

    updateTask(task.id, {
      status: 'done',
      result,
      persisted: true,
      progress: { stage: 'done', message: '批改完成' }
    });
    log('info', 'task 完成', { taskId: task.id, score: result.totalScore, grade: result.grade });
  } catch (err) {
    log('error', 'task 失败', { taskId: task.id, error: err.message });

    // 失败也记录到数据库
    try {
      saveRecord({
        id: task.id,
        userId: input.userId || null,
        status: 'failed',
        essayText: input.text || '',
        essayTopic: input.topic || '',
        inputType: input.type || 'text',
        error: err.message,
        createdAt: task.createdAt
      });
    } catch (_) {}

    updateTask(task.id, {
      status: 'failed',
      error: err.message,
      progress: { stage: 'failed', message: '批改失败' }
    });
  }
}

// ========== 错题诊断执行器 ==========

/** AI 错题诊断（DeepSeek） */
async function diagnoseError({ subject, questionText, wrongAnswer }) {
  const prompt = ERROR_DIAGNOSIS_PROMPT
    .replace(/\{subject\}/g, subject || '数学')
    .replace(/\{questionText\}/g, questionText || '')
    .replace(/\{wrongAnswer\}/g, wrongAnswer || '（未作答）');

  log('info', '错题AI诊断', { provider: 'DeepSeek', model: MODEL_GRADING, subject, questionLen: questionText?.length || 0 });

  const result = await deepseekRequest({
    model: MODEL_GRADING,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 2000
  });

  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 返回为空');

  // 解析 JSON（兼容 markdown 代码块包裹）
  let parsed;
  const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
    else throw new Error('AI 返回格式错误');
  }

  return {
    errorType: parsed.errorType || '未知',
    reason: parsed.reason || '',
    correctSolution: parsed.correctSolution || '',
    knowledgePoints: parsed.knowledgePoints || [],
    difficulty: Math.min(5, Math.max(1, parsed.difficulty || 3)),
    similarTips: parsed.similarTips || ''
  };
}

async function executeErrorTask(task) {
  const { id, input } = task;
  try {
    errorTasks.get(id).status = 'processing';
    errorTasks.get(id).progress = { stage: 'analyzing', message: 'AI 正在诊断...' };

    const result = await diagnoseError({
      subject: input.subject,
      questionText: input.questionText,
      wrongAnswer: input.wrongAnswer
    });

    // 知识点模糊匹配 → 写入关联表
    const matchedKpIds = [];
    for (const kpName of result.knowledgePoints) {
      const matches = searchKnowledgePoints(kpName, input.subject);
      if (matches.length > 0) matchedKpIds.push(matches[0].id);
    }

    // 保存到数据库
    saveErrorProblem({
      id,
      userId: input.userId || null,
      subject: input.subject || '数学',
      topic: input.topic || '',
      questionText: input.questionText || '',
      wrongAnswer: input.wrongAnswer || '',
      errorType: result.errorType,
      correctSolution: result.correctSolution,
      difficulty: result.difficulty,
      aiRaw: JSON.stringify(result),
      status: 'done',
      createdAt: task.createdAt
    });

    if (matchedKpIds.length > 0) {
      saveErrorKnowledgeTags(id, matchedKpIds);
    }

    errorTasks.get(id).status = 'done';
    errorTasks.get(id).result = {
      subject: input.subject,
      topic: input.topic,
      errorType: result.errorType,
      reason: result.reason,
      errorAnalysis: result.reason,
      correctSolution: result.correctSolution,
      knowledgePoints: result.knowledgePoints,
      difficulty: result.difficulty,
      similarTips: result.similarTips
    };
    errorTasks.get(id).progress = { stage: 'done', message: '诊断完成' };
    log('info', '错题诊断完成', { taskId: id, subject: input.subject, errorType: result.errorType, matchedKPs: matchedKpIds.length });
  } catch (err) {
    log('error', '错题诊断失败', { taskId: id, error: err.message });
    errorTasks.get(id).status = 'failed';
    errorTasks.get(id).error = err.message;
    errorTasks.get(id).progress = { stage: 'failed', message: '诊断失败' };
  }
}

// ========== V2 整卷分析：双阶段流水线 ==========

// 宿主机预处理服务地址（Docker 容器访问宿主机）
const PREPROCESS_URL = process.env.PREPROCESS_URL || 'http://172.17.0.1:5001';

/**
 * 调用宿主机预处理微服务
 * 对图片做：透视矫正 + 对比度增强 + 红笔分离 + 蓝黑笔分离 + 版面分析
 */
async function preprocessImage(base64) {
  try {
    const res = await fetch(`${PREPROCESS_URL}/preprocess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64, options: { deskew: true, red: true, blue: false, layout: false } }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.status === 'ok' ? data.result : null;
  } catch (err) {
    log('warn', '预处理服务不可用', { url: PREPROCESS_URL, error: err.message });
    return null;
  }
}

/**
 * 压缩图片（ImageMagick convert），限制宽度和 JPEG 质量
 * 返回 newBase64 和 actualWidth
 */
function compressImage(base64Url, maxWidth = 1200, quality = 65) {
  try {
    const match = base64Url.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return base64Url;
    const mime = match[1].split('/')[1] || 'jpeg';
    const buf = Buffer.from(match[2], 'base64');
    const startMs = Date.now();
    const result = execFileSync('convert', [
      '-', '-resize', `${maxWidth}x>`, '-quality', String(quality), `${mime}:-`
    ], {
      input: buf, maxBuffer: 20 * 1024 * 1024, timeout: 10000
    });
    const newB64 = result.toString('base64');
    const reduction = ((1 - newB64.length / match[2].length) * 100).toFixed(0);
    log('info', '图片压缩', { ms: Date.now() - startMs, before: `${(match[2].length/1024).toFixed(0)}KB`, after: `${(newB64.length/1024).toFixed(0)}KB`, reduction: `${reduction}%` });
    return `data:image/${mime};base64,${newB64}`;
  } catch (e) {
    log('warn', '图片压缩失败', { error: e.message, stderr: e.stderr?.toString()?.substring(0, 200) });
    return base64Url; // fallback
  }
}

/**

  const wrongQuestions = (parsed.wrongQuestions || []).map(q => ({ ...q, pageIndex }));
  return { wrongQuestions, paperMeta: parsed.paperMeta || null, learningProfile: parsed.learningProfile || null };
}

/**
 * 红笔像素验证：检测图片中是否有显著红笔标记
 * 使用 ImageMagick 提取红色通道特征
 * @returns {{ hasRed: boolean, redRatio: number }}
 */
function checkRedMarkings(imageBase64) {
  try {
    const match = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return { hasRed: false, redRatio: 0 };

    const buf = Buffer.from(match[2], 'base64');

    // 统计像素：红色 (R > G*1.4 AND R > B*1.4 AND R > 100) 的占比
    const redPixelCount = execFileSync('convert', [
      '-',
      // 选出红色像素
      '-fx', '(r > g*1.4 && r > b*1.4 && r > 0.39) ? 1 : 0',
      // 统计均值 = 红色像素占比
      '-format', '%[fx:mean]',
      'info:'
    ], { input: buf, timeout: 5000 });

    const redRatio = parseFloat(redPixelCount.toString().trim());
    // 红笔标记通常占图片面积 0.3%-5%
    const hasRed = redRatio > 0.002 && redRatio < 0.15;

    log('info', '红笔像素检测', { redRatio: redRatio.toFixed(4), hasRed });
    return { hasRed, redRatio };
  } catch (e) {
    log('warn', '红笔像素检测失败', { error: e.message });
    return { hasRed: true, redRatio: -1 }; // 无法检测时不做过滤
  }
}

/**
 * v5：双图视觉扫描 — 原图（上下文）+ 红笔分离图（标记检测）
 * 输入：原图 + 红笔分离图（可选，如果没有则退化为 v4 单图模式）
 * 输出：{ passageText, errors: [{ questionNumber, questionText, questionType, options, studentAnswer, correctAnswer, markDescription }] }
 */
async function scanPageV5(imageBase64, redMarksBase64, subject, pageIndex) {
  const compressed = compressImage(imageBase64, 1200, 55);
  const redCompressed = redMarksBase64 ? compressImage(redMarksBase64, 1200, 75) : null;

  const messages = buildScannerMessages({
    subject,
    imageBase64: compressed,
    redMarksBase64: redCompressed
  });

  const result = await kimiRequest({
    model: MODEL_OCR,
    messages,
    temperature: 1,
    max_tokens: 2000
  });

  const content = result.choices?.[0]?.message?.content;
  log('info', 'v5 扫描响应', { contentLen: content?.length || 0, preview: (content || '').substring(0, 400), endPreview: (content || '').slice(-200), hasRedMarks: !!redMarksBase64 });
  if (!content) { log('warn', 'v5 扫描返回空'); return { passageText: '', errors: [], warning: null }; }

  // JSON 提取
  let jsonStr = content
    .replace(/^```(?:json)?\s*\n?/gm, '')
    .replace(/\n?```\s*$/gm, '')
    .replace(/```/g, '')
    .trim();

  let parsed;
  try { parsed = JSON.parse(jsonStr); } catch (e1) {
    const m = jsonStr.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch {
        log('warn', 'v5 JSON 解析失败', { contentEnd: jsonStr.slice(-200) });
        return { passageText: '', errors: [], warning: null };
      }
    } else {
      log('warn', 'v5 无法提取 JSON', { contentEnd: jsonStr.slice(-200) });
      return { passageText: '', errors: [], warning: null };
    }
  }

  const rawErrors = Array.isArray(parsed) ? parsed : (parsed.errors || []);
  const { errors, warning: filterWarning } = postFilter(rawErrors, pageIndex);

  // 红笔信号验证：预处理返回的 red_signal 过低但 VL 声称多道错题 → 疑似幻觉
  const redCheck = checkRedMarkings(compressed);
  let redWarning = null;
  if (!redCheck.hasRed && errors.length >= 3) {
    redWarning = `第${pageIndex || '?'}页：图片未检测到红笔标记，但 VL 识别到 ${errors.length} 道错题，可能误判，请人工复核`;
    log('warn', '红笔验证-疑似误判', { pageIndex, errorCount: errors.length, redRatio: redCheck.redRatio });
  } else if (!redCheck.hasRed && errors.length > 0 && errors.length < 3) {
    redWarning = `第${pageIndex || '?'}页：仅 ${errors.length} 题，但未检测到红笔标记，请复核`;
  }

  const errorsWithPage = errors.map(q => ({ ...q, pageIndex }));
  const passageText = parsed.passageText || '';

  const allWarnings = [filterWarning, redWarning].filter(Boolean);
  const warning = allWarnings.length > 0 ? allWarnings.join('; ') : null;
  if (warning) log('warn', 'v5 异常检测', { pageIndex, warning });

  log('info', 'v5 扫描完成', { pageIndex, raw: rawErrors.length, filtered: errorsWithPage.length, hasPassage: !!passageText, hasRedMarks: !!redMarksBase64 });

  return { passageText, errors: errorsWithPage, warning };
}

/**
 * 阶段 2：深度分析 — 用 DeepSeek 对错题进行诊断
 * 批量处理：每批 ≤6 道题，多批并行（并发上限 3），避免超时
 */
async function analyzeErrors(subject, wrongQuestions) {
  const BATCH_SIZE = 6;
  const MAX_CONCURRENT_BATCHES = 3;
  const batches = [];
  for (let i = 0; i < wrongQuestions.length; i += BATCH_SIZE) {
    batches.push(wrongQuestions.slice(i, i + BATCH_SIZE));
  }

  log('info', '错题AI分析', {
    provider: 'DeepSeek', model: MODEL_GRADING, subject,
    errorCount: wrongQuestions.length, batches: batches.length, mode: 'parallel'
  });

  /**
   * 处理单个批次
   */
  async function processBatch(batch, b) {
    const startMs = Date.now();
    const prompt = renderPaperAnalysisPrompt(subject, batch);
    try {
      const result = await deepseekRequest({
        model: MODEL_GRADING,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 8000
      });

      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      const content = result.choices?.[0]?.message?.content;
      if (!content) throw new Error(`第${b + 1}批 AI 返回为空`);

      const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      let parsed;

      try {
        parsed = JSON.parse(cleaned);
      } catch (e1) {
        const m = cleaned.match(/\[[\s\S]*\]/);
        if (m) {
          try { parsed = JSON.parse(m[0]); } catch (e2) {
            const salvage = m[0].replace(/,\s*$/, '') + ']';
            try { parsed = JSON.parse(salvage); } catch (e3) {
              log('warn', '分批JSON解析失败', { batch: b + 1, error: e3.message, contentLen: content.length, contentEnd: content.slice(-200) });
              const objects = [...m[0].matchAll(/\{[^{}]*\{[^{}]*\}[^{}]*\}|\{[^{}]*\}/g)];
              if (objects.length > 0) {
                parsed = objects.map(o => { try { return JSON.parse(o[0]); } catch (_) { return null; } }).filter(Boolean);
              }
            }
          }
        }
        if (!parsed) {
          log('warn', '分批JSON完全不可解析', { batch: b + 1, error: e1.message, contentSample: content.substring(0, 500) });
          parsed = batch.map((q, i) => ({
            questionNumber: q.questionNumber,
            errorType: '未知',
            diagnosis: `AI 分析第${b + 1}批第${i + 1}题时返回格式异常，请重试`,
            solution: '',
            mnemonic: '',
            knowledgeCards: [],
            difficulty: 3
          }));
        }
      }

      log('info', `批次 ${b + 1}/${batches.length} 完成`, { elapsed: `${elapsed}s`, questions: batch.length });
      return Array.isArray(parsed) ? parsed : [];

    } catch (err) {
      log('error', '分批分析失败', { batch: b + 1, elapsed: `${((Date.now() - startMs) / 1000).toFixed(1)}s`, error: err.message });
      // 失败批次返回占位符
      return batch.map(q => ({
        questionNumber: q.questionNumber,
        errorType: '未知',
        diagnosis: `AI 调用失败：${err.message}`,
        solution: '',
        mnemonic: '',
        knowledgeCards: [],
        difficulty: 3
      }));
    }
  }

  // 并发处理所有批次（上限 3 并发）
  const allResults = [];
  for (let i = 0; i < batches.length; i += MAX_CONCURRENT_BATCHES) {
    const chunk = batches.slice(i, i + MAX_CONCURRENT_BATCHES);
    const chunkResults = await Promise.all(
      chunk.map((batch, j) => processBatch(batch, i + j))
    );
    for (const r of chunkResults) allResults.push(...r);
  }

  return allResults;
}

/**
 * 后处理校验：对扫描结果进行规则检查
 * 返回 { valid: [...], flagged: [...], stats }
 */
function validateScanResults(questions) {
  const valid = [];
  const flagged = [];
  
  for (const q of questions) {
    const issues = [];
    
    // 0. 确保 isUnanswered 字段存在
    if (q.isUnanswered === undefined) q.isUnanswered = false;
    
    // 1. 必填字段检查
    if (!q.questionNumber && q.questionNumber !== 0) issues.push('缺少题号');
    if (!q.isCorrect && q.isCorrect !== false) issues.push('缺少对错判断');
    
    // 2. 选择题答案格式检查
    if (q.questionType === '选择题' && q.studentAnswer) {
      const ans = q.studentAnswer.toUpperCase().trim();
      if (ans.length === 1 && /^[A-D]$/.test(ans)) {
        q.studentAnswer = ans;
      } else if (ans.length > 1 && /^[A-D]$/.test(ans[0])) {
        q.studentAnswer = ans[0];
      }
    }
    
    // 3. consistency check: 如有红笔写的答案≠学生答案 → 必须 isCorrect=false
    if (q.redInkContent && q.studentAnswer && q.correctAnswer) {
      if (q.studentAnswer !== q.correctAnswer && q.isCorrect === true) {
        issues.push(`矛盾：红笔正确答案=${q.correctAnswer}但标记为正确`);
        q.isCorrect = false;
      }
    }
    
    // 4. 扣分标记检查
    if (q.gradingMark && /-\d/.test(q.gradingMark) && q.isCorrect === true) {
      issues.push(`矛盾：有扣分标记但标记为正确`);
      q.isCorrect = false;
    }

    // 5. isUnanswered 一致性：未作答 + 无红笔标记 → 保持 isCorrect=false
    if (q.isUnanswered && !q.hasRedInk) {
      // 未作答且无红笔标记 → 确认 isCorrect=false（已在 prompt 中设定）
      if (q.isCorrect === true) {
        issues.push('未作答但标记为正确');
        q.isCorrect = false;
      }
    }
    
    // 6. 置信度
    if (!q.confidence) q.confidence = q.gradingMark ? 'high' : 'medium';
    
    if (issues.length > 0) {
      q._validationIssues = issues;
      flagged.push(q);
    } else {
      valid.push(q);
    }
  }
  
  const unanswered = questions.filter(q => q.isUnanswered).length;
  const wrong = questions.filter(q => !q.isCorrect && !q.isUnanswered).length;
  log('info', '扫描校验完成', { total: questions.length, valid: valid.length, flagged: flagged.length, wrong, unanswered });
  return { valid, flagged, stats: { total: questions.length, valid: valid.length, flagged: flagged.length, wrong, unanswered } };
}

/**
 * v5 流水线：executePaperTask
 *
 * 阶段 0: 预处理 (OpenCV, ~3s/页) → 矫正图 + 红笔分离图 + 红笔信号
 * 阶段 1: VL 双图扫描 v5 (Kimi k2.6, 原图+红笔图) → 错题列表 + 题型分类
 * 阶段 2: DeepSeek 深度分析 (仅 standard + reading 题型)
 *         听力题仅记录不做分析
 */
async function executePaperTask(task) {
  const { id, input } = task;
  try {
    paperTasks.get(id).status = 'processing';

    const totalPages = input.images.length;
    const allScanErrors = [];  // { pageIndex, errors: [], passageText }
    const allWarnings = [];    // 异常检测警告
    const redSignalByPage = {}; // 每页红笔信号强度

    // ===== 阶段 0：预处理所有页面（并行）=====
    paperTasks.get(id).progress = {
      stage: 'preprocess',
      message: `预处理试卷图片…`,
      current: 0, total: totalPages
    };

    const preprocessResults = await Promise.all(
      input.images.map(async (img, i) => {
        if (!img.startsWith('data:image')) return null;
        const result = await preprocessImage(img);
        if (result) {
          redSignalByPage[i + 1] = result.red_signal || 0;
          log('info', '预处理完成', {
            page: i + 1,
            hasRedMarks: !!(result.red_marks && result.red_marks.length > 200),
            redSignal: result.red_signal
          });
        }
        return { pageIndex: i + 1, result };
      })
    );

    // ===== 阶段 1：VL 双图扫描（并行）=====
    const scanPromises = preprocessResults.map((pr, i) => {
      if (!pr || !pr.result) return null;

      paperTasks.get(id).progress = {
        stage: 'scan-v5',
        message: `AI 正在扫描第 ${i + 1}/${totalPages} 页（双图对比识别错题）…`,
        current: i + 1, total: totalPages
      };

      const correctedImg = pr.result.corrected || input.images[i];
      const redMarksImg = pr.result.red_marks || null;

      return scanPageV5(correctedImg, redMarksImg, input.subject, i + 1).then(result => {
        log('info', 'v5 扫描完成', {
          taskId: id, page: i + 1,
          errorCount: result.errors.length,
          questions: result.errors.map(q => `Q${q.questionNumber}`),
          hasPassage: !!result.passageText,
          hasWarning: !!result.warning,
          hasRedMarks: !!redMarksImg
        });
        return { pageIndex: i + 1, ...result };
      });
    }).filter(Boolean);

    const scanResults = await Promise.all(scanPromises);
    for (const r of scanResults) {
      if (r.warning) allWarnings.push(r.warning);
      allScanErrors.push({ pageIndex: r.pageIndex, errors: r.errors, passageText: r.passageText });
    }

    // 合并所有页面的错题
    const allErrors = allScanErrors.flatMap(p => p.errors);
    // 收集所有阅读理解文章（按页索引）
    const passageMap = {};
    for (const p of allScanErrors) {
      if (p.passageText) passageMap[p.pageIndex] = p.passageText;
    }

    if (allErrors.length === 0) {
      log('info', '未检测到错题', { taskId: id });
      updatePaperSession(id, { status: 'done', errorCount: 0, totalQuestions: 0, correctCount: 0 });
      paperTasks.get(id).status = 'done';
      paperTasks.get(id).result = { subject: input.subject, sessionId: id, totalQuestions: 0, correctCount: 0, totalErrors: 0, pipeline: 'v5-dual-image' };
      paperTasks.get(id).progress = { stage: 'done', message: '未检测到错题 ✅' };
      return;
    }

    // ===== 阶段 3：按题型分类处理 =====
    const { standard, listening, reading } = classifyErrors(allErrors);

    let savedCount = 0, listeningCount = 0;

    // ----- 3a：听力题 — 仅记录，不分析 -----
    for (const q of listening) {
      const errorId = crypto.randomUUID().slice(0, 8);
      saveErrorProblem({
        id: errorId, userId: input.userId, subject: input.subject,
        topic: `第${q.questionNumber}题（听力）`,
        questionText: q.questionText || '(听力题，无题干)',
        questionType: '听力',
        answerOptions: JSON.stringify(q.options || {}),
        wrongAnswer: q.studentAnswer || '',
        correctAnswer: q.correctAnswer || '',
        errorType: '听力题（无文字题干）',
        correctSolution: '听力题无文字题干，无法自动归因分析。请自行复习听力原文。',
        difficulty: 0,
        knowledgeExplanation: '{}',
        gradingEvidence: q.markDescription || '',
        aiRaw: JSON.stringify({ pipeline: 'v5-dual-image', skipped: true, reason: 'listening', scan: q }),
        notes: '听力题 — 仅记录错题，不做归因分析',
        sessionId: id, paperIndex: q.pageIndex || 1, status: 'done',
        createdAt: Date.now()
      });
      listeningCount++;
    }

    // ----- 3b: 标准题 + 阅读理解题 — DeepSeek 分析 -----
    const needsAnalysis = [...standard, ...reading];

    if (needsAnalysis.length > 0) {
      paperTasks.get(id).progress = {
        stage: 'analyze-deepseek',
        message: `DeepSeek 正在分析 ${needsAnalysis.length} 道错题…`,
        current: 0, total: needsAnalysis.length
      };

      // 为阅读理解题注入 passageText 上下文
      const enrichedForAnalysis = needsAnalysis.map(q => {
        if (q.questionType === 'reading') {
          const passage = passageMap[q.pageIndex] || '';
          const passageContext = passage ? `【阅读理解文章】\n${passage}\n\n【题目】` : '';
          return {
            ...q,
            questionText: passageContext + (q.questionText || ''),
            // 保留原 options 格式兼容 renderPaperAnalysisPrompt
            options: q.options && typeof q.options === 'object' && !Array.isArray(q.options)
              ? Object.entries(q.options).map(([k, v]) => `${k}. ${v}`)
              : (q.options || [])
          };
        }
        // 标准题也处理 options 格式
        return {
          ...q,
          options: q.options && typeof q.options === 'object' && !Array.isArray(q.options)
            ? Object.entries(q.options).map(([k, v]) => `${k}. ${v}`)
            : (q.options || [])
        };
      });

      const analysisResults = await analyzeErrors(input.subject, enrichedForAnalysis);

      // 保存分析结果
      for (let j = 0; j < needsAnalysis.length; j++) {
        const q = needsAnalysis[j];
        const analysis = analysisResults[j] || {};
        const errorId = crypto.randomUUID().slice(0, 8);

        const knowledgePoints = analysis.knowledgePoints || [];
        const knowledgeExplJson = JSON.stringify(
          knowledgePoints.reduce((acc, kp) => { acc[kp] = ''; return acc; }, {})
        );

        saveErrorProblem({
          id: errorId, userId: input.userId, subject: input.subject,
          topic: `第${q.questionNumber}题（${q.questionType === 'reading' ? '阅读理解' : '选择题'}）`,
          questionText: q.questionText || '',
          questionType: q.questionType || '选择题',
          answerOptions: JSON.stringify(q.options || {}),
          wrongAnswer: q.studentAnswer || '',
          correctAnswer: q.correctAnswer || '',
          errorType: analysis.errorType || '未知',
          correctSolution: (analysis.diagnosis || '') + '\n\n' + (analysis.solution || ''),
          difficulty: analysis.difficulty || 3,
          knowledgeExplanation: knowledgeExplJson,
          gradingEvidence: q.markDescription || '',
          aiRaw: JSON.stringify({ pipeline: 'v5-dual-image', scan: q, analysis }),
          notes: analysis.remedy || '',
          sessionId: id, paperIndex: q.pageIndex || 1, status: 'done',
          createdAt: Date.now()
        });

        // 关联知识点
        if (knowledgePoints.length > 0) {
          const matchedKpIds = [];
          for (const kpName of knowledgePoints) {
            const matches = searchKnowledgePoints(kpName, input.subject);
            if (matches.length > 0) matchedKpIds.push(matches[0].id);
          }
          if (matchedKpIds.length > 0) saveErrorKnowledgeTags(errorId, matchedKpIds);
        }
        savedCount++;
      }
    }

    // 汇总
    const totalQuestions = allErrors.length;
    updatePaperSession(id, {
      status: 'done', errorCount: savedCount + listeningCount, totalQuestions, correctCount: 0,
      aiRaw: JSON.stringify({ pipeline: 'v5-dual-image', allErrors, passages: passageMap })
    });

    paperTasks.get(id).status = 'done';
    paperTasks.get(id).result = {
      subject: input.subject, sessionId: id,
      totalQuestions, correctCount: 0,
      totalErrors: savedCount + listeningCount,
      analyzedCount: savedCount, listeningCount,
      pipeline: 'v5-dual-image'
    };
    paperTasks.get(id).progress = {
      stage: 'done',
      message: `${totalQuestions} 错题 | ✅分析 ${savedCount} ${listeningCount > 0 ? `| 🎧听力 ${listeningCount}（仅记录）` : ''}${allWarnings.length > 0 ? ` | ⚠️ ${allWarnings[0]}` : ''} | v5.0`
    };

    log('info', 'v5 流水线完成', {
      taskId: id, subject: input.subject,
      total: totalQuestions, analyzed: savedCount, listening: listeningCount,
      warnings: allWarnings.length
    });

  } catch (err) {
    log('error', '整卷分析失败', { taskId: id, error: err.message, stack: err.stack?.substring(0, 300) });
    paperTasks.get(id).status = 'failed';
    paperTasks.get(id).error = err.message;
    paperTasks.get(id).progress = { stage: 'failed', message: err.message };
    try { updatePaperSession(id, { status: 'failed' }); } catch (_) {}
  }
}
// ========== V2 AI 学习指导执行器 ==========

async function executeGuidanceTask(task) {
  const { id, input } = task;
  try {
    guidanceTasks.get(id).status = 'processing';
    guidanceTasks.get(id).progress = { stage: 'analyzing', message: 'AI 正在分析学习状况…' };
    const errors = listErrorsForGuidance(input.userId, input.subject, input.timeFrom, input.timeTo);
    if (errors.length === 0) {
      guidanceTasks.get(id).status = 'done';
      guidanceTasks.get(id).result = { message: '该时间段内没有错题记录，无法生成学习指导。请先上传试卷获取错题分析。' };
      guidanceTasks.get(id).progress = { stage: 'done', message: '无错题数据' };
      return;
    }
    const errorSummary = {
      subject: input.subject, totalErrors: errors.length,
      byErrorType: {}, byDifficulty: { 1:0, 2:0, 3:0, 4:0, 5:0 },
      recentErrors: errors.slice(0, 10).map(e => ({ question: e.questionText?.substring(0, 100) || '', errorType: e.errorType, difficulty: e.difficulty }))
    };
    for (const e of errors) { errorSummary.byErrorType[e.errorType] = (errorSummary.byErrorType[e.errorType] || 0) + 1; errorSummary.byDifficulty[e.difficulty] = (errorSummary.byDifficulty[e.difficulty] || 0) + 1; }
    const prompt = STUDY_GUIDANCE_PROMPT_V1.replace(/\{s\}/g, input.subject).replace('{timeRange}', input.timeRange || '本学期开始至今').replace('{errorData}', JSON.stringify(errorSummary, null, 2));
    log('info', 'AI学习指导', { provider: 'DeepSeek', model: MODEL_GRADING, subject: input.subject, errorCount: errors.length });
    const result = await deepseekRequest({ model: MODEL_GRADING, messages: [{ role: 'user', content: prompt }], temperature: 0.5, max_tokens: 4000 });
    const content = result.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI 返回为空');
    const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch { const m = cleaned.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); else throw new Error('AI 返回格式错误'); }
    guidanceTasks.get(id).status = 'done'; guidanceTasks.get(id).result = parsed;
    guidanceTasks.get(id).progress = { stage: 'done', message: '学习指导生成完成' };
    log('info', '学习指导完成', { taskId: id, subject: input.subject });
  } catch (err) {
    log('error', '学习指导失败', { taskId: id, error: err.message });
    guidanceTasks.get(id).status = 'failed'; guidanceTasks.get(id).error = err.message;
    guidanceTasks.get(id).progress = { stage: 'failed', message: '分析失败' };
  }
}

// ========== Express 应用 ==========
const app = express();

// 中间件
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ========== Auth 中间件 ==========

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录，请先登录' });
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    const user = getUserById(payload.sub);
    if (!user) return res.status(401).json({ error: '用户不存在' });
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: '登录已过期，请重新登录' });
    }
    return res.status(401).json({ error: 'Token 无效' });
  }
}

function adminMiddleware(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '无权访问，需要管理员权限' });
  }
  next();
}

// ========== 路由 ==========

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'gaozhong-ai-api',
    version: '2.0-async',
    providers: { ocr: { name: 'Kimi', model: MODEL_OCR }, grading: { name: 'DeepSeek', model: MODEL_GRADING } },
    prompt: { version: PROMPT_VERSION, file: 'prompts/grading-v5.js' },
    scanner: { version: PAPER_SCANNER_VERSION, file: 'prompts/paper-scanner-v4.js' },
    queue: { grading: { active: gradingQueue.active, pending: gradingQueue.pending }, error: { active: errorQueue.active, pending: errorQueue.pending }, paper: { active: paperQueue.active, pending: paperQueue.pending, maxConcurrent: PAPER_MAX_CONCURRENT } },
    tasks: { memory: tasks.size, persistent: getStats() },
    uptime: Math.floor(process.uptime())
  });
});

// ========== 认证路由 ==========

// 注册
app.post('/auth/register', (req, res) => {
  const { email, password, nickname, region, grade, school } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: '邮箱和密码为必填项' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码长度不能少于6位' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }

  // 查重
  if (getUserByEmail(email)) {
    return res.status(409).json({ error: '该邮箱已被注册' });
  }

  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const user = createUser({
    email,
    passwordHash,
    nickname: nickname || email.split('@')[0],
    region: region || '上海',
    grade: grade || '',
    school: school || ''
  });

  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

  log('info', '用户注册', { userId: user.id, email: user.email, region: user.region });

  res.status(201).json({
    success: true,
    token,
    user: { id: user.id, email: user.email, nickname: user.nickname, region: user.region, grade: user.grade, school: user.school, role: user.role, mustChangePassword: user.mustChangePassword }
  });
});

// 登录
app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: '邮箱和密码为必填项' });
  }

  const user = getUserByEmail(email);
  if (!user) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }

  if (!bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }

  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

  log('info', '用户登录', { userId: user.id, email: user.email });

  res.json({
    success: true,
    token,
    user: { id: user.id, email: user.email, nickname: user.nickname, region: user.region, grade: user.grade, school: user.school, role: user.role, mustChangePassword: user.mustChangePassword }
  });
});

// 获取当前用户信息
app.get('/auth/me', authMiddleware, (req, res) => {
  res.json({
    success: true,
    user: { id: req.user.id, email: req.user.email, nickname: req.user.nickname, region: req.user.region, grade: req.user.grade, school: req.user.school, role: req.user.role, mustChangePassword: req.user.mustChangePassword, createdAt: req.user.createdAt }
  });
});

// 更新个人信息
app.put('/auth/me', authMiddleware, (req, res) => {
  const allowed = ['nickname', 'region', 'grade', 'school'];
  const fields = {};
  for (const k of allowed) {
    if (req.body[k] !== undefined) fields[k] = req.body[k];
  }
  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: '没有需要更新的字段' });
  }
  const user = updateUser(req.user.id, fields);
  log('info', '用户更新资料', { userId: user.id, fields: Object.keys(fields) });
  res.json({
    success: true,
    user: { id: user.id, email: user.email, nickname: user.nickname, region: user.region, grade: user.grade, school: user.school, role: user.role, mustChangePassword: user.mustChangePassword }
  });
});

// 修改密码
app.put('/auth/password', authMiddleware, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!newPassword) {
    return res.status(400).json({ error: '请提供新密码' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码长度不能少于6位' });
  }

  const fresh = getUserById(req.user.id);

  // mustChangePassword 首次改密：跳过旧密码验证
  if (fresh.mustChangePassword) {
    const newHash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
    changePassword(req.user.id, newHash);
    log('info', '用户首次修改密码', { userId: req.user.id });
    return res.json({ success: true, message: '密码修改成功' });
  }

  // 正常改密：需要验证旧密码
  if (!oldPassword) {
    return res.status(400).json({ error: '请提供旧密码' });
  }
  if (!bcrypt.compareSync(oldPassword, fresh.passwordHash)) {
    return res.status(401).json({ error: '旧密码错误' });
  }

  const newHash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
  changePassword(req.user.id, newHash);
  log('info', '用户修改密码', { userId: req.user.id });
  res.json({ success: true, message: '密码修改成功' });
});

// 管理员：用户列表
app.get('/admin/users', authMiddleware, adminMiddleware, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  const result = listUsers(page, limit);
  // 脱敏——不返回 passwordHash
  result.users = result.users.map(u => ({
    id: u.id, email: u.email, nickname: u.nickname, region: u.region,
    role: u.role, grade: u.grade, school: u.school,
    mustChangePassword: u.mustChangePassword, createdAt: u.createdAt
  }));
  res.json({ success: true, ...result });
});

// 提交批改任务（立即返回 taskId）
app.post('/analyze', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

  // 限流 + Token 预算检查（作文批改 ~15000 token）
  const limits = checkLimits(req, 15000);
  if (!limits.allowed) return res.status(limits.status || 429).json({ error: limits.error, retryAfter: limits.retryAfter });

  // 队列深度检查
  if (gradingQueue.pending >= MAX_QUEUE_DEPTH) {
    return res.status(503).json({ error: '当前排队人数过多，请稍后再试', queuePending: gradingQueue.pending });
  }

  const { text, file, topic = '' } = req.body;

  // 可选认证：有 token 则绑定用户
  let userId = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
      userId = payload.sub;
    } catch (_) { /* token 无效也允许匿名提交 */ }
  }

  if (!file && !text) {
    return res.status(400).json({ error: '请提供 text（文本）或 file（图片base64）' });
  }

  let input;
  if (file && file.startsWith('data:image')) {
    input = { type: 'image', file, topic, userId };
  } else if (text) {
    input = { type: 'text', text, topic, userId };
  } else {
    return res.status(400).json({ error: '不支持的文件格式' });
  }

  const task = createTask(input);
  log('info', 'task 创建', { taskId: task.id, type: input.type, ip, queuePending: gradingQueue.pending + 1 });

  // 入队执行（不阻塞响应）
  gradingQueue.enqueue(() => executeTask(task)).catch(err => {
    log('error', '队列执行异常', { taskId: task.id, error: err.message });
  });

  return res.status(202).json({
    success: true,
    taskId: task.id,
    status: 'queued',
    queuePosition: gradingQueue.pending + 1
  });
});

// 轮询任务状态
app.get('/task/:taskId', (req, res) => {
  const task = tasks.get(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: '任务不存在或已过期' });
  }

  const response = {
    taskId: task.id,
    status: task.status,
    progress: task.progress,
    queuePosition: task.status === 'queued' ? gradingQueue.pending : 0,
    result: task.status === 'done' ? task.result : undefined,
    error: task.status === 'failed' ? task.error : undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };

  res.json(response);
});

// 兼容旧接口（同步模式，保留过渡用）
app.post('/api/analyze', (req, res) => {
  return res.status(410).json({
    error: '此接口已升级为异步模式，请使用 /analyze 提交任务，然后通过 GET /task/:taskId 轮询结果',
    migration: { submit: 'POST /analyze', poll: 'GET /task/:taskId' }
  });
});

// 查询任务结果（DB 优先，内存回退）
app.get('/result/:taskId', (req, res) => {
  const { taskId } = req.params;

  // 先从数据库查
  const record = getRecord(taskId);
  if (record) {
    return res.json({
      success: true,
      source: 'database',
      result: record
    });
  }

  // 回退到内存（任务刚完成尚未被清理）
  const task = tasks.get(taskId);
  if (task && task.status === 'done') {
    return res.json({
      success: true,
      source: 'memory',
      result: task.result
    });
  }

  return res.status(404).json({ error: '记录不存在或已过期' });
});

// 历史记录
app.get('/history', authMiddleware, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));

  // 管理员看全部，普通用户只看自己的
  const userId = req.user.role === 'admin' ? null : req.user.id;
  const result = getHistory(userId, page, limit);
  res.json({ success: true, ...result });
});

// 统计
app.get('/stats', (req, res) => {
  const stats = getStats();
  res.json({ success: true, ...stats, memoryTasks: tasks.size });
});

// ========== 错题诊断 API ==========

// 提交错题诊断（异步）
app.post('/error/diagnose', (req, res) => {
  // 限流 + Token 预算检查（错题诊断 ~8000 token）
  const limits = checkLimits(req, 8000);
  if (!limits.allowed) return res.status(limits.status || 429).json({ error: limits.error, retryAfter: limits.retryAfter });
  if (errorQueue.pending >= MAX_QUEUE_DEPTH) return res.status(503).json({ error: '排队人数过多' });

  const { subject, topic, questionText, wrongAnswer, file } = req.body;

  // 可选认证
  let userId = null;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try { userId = jwt.verify(authHeader.slice(7), JWT_SECRET).sub; } catch (_) {}
  }

  if (!file && !questionText) {
    return res.status(400).json({ error: '请提供错题描述或图片' });
  }

  const taskId = createTaskId();
  const task = {
    id: taskId, status: 'queued',
    input: { subject: subject || '数学', topic: topic || '', questionText: questionText || '', wrongAnswer: wrongAnswer || '', file: file || null, userId },
    result: null, error: null, progress: null,
    createdAt: Date.now(), updatedAt: Date.now()
  };
  errorTasks.set(taskId, task);

  log('info', '错题诊断任务创建', { taskId, subject: task.input.subject, ip });

  errorQueue.enqueue(() => executeErrorTask(task)).catch(err => {
    log('error', '错题诊断队列异常', { taskId, error: err.message });
  });

  res.status(202).json({ success: true, taskId, status: 'queued', queuePosition: errorQueue.pending + 1 });
});

// 轮询错题诊断任务
app.get('/error/task/:taskId', (req, res) => {
  const task = errorTasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: '任务不存在或已过期' });
  res.json({
    taskId: task.id, status: task.status, progress: task.progress,
    result: task.status === 'done' ? task.result : undefined,
    error: task.status === 'failed' ? task.error : undefined,
    createdAt: task.createdAt, updatedAt: task.updatedAt
  });
});

// 错题列表
app.get('/error/list', authMiddleware, (req, res) => {
  const view = req.query.view || 'list';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));

  if (view === 'paper') {
    const result = listErrorsByPaper(req.user.id, { page, limit });
    return res.json({ success: true, view: 'paper', ...result });
  }
  if (view === 'time') {
    const period = req.query.period || 'month';
    const result = listErrorsByTime(req.user.id, { period });
    return res.json({ success: true, view: 'time', results: result });
  }
  if (view === 'subject') {
    const result = listErrorsBySubject(req.user.id);
    return res.json({ success: true, view: 'subject', results: result });
  }

  // 默认：传统列表视图（支持 sessionId 和 time 过滤下钻）
  const subject = req.query.subject || null;
  const sessionId = req.query.sessionId || null;
  const timeFrom = req.query.timeFrom ? parseInt(req.query.timeFrom) : null;
  const timeTo = req.query.timeTo ? parseInt(req.query.timeTo) : null;
  const result = listErrorProblems({ userId: req.user.id, subject, sessionId, timeFrom, timeTo, page, limit });
  res.json({ success: true, view: 'list', ...result });
});

// 错题详情
app.get('/error/:id', (req, res) => {
  let userId = null;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try { userId = jwt.verify(authHeader.slice(7), JWT_SECRET).sub; } catch (_) {}
  }
  const record = getErrorProblem(req.params.id, userId);
  if (!record) return res.status(404).json({ error: '错题记录不存在' });
  res.json({ success: true, record });
});

// 错题统计
app.get('/error/stats', authMiddleware, (req, res) => {
  const stats = getErrorStats(req.user.id);
  res.json({ success: true, ...stats });
});

// 知识点搜索
app.get('/knowledge/search', (req, res) => {
  const { q, subject } = req.query;
  if (!q || q.length < 1) return res.json({ success: true, results: [] });
  const results = searchKnowledgePoints(q, subject || null);
  res.json({ success: true, results });
});

// 知识点聚合统计
app.get('/knowledge/stats', authMiddleware, (req, res) => {
  const stats = getKnowledgeStats(req.user.id);
  res.json({ success: true, stats });
});

// 获取某知识点关联的错题列表
app.get('/knowledge/errors', authMiddleware, (req, res) => {
  const kpId = req.query.kpId;
  if (!kpId) return res.status(400).json({ error: '缺少 kpId' });
  const errors = getErrorsByKnowledgePoint(kpId, req.user.id);
  res.json({ success: true, errors });
});

// ========== V2 整卷分析 API ==========

app.post('/paper/analyze', authMiddleware, (req, res) => {
  // 限流 + Token 预算检查（整卷分析 ~50000 token）
  const limits = checkLimits(req, 50000);
  if (!limits.allowed) return res.status(limits.status || 429).json({ error: limits.error, retryAfter: limits.retryAfter });
  if (paperQueue.pending >= MAX_QUEUE_DEPTH) return res.status(503).json({ error: '排队人数过多' });

  const { subject, images, title } = req.body;
  if (!subject) return res.status(400).json({ error: '请选择学科' });
  if (!images || !Array.isArray(images) || images.length === 0) return res.status(400).json({ error: '请上传至少一张试卷图片' });
  if (images.length > 10) return res.status(400).json({ error: '单次最多上传 10 张图片' });
  const validSubjects = ['数学', '物理', '化学', '生物', '英语', '语文'];
  if (!validSubjects.includes(subject)) return res.status(400).json({ error: `无效学科，支持：${validSubjects.join('、')}` });

  const taskId = createTaskId();
  createPaperSession({ id: taskId, userId: req.user.id, subject, title: title || '', imageCount: images.length, status: 'pending' });
  const task = { id: taskId, status: 'queued', input: { subject, images, userId: req.user.id, title }, result: null, error: null, progress: null, createdAt: Date.now(), updatedAt: Date.now() };
  paperTasks.set(taskId, task);
  log('info', '整卷分析任务创建', { taskId, subject, imageCount: images.length, userId: req.user.id });
  paperQueue.enqueue(() => executePaperTask(task)).catch(err => { log('error', '整卷分析队列异常', { taskId, error: err.message }); });
  res.status(202).json({ success: true, taskId, status: 'queued', queuePosition: errorQueue.pending + 1, imageCount: images.length });
});

app.get('/paper/task/:taskId', (req, res) => {
  const task = paperTasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: '任务不存在或已过期' });

  // ETA 预估：基于平均处理时间 90s/份
  const AVG_PAGE_SECONDS = 90;
  const queueIndex = paperQueue.pending; // 前方排队数
  const etaSeconds = task.status === 'queued'
    ? (queueIndex + 1) * AVG_PAGE_SECONDS
    : task.status === 'processing'
      ? Math.max(30, AVG_PAGE_SECONDS - ((Date.now() - (task.startedAt || task.createdAt)) / 1000))
      : 0;

  res.json({
    taskId: task.id, status: task.status, progress: task.progress,
    result: task.status === 'done' ? task.result : undefined,
    error: task.status === 'failed' ? task.error : undefined,
    createdAt: task.createdAt, updatedAt: task.updatedAt,
    etaSeconds: Math.max(0, Math.round(etaSeconds)),
    queuePosition: task.status === 'queued' ? queueIndex + 1 : 0
  });
});

app.get('/paper/sessions', authMiddleware, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const subject = req.query.subject || null;
  const result = listPaperSessions(req.user.id, { page, limit, subject });
  res.json({ success: true, ...result });
});

// ========== V2 AI 学习指导 API ==========

app.post('/paper/guidance', authMiddleware, (req, res) => {
  // 限流 + Token 预算检查（学习指导 ~10000 token）
  const limits = checkLimits(req, 10000);
  if (!limits.allowed) return res.status(limits.status || 429).json({ error: limits.error, retryAfter: limits.retryAfter });

  const { subject, timeFrom, timeTo, timeRange } = req.body;
  if (!subject) return res.status(400).json({ error: '请选择学科' });
  const validSubjects = ['数学', '物理', '化学', '生物', '英语', '语文'];
  if (!validSubjects.includes(subject)) return res.status(400).json({ error: `无效学科，支持：${validSubjects.join('、')}` });

  const taskId = createTaskId();
  const task = { id: taskId, status: 'queued', input: { userId: req.user.id, subject, timeFrom: timeFrom || null, timeTo: timeTo || null, timeRange: timeRange || '本学期开始至今' }, result: null, error: null, progress: null, createdAt: Date.now(), updatedAt: Date.now() };
  guidanceTasks.set(taskId, task);
  log('info', '学习指导任务创建', { taskId, subject, userId: req.user.id });
  errorQueue.enqueue(() => executeGuidanceTask(task)).catch(err => { log('error', '学习指导队列异常', { taskId, error: err.message }); });
  res.status(202).json({ success: true, taskId, status: 'queued' });
});

app.get('/paper/guidance/:taskId', (req, res) => {
  const task = guidanceTasks.get(req.params.taskId);
  if (!task) return res.status(404).json({ error: '任务不存在或已过期' });
  res.json({ taskId: task.id, status: task.status, progress: task.progress, result: task.status === 'done' ? task.result : undefined, error: task.status === 'failed' ? task.error : undefined, createdAt: task.createdAt, updatedAt: task.updatedAt });
});

// 404
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    endpoints: ['GET /health', 'POST /analyze', 'GET /task/:taskId', 'GET /result/:taskId',
      'POST /auth/login', 'POST /auth/register', 'GET /auth/me', 'PUT /auth/password',
      'GET /history', 'GET /stats', 'GET /admin/users',
      'POST /error/diagnose', 'GET /error/task/:taskId', 'GET /error/list?view=paper|time|subject|list', 'GET /error/:id', 'GET /error/stats',
      'GET /knowledge/search', 'GET /knowledge/stats',
      'POST /paper/analyze', 'GET /paper/task/:taskId', 'GET /paper/sessions',
      'POST /paper/guidance', 'GET /paper/guidance/:taskId']
  });
});

// 异常处理
app.use((err, req, res, next) => {
  log('error', '未捕获异常', { error: err.message, stack: err.stack?.substring(0, 200) });
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求体过大，请压缩图片或使用文字输入' });
  }
  res.status(500).json({ error: '服务器内部错误' });
});

// ========== 管理员播种 ==========
function ensureAdmin() {
  const adminEmail = 'admin@gaozhong.online';
  const exists = getUserByEmail(adminEmail);
  if (exists) return;

  const passwordHash = bcrypt.hashSync('123456', BCRYPT_ROUNDS);
  createUser({
    email: adminEmail,
    passwordHash,
    nickname: '管理员',
    role: 'admin',
    mustChangePassword: 1
  });
  log('info', '管理员账号已创建', { email: adminEmail });
  console.log('🔑 管理员账号: admin@gaozhong.online / 123456（登录后需修改密码）');
}

// ========== 启动 ==========
const startup = async () => {
  // 初始化数据库
  await initDB();

  // 确保管理员存在
  ensureAdmin();

  // 清理启动前可能遗留的 processing 状态
  const dbStats = getStats();
  if (dbStats.total > 0) {
    log('info', 'DB 统计', dbStats);
  }

  app.listen(PORT, () => {
    console.log(`🚀 gaozhong.online AI API v2 (异步队列) 已启动`);
    console.log(`📍 端口: ${PORT}`);
    console.log(`🔍 健康检查: http://localhost:${PORT}/health`);
    console.log(`📝 作文: POST /analyze | 📄 整卷: POST /paper/analyze | 🧠 指导: POST /paper/guidance`);
    console.log(`💾 结果: GET /result/:taskId | 历史: GET /history | 错题: GET /error/list?view=paper|time|subject`);
    console.log(`⚡ 作文/错题并发: ${MAX_CONCURRENT} | 整卷分析并发: ${PAPER_MAX_CONCURRENT} | 队列上限: ${MAX_QUEUE_DEPTH}`);
    console.log(`🤖 OCR: ${MODEL_OCR} | 分析: ${MODEL_GRADING} | Prompt: ${PROMPT_VERSION} | Scanner: ${PAPER_SCANNER_VERSION}`);
  });
};

startup();
