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

// Scanner v1.0 版本号
const SCANNER_VERSION = 'v1.0';
import { initDB, saveDB, saveRecord, getRecord, getHistory, getStats, createUser, getUserByEmail, getUserById, updateUser, changePassword, listUsers, saveErrorProblem, saveErrorKnowledgeTags, getErrorProblem, listErrorProblems, getErrorStats, getKnowledgeStats, getErrorsByKnowledgePoint, searchKnowledgePoints, createPaperSession, updatePaperSession, getPaperSession, listPaperSessions, listErrorsByPaper, listErrorsByTime, listErrorsBySubject, listErrorsForGuidance, saveReview, updateErrorReviewStatus, deleteErrorProblem, getSessionReviews, resetStalledPaperSessions } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const MAX_CONCURRENT = 3;
const PAPER_MAX_CONCURRENT = 2;     // 整卷分析独立并发（任务重）
const VL_SCAN_CONCURRENCY = 4;      // VL 扫描并行上限（防 API 限流）
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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const res = await fetch(`${PREPROCESS_URL}/preprocess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64, options: { deskew: true, red: true, blue: false, layout: false } }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const data = await res.json();
      return data.status === 'ok' ? data.result : null;
    } catch (err) {
      if (attempt < 2) {
        log('warn', '预处理重试', { attempt: attempt + 1, error: err.message });
        await new Promise(r => setTimeout(r, 2000));
      } else {
        log('warn', '预处理服务不可用', { url: PREPROCESS_URL, error: err.message });
        return null;
      }
    }
  }
  return null;
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

// v7.1: 红笔突出图 + 简洁 prompt
async function scanPageHighlight(highlightedBase64) {
  if (!highlightedBase64) return [];
  const compressed = compressImage(highlightedBase64, 1400, 75);
  try {
    const result = await kimiRequest({
      model: MODEL_OCR,
      messages: [
        { role: 'system', content: '只输出JSON数组，无其他文字。' },
        { role: 'user', content: [
          { type: 'text', text: '图中非红笔区域已淡化。红色笔迹（可见的标记）是老师批改。输出做错的题: [{"studentAnswer":"学生答案","correctAnswer":"正确答案","reason":"错误原因"}]。没有错题输出[]。' },
          { type: 'image_url', image_url: { url: compressed, detail: 'auto' } }
        ]}
      ],
      temperature: 0.3,
      max_tokens: 2000
    });
    const content = (result.choices?.[0]?.message?.content || '').trim();
    try {
      const cleaned = content.replace(/```json|```/g, '').trim();
      return JSON.parse(cleaned);
    } catch {
      const m = content.match(/\[[\s\S]*\]/);
      return m ? JSON.parse(m[0]) : [];
    }
  } catch { return []; }
}

// ========== 科目自动识别 ==========

const AUTO_SUBJECTS = ['数学', '物理', '化学', '生物', '英语', '语文', '自动'];

/**
 * 用 VL 快速识别试卷科目（只取第一页压缩图，单次轻量调用）
 * @returns {string} 识别出的科目，或原 subject（fallback）
 */
async function detectSubject(firstPageBase64, fallback) {
  try {
    const compressed = compressImage(firstPageBase64, 800, 40);
    const messages = [{
      role: 'system',
      content: '你是高中试卷科目识别器。只看试卷内容（题目文字、公式、图表），判断这是什么科目的试卷。只回复一个词：数学/物理/化学/生物/英语/语文。不要说其他话。'
    }, {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: compressed, detail: 'low' } }
      ]
    }];

    const result = await kimiRequest({
      model: MODEL_OCR,
      messages,
      temperature: 0.1,
      max_tokens: 20
    });

    const content = (result.choices?.[0]?.message?.content || '').trim();
    for (const s of AUTO_SUBJECTS) {
      if (content.includes(s)) {
        log('info', '自动识别科目', { detected: s, raw: content });
        return s;
      }
    }
    log('info', '科目识别失败，使用默认', { raw: content, fallback });
    return fallback;
  } catch (err) {
    log('warn', '科目识别异常', { error: err.message });
    return fallback;
  }
}

/**
 * 阶段 3：DeepSeek 单题纯文本分析
 */
async function analyzeSingleError(subject, errorInfo) {
  const prompt = `你是高中${subject}老师。学生这道题做错了，请分析。

学生答案: ${errorInfo.studentAnswer || '未知'}
正确答案: ${errorInfo.correctAnswer || '未知'}
初步归类: ${errorInfo.errorType || '未知'}

请输出JSON:
{
  "errorType": "语法/词汇/逻辑/概念/计算/审题/未知",
  "errorReason": "为什么错了（中文，1-2句）",
  "knowledgePoint": "考察的知识点（中文）"
}`;

  try {
    const result = await deepseekRequest({
      model: MODEL_GRADING,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1000
    });
    
    const content = (result.choices?.[0]?.message?.content || '').trim();
    try {
      const cleaned = content.replace(/```json|```/g, '').trim();
      return JSON.parse(cleaned);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) try { return JSON.parse(m[0]); } catch {}
      return { errorType: errorInfo.errorType || '未知', errorReason: content.slice(0, 100), knowledgePoint: '' };
    }
  } catch (e) {
    return { errorType: '未知', errorReason: '', knowledgePoint: '' };
  }
}

/**
 * 阶段 2：深度分析 — 用 DeepSeek 对错题进行诊断（旧版，保留兼容）
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
 * v1.0 流水线: 阶段1 切题 → 阶段2 裁切批处理判错 → 阶段3 DeepSeek纯文本分析
 */
async function executePaperTask(task) {
  const { id, input } = task;
  try {
    paperTasks.get(id).status = 'processing';

    // 自动识别科目
    let subject = input.subject;
    if (!subject || subject === '自动') {
      const firstImg = input.images.find(img => img && img.startsWith('data:image'));
      if (firstImg) {
        paperTasks.get(id).progress = { stage: 'detect', message: '正在识别科目…' };
        subject = await detectSubject(firstImg, '英语');
        input.subject = subject;
        updatePaperSession(id, { subject });
      }
    }

    const totalPages = input.images.length;

    // ===== 阶段 0：保存原始图片 =====
    const PAPERS_DIR = '/app/data/papers';
    const sessionDir = path.join(PAPERS_DIR, id);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const savedPaths = [];
    for (let i = 0; i < input.images.length; i++) {
      const img = input.images[i];
      if (!img.startsWith('data:image')) continue;
      const match = img.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!match) continue;
      const ext = match[1] === 'png' ? 'png' : 'jpg';
      const buf = Buffer.from(match[2], 'base64');
      const pagePath = path.join(sessionDir, `page_${i + 1}.${ext}`);
      fs.writeFileSync(pagePath, buf);
      savedPaths.push(pagePath);
      try {
        const thumbPath = path.join(sessionDir, `thumb_${i + 1}.jpg`);
        execFileSync('convert', [pagePath, '-resize', '300x>', '-quality', '60', thumbPath], { timeout: 5000 });
      } catch (_) {}
    }
    updatePaperSession(id, { imagePaths: JSON.stringify(savedPaths) });
    log('info', '图片保存完成', { taskId: id, pages: savedPaths.length });

    // ===== 阶段 1+2：扫描每页 =====
    const scanner = await import('./scanner-v1.mjs');
    let allErrors = [];

    for (let i = 0; i < savedPaths.length; i++) {
      const pageIdx = i + 1;
      const pagePath = savedPaths[i];
      
      paperTasks.get(id).progress = {
        stage: 'scan',
        message: `AI 扫描第 ${pageIdx}/${totalPages} 页…`,
        current: pageIdx, total: totalPages
      };

      try {
        const result = await scanner.scanPage(pagePath, {
          apiKey: KIMI_KEY,
          outputDir: sessionDir,
          pageIndex: pageIdx
        });

        log('info', `v1.0 扫描完成 page${pageIdx}`, {
          questions: result.questions,
          errors: result.errors,
          needsReview: result.needsReview
        });

        for (const err of result.errorItems) {
          allErrors.push({
            pageIndex: pageIdx,
            questionNumber: err.questionNumber,
            studentAnswer: err.studentAnswer || '',
            correctAnswer: err.correctAnswer || '',
            teacherIntent: err.teacherIntent || '',
            errorType: err.errorType || '未知',
            confidence: err.confidence || 'medium',
            needsReview: err.needsReview || false,
            reviewReason: err.reviewReason || '',
            questionType: ''  // will be filled from crop data
          });
        }

        paperTasks.get(id).progress = {
          stage: 'scan',
          message: `第 ${pageIdx}/${totalPages} 页: ${result.questions}题, ${result.errors}道错题`,
          current: pageIdx, total: totalPages
        };

      } catch (pageErr) {
        log('warn', `v1.0 扫描页失败 page${pageIdx}`, { error: pageErr.message });
      }
    }

    if (allErrors.length === 0) {
      log('info', '未检测到错题', { taskId: id });
      updatePaperSession(id, { status: 'done', errorCount: 0, totalQuestions: 0 });
      paperTasks.get(id).status = 'done';
      paperTasks.get(id).result = { subject, sessionId: id, totalErrors: 0, pipeline: SCANNER_VERSION };
      paperTasks.get(id).progress = { stage: 'done', message: '未检测到错题 ✅' };
      return;
    }

    // ===== 阶段 3：DeepSeek 纯文本分析 =====
    paperTasks.get(id).progress = {
      stage: 'analyze',
      message: `DeepSeek 分析 ${allErrors.length} 道错题…`,
      current: 0, total: allErrors.length
    };

    let savedCount = 0;
    for (let j = 0; j < allErrors.length; j++) {
      const q = allErrors[j];
      
      paperTasks.get(id).progress = {
        stage: 'analyze',
        message: `DeepSeek 分析 ${j + 1}/${allErrors.length}…`,
        current: j + 1, total: allErrors.length
      };

      try {
        const analysis = await analyzeSingleError(subject, {
          questionNumber: q.questionNumber,
          studentAnswer: q.studentAnswer,
          correctAnswer: q.correctAnswer,
          errorType: q.errorType
        });

        const errorId = crypto.randomUUID().slice(0, 8);
        saveErrorProblem({
          id: errorId, userId: input.userId, subject,
          topic: `错题 Q${q.questionNumber}`,
          questionText: '',
          questionType: q.questionType || 'unknown',
          answerOptions: '{}',
          wrongAnswer: q.studentAnswer || '',
          correctAnswer: q.correctAnswer || '',
          errorType: analysis.errorType || q.errorType || '未知',
          correctSolution: (analysis.errorReason || '') + '\n' + (analysis.knowledgePoint || ''),
          difficulty: 3,
          knowledgeExplanation: '{}',
          gradingEvidence: q.teacherIntent || '',
          aiRaw: JSON.stringify({ pipeline: SCANNER_VERSION, ...q, analysis }),
          notes: '',
          sessionId: id, paperIndex: q.pageIndex || 1, status: 'done',
          reviewStatus: q.needsReview ? 'pending' : 'confirmed',
          createdAt: Date.now()
        });
        savedCount++;
        log('info', `错题已保存`, { qid: errorId, questionNumber: q.questionNumber, confidence: q.confidence });
      } catch (e) {
        log('warn', `DeepSeek 分析失败 Q${q.questionNumber}`, { error: e.message });
        // 即使分析失败也保存基本信息
        const errorId = crypto.randomUUID().slice(0, 8);
        saveErrorProblem({
          id: errorId, userId: input.userId, subject,
          topic: `错题 Q${q.questionNumber}`,
          questionText: '', questionType: 'unknown', answerOptions: '{}',
          wrongAnswer: q.studentAnswer || '',
          correctAnswer: q.correctAnswer || '',
          errorType: q.errorType || '未知',
          correctSolution: q.teacherIntent || '',
          difficulty: 3, knowledgeExplanation: '{}',
          gradingEvidence: q.teacherIntent || '',
          aiRaw: JSON.stringify({ pipeline: SCANNER_VERSION, ...q }),
          notes: '', sessionId: id, paperIndex: q.pageIndex || 1, status: 'done',
          reviewStatus: q.needsReview ? 'pending' : 'confirmed',
          createdAt: Date.now()
        });
        savedCount++;
      }
    }

    const reviewCount = allErrors.filter(e => e.needsReview).length;
    updatePaperSession(id, {
      status: 'done', errorCount: savedCount, totalQuestions: allErrors.length
    });

    paperTasks.get(id).status = 'done';
    paperTasks.get(id).result = {
      subject, sessionId: id,
      totalErrors: savedCount,
      pipeline: SCANNER_VERSION,
      needsReview: reviewCount
    };
    paperTasks.get(id).progress = {
      stage: 'done',
      message: `${savedCount} 道错题已整理${reviewCount > 0 ? `（${reviewCount}道需复核）` : ''} | ${SCANNER_VERSION}`
    };

    log('info', 'v1.0 流水线完成', { taskId: id, subject, errors: savedCount, needsReview: reviewCount });

  } catch (err) {
    log('error', '整卷分析失败', { taskId: id, error: err.message });
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
    scanner: { version: SCANNER_VERSION, engine: '切题+裁切批处理VL判错+v1.0 DeepSeek纯文本', file: 'scanner-v1.mjs' },
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

// 错题统计（必须在 /error/:id 之前，否则 stats 会被 :id 捕获）
app.get('/error/stats', authMiddleware, (req, res) => {
  const stats = getErrorStats(req.user.id);
  res.json({ success: true, ...stats });
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
  const validSubjects = ['数学', '物理', '化学', '生物', '英语', '语文', '自动'];
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
  // ETA 预估：预处理 3s/页 + VL 扫描 (页数/并发批数)×40s + DeepSeek 分析 90s
  const AVG_PAGE_SECONDS = 90;
  const pageCount = task.input?.images?.length || task.input?.imageCount || 1;
  const batches = Math.ceil(pageCount / (VL_SCAN_CONCURRENCY || 4));
  const estimatedTotal = pageCount * 3 + batches * 40 + 90;
  const queueIndex = paperQueue.pending;
  const etaSeconds = task.status === 'queued'
    ? (queueIndex + 1) * estimatedTotal
    : task.status === 'processing'
      ? Math.max(30, estimatedTotal - ((Date.now() - (task.startedAt || task.createdAt)) / 1000))
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
  const validSubjects = ['数学', '物理', '化学', '生物', '英语', '语文', '自动'];
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

// ========== 图片服务 ==========

app.get('/paper/:sessionId/images/:pageIndex', (req, res) => {
  const { sessionId, pageIndex } = req.params;
  const pagePath = path.join('/app/data/papers', sessionId, `page_${pageIndex}.jpg`);
  const pngPath = path.join('/app/data/papers', sessionId, `page_${pageIndex}.png`);

  let imgPath = null;
  if (fs.existsSync(pagePath)) imgPath = pagePath;
  else if (fs.existsSync(pngPath)) imgPath = pngPath;

  if (!imgPath) return res.status(404).json({ error: '图片不存在' });

  const ext = path.extname(imgPath).slice(1);
  res.setHeader('Content-Type', `image/${ext === 'png' ? 'png' : 'jpeg'}`);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(imgPath).pipe(res);
});

app.get('/paper/:sessionId/thumb/:pageIndex', (req, res) => {
  const { sessionId, pageIndex } = req.params;
  const thumbPath = path.join('/app/data/papers', sessionId, `thumb_${pageIndex}.jpg`);
  if (!fs.existsSync(thumbPath)) {
    return res.redirect(`/api/paper/${sessionId}/images/${pageIndex}`);
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(thumbPath).pipe(res);
});

// 红笔分离图
app.get('/paper/:sessionId/red/:pageIndex', (req, res) => {
  const { sessionId, pageIndex } = req.params;
  const redPath = path.join('/app/data/papers', sessionId, `red_${pageIndex}.jpg`);
  if (!fs.existsSync(redPath)) return res.status(404).json({ error: '红笔图不存在' });
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(redPath).pipe(res);
});

// 标注图
app.get('/paper/:sessionId/annotated/:pageIndex', (req, res) => {
  const { sessionId, pageIndex } = req.params;
  const annPath = path.join('/app/data/papers', sessionId, `annotated_${pageIndex}.jpg`);
  if (!fs.existsSync(annPath)) return res.status(404).json({ error: '标注图不存在（需重启预处理服务）' });
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(annPath).pipe(res);
});

// 区域裁剪图
app.get('/paper/:sessionId/region/:filename', (req, res) => {
  const { sessionId, filename } = req.params;
  const regionPath = path.join('/app/data/papers', sessionId, filename);
  if (!fs.existsSync(regionPath)) return res.status(404).json({ error: '区域图不存在' });
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  fs.createReadStream(regionPath).pipe(res);
});

// ========== 错题复核 API ==========

// 获取复核页面数据：session 信息 + 所有错题 + 原始图片列表 + 已有复核记录
// 试卷元数据（供错题本页面使用）
app.get('/paper/:sessionId', authMiddleware, (req, res) => {
  const session = getPaperSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: '试卷不存在' });
  if (session.userId !== req.user.id) return res.status(403).json({ error: '无权访问' });
  res.json({ success: true, session });
});

app.get('/paper/:sessionId/review', authMiddleware, (req, res) => {
  const session = getPaperSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: '试卷不存在' });
  if (session.userId !== req.user.id) return res.status(403).json({ error: '无权访问' });

  const errors = listErrorProblems({ userId: req.user.id, sessionId: req.params.sessionId, limit: 200 });
  const reviews = getSessionReviews(req.params.sessionId);
  const imagePaths = session.imagePaths ? (() => { try { return JSON.parse(session.imagePaths); } catch { return []; } })() : [];

  // 构建每页图片的 URL
  const images = [];
  if (imagePaths.length > 0) {
    for (let i = 0; i < imagePaths.length; i++) {
      images.push({
        pageIndex: i + 1,
        url: `/api/paper/${req.params.sessionId}/thumb/${i + 1}`,
        originalUrl: `/api/paper/${req.params.sessionId}/images/${i + 1}`,
        redMarksUrl: `/api/paper/${req.params.sessionId}/red/${i + 1}`,
        annotatedUrl: `/api/paper/${req.params.sessionId}/annotated/${i + 1}`
      });
    }
  } else {
    // 如果 session 是旧数据没有 imagePaths，尝试文件系统查找
    const sessionDir = path.join('/app/data/papers', req.params.sessionId);
    if (fs.existsSync(sessionDir)) {
      const files = fs.readdirSync(sessionDir).filter(f => f.startsWith('page_'));
      for (const f of files.sort()) {
        const m = f.match(/page_(\d+)/);
        if (m) {
          images.push({
            pageIndex: parseInt(m[1]),
            url: `/api/paper/${req.params.sessionId}/thumb/${m[1]}`,
            originalUrl: `/api/paper/${req.params.sessionId}/images/${m[1]}`,
          redMarksUrl: `/api/paper/${req.params.sessionId}/red/${m[1]}`,
          annotatedUrl: `/api/paper/${req.params.sessionId}/annotated/${m[1]}`
          });
        }
      }
    }
  }

  res.json({
    success: true,
    session: {
      id: session.id, subject: session.subject, title: session.title,
      imageCount: session.imageCount, totalQuestions: session.totalQuestions,
      errorCount: session.errorCount, createdAt: session.createdAt
    },
    images,
    errors: errors.records || [],
    reviews,
    total: errors.total
  });
});

// 提交复核结果（批量）
app.post('/paper/:sessionId/review', authMiddleware, (req, res) => {
  const session = getPaperSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: '试卷不存在' });
  if (session.userId !== req.user.id) return res.status(403).json({ error: '无权访问' });

  const { reviews = [], additions = [] } = req.body;
  const results = { confirmed: 0, rejected: 0, corrected: 0, added: 0 };

  for (const r of reviews) {
    if (!r.errorId) continue;
    saveReview({
      errorId: r.errorId,
      sessionId: req.params.sessionId,
      userId: req.user.id,
      reviewAction: r.action,
      correctionData: r.correction || {},
      positionData: r.position || '',
      userNote: r.note || ''
    });

    if (r.action === 'confirmed') {
      updateErrorReviewStatus(r.errorId, 'confirmed');
      results.confirmed++;
    } else if (r.action === 'rejected') {
      deleteErrorProblem(r.errorId);
      results.rejected++;
    } else if (r.action === 'corrected') {
      updateErrorReviewStatus(r.errorId, 'corrected', r.correction);
      results.corrected++;
    }
  }

  // 处理用户添加的遗漏错题
  for (const add of additions) {
    const errorId = crypto.randomUUID().slice(0, 8);
    saveErrorProblem({
      id: errorId,
      userId: req.user.id,
      subject: session.subject,
      topic: add.questionNumber ? `第${add.questionNumber}题` : '用户添加',
      questionText: add.questionText || '',
      questionType: add.questionType || '未知',
      answerOptions: JSON.stringify(add.options || {}),
      wrongAnswer: add.studentAnswer || '',
      correctAnswer: add.correctAnswer || '',
      errorType: add.errorType || '未知',
      correctSolution: add.solution || '',
      difficulty: add.difficulty || 3,
      knowledgeExplanation: '{}',
      gradingEvidence: add.markType || '用户标注',
      aiRaw: '{}',
      notes: add.note || '用户手动添加',
      sessionId: req.params.sessionId,
      paperIndex: add.pageIndex || 1,
      status: 'done',
      reviewStatus: 'user_added',
      positionData: JSON.stringify(add.position || {}),
      createdAt: Date.now()
    });
    saveReview({
      errorId,
      sessionId: req.params.sessionId,
      userId: req.user.id,
      reviewAction: 'added',
      correctionData: add,
      positionData: JSON.stringify(add.position || {}),
      userNote: add.note || ''
    });
    results.added++;
  }

  // 更新 session 的错题数
  const updatedErrors = listErrorProblems({ userId: req.user.id, sessionId: req.params.sessionId, limit: 200 });
  updatePaperSession(req.params.sessionId, { errorCount: updatedErrors.total });

  log('info', '复核提交完成', { sessionId: req.params.sessionId, userId: req.user.id, results });
  res.json({ success: true, results });
});

// 用户手动添加一道遗漏错题
app.post('/paper/:sessionId/review/add', authMiddleware, (req, res) => {
  const session = getPaperSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: '试卷不存在' });
  if (session.userId !== req.user.id) return res.status(403).json({ error: '无权访问' });

  const { pageIndex, position, questionNumber, markType, note, questionText } = req.body;

  const errorId = crypto.randomUUID().slice(0, 8);
  saveErrorProblem({
    id: errorId,
    userId: req.user.id,
    subject: session.subject,
    topic: questionNumber ? `第${questionNumber}题` : '用户添加',
    questionText: questionText || '',
    questionType: '未知',
    answerOptions: '{}',
    wrongAnswer: '',
    correctAnswer: '',
    errorType: '未知',
    correctSolution: '',
    difficulty: 3,
    knowledgeExplanation: '{}',
    gradingEvidence: markType || '用户标注',
    aiRaw: '{}',
    notes: note || '用户手动添加',
    sessionId: req.params.sessionId,
    paperIndex: pageIndex || 1,
    status: 'done',
    reviewStatus: 'user_added',
    positionData: JSON.stringify(position || {}),
    createdAt: Date.now()
  });

  saveReview({
    errorId,
    sessionId: req.params.sessionId,
    userId: req.user.id,
    reviewAction: 'added',
    correctionData: req.body,
    positionData: JSON.stringify(position || {}),
    userNote: note || ''
  });

  const updatedErrors = listErrorProblems({ userId: req.user.id, sessionId: req.params.sessionId, limit: 200 });
  updatePaperSession(req.params.sessionId, { errorCount: updatedErrors.total });

  res.json({ success: true, errorId });
});

// 删除误判错题
app.delete('/paper/:sessionId/review/:errorId', authMiddleware, (req, res) => {
  const session = getPaperSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: '试卷不存在' });
  if (session.userId !== req.user.id) return res.status(403).json({ error: '无权访问' });

  const existing = getErrorProblem(req.params.errorId);
  if (!existing) return res.status(404).json({ error: '错题不存在' });

  saveReview({
    errorId: req.params.errorId,
    sessionId: req.params.sessionId,
    userId: req.user.id,
    reviewAction: 'rejected',
    userNote: '用户标记为误判'
  });

  deleteErrorProblem(req.params.errorId);

  const updatedErrors = listErrorProblems({ userId: req.user.id, sessionId: req.params.sessionId, limit: 200 });
  updatePaperSession(req.params.sessionId, { errorCount: updatedErrors.total });

  res.json({ success: true });
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
      'POST /paper/guidance', 'GET /paper/guidance/:taskId',
      'GET /paper/:sessionId/review', 'POST /paper/:sessionId/review', 'POST /paper/:sessionId/review/add',
      'DELETE /paper/:sessionId/review/:errorId',
      'GET /paper/:sessionId/images/:pageIndex', 'GET /paper/:sessionId/thumb/:pageIndex']
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

  // 清理启动前遗留的 processing/pending 状态（server 重启导致内存队列丢失）
  const stalledCount = resetStalledPaperSessions();
  if (stalledCount > 0) {
    log('info', '清理遗留任务', { count: stalledCount });
  }

  // 数据库统计

  app.listen(PORT, () => {
    console.log(`🚀 gaozhong.online AI API v2 (异步队列) 已启动`);
    console.log(`📍 端口: ${PORT}`);
    console.log(`🔍 健康检查: http://localhost:${PORT}/health`);
    console.log(`📝 作文: POST /analyze | 📄 整卷: POST /paper/analyze | 🧠 指导: POST /paper/guidance`);
    console.log(`💾 结果: GET /result/:taskId | 历史: GET /history | 错题: GET /error/list?view=paper|time|subject`);
    console.log(`⚡ 作文/错题并发: ${MAX_CONCURRENT} | 整卷分析并发: ${PAPER_MAX_CONCURRENT} | 队列上限: ${MAX_QUEUE_DEPTH}`);
    console.log(`🤖 OCR: ${MODEL_OCR} | 分析: ${MODEL_GRADING} | Prompt: ${PROMPT_VERSION} | Scanner: ${SCANNER_VERSION}`);
  });
};

startup();
