#!/usr/bin/env node
/**
 * gaozhong.online - AI 作文批改 API 服务 (v2 - 异步队列版)
 *
 * 架构：提交即返回 taskId → 后台队列处理 → 客户端轮询结果
 * 并发控制：最多 3 个同时批改，队列深度上限 200
 * 模型分工：OCR(qwen-vl-plus) → 批改(deepseek-v4-pro)
 * Prompt：prompts/grading-v5.js
 *
 * 环境变量：
 *   DASHSCOPE_API_KEY - 百炼 API Key（OCR 用）
 *   DEEPSEEK_API_KEY  - DeepSeek API Key（批改用）
 */

import express from 'express';
import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { GRADING_PROMPT, PROMPT_VERSION } from './prompts/grading-v5.js';
import { ERROR_DIAGNOSIS_PROMPT } from './prompts/error-diagnosis.js';
import { initDB, saveDB, saveRecord, getRecord, getHistory, getStats, createUser, getUserByEmail, getUserById, updateUser, changePassword, listUsers, saveErrorProblem, saveErrorKnowledgeTags, getErrorProblem, listErrorProblems, getErrorStats, getKnowledgeStats, searchKnowledgePoints } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const MAX_CONCURRENT = 3;
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

const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL_OCR = process.env.MODEL_OCR || 'qwen-vl-plus';
const MODEL_GRADING = process.env.MODEL_GRADING || 'deepseek-v4-pro';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRES_IN = '7d';
const BCRYPT_ROUNDS = 10;

if (!DEEPSEEK_KEY) {
  console.error('❌ 错误: DEEPSEEK_API_KEY 未设置');
  process.exit(1);
}

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

// 错题诊断队列（独立于作文批改）
const errorQueue = new ConcurrencyQueue(MAX_CONCURRENT);
const ERROR_TASK_TTL_MS = 60 * 60 * 1000;
const errorTasks = new Map();

// ========== 定期清理过期 task ==========
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, task] of tasks) {
    if (now - task.createdAt > TASK_TTL_MS) {
      tasks.delete(id);
      cleaned++;
    }
  }
  if (cleaned > 0) log('info', 'task 清理', { cleaned, remaining: tasks.size });
}, CLEANUP_INTERVAL_MS);

// ========== 限流器（简单令牌桶） ==========
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

// ============ 以下：原有业务逻辑（保持完整） ============

// Prompt 渲染
function renderPrompt(template, topic = '', text = '') {
  return template
    .replace(/\{作文题目材料\}/g, topic || '(无)')
    .replace(/\{作文内容\}/g, text);
}

// 通用 API 请求
function apiRequest({ hostname, path, apiKey, body, timeout = 120_000 }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      agent: httpsAgent,
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

function dashscopeRequest(body) {
  return apiRequest({
    hostname: 'dashscope.aliyuncs.com',
    path: '/compatible-mode/v1/chat/completions',
    apiKey: DASHSCOPE_KEY,
    body
  });
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
    temperature: 0.5,
    max_tokens: 6000
  });
  return parseResult(result);
}

async function gradeImage(imageUrl, topic) {
  log('info', 'OCR 识别', { provider: 'DashScope', model: MODEL_OCR });
  const ocrResult = await dashscopeRequest({
    model: MODEL_OCR,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '请仔细识别图片中的作文文字，尽量完整还原原文。只返回识别出的文字内容，不要其他分析。' },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    }],
    temperature: 0.3,
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
    providers: { ocr: { name: 'DashScope', model: MODEL_OCR }, grading: { name: 'DeepSeek', model: MODEL_GRADING } },
    prompt: { version: PROMPT_VERSION, file: 'prompts/grading-v5.js' },
    queue: { active: gradingQueue.active, pending: gradingQueue.pending, maxConcurrent: MAX_CONCURRENT },
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

  // 限流检查
  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试', retryAfter: rl.retryAfter });
  }

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
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const rl = checkRateLimit(ip);
  if (!rl.allowed) return res.status(429).json({ error: '请求过于频繁', retryAfter: rl.retryAfter });
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
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const subject = req.query.subject || null;
  const result = listErrorProblems({ userId: req.user.id, subject, page, limit });
  res.json({ success: true, ...result });
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

// 404
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    endpoints: ['GET /health', 'POST /analyze', 'GET /task/:taskId', 'POST /auth/login', 'POST /auth/register', 'GET /auth/me', 'PUT /auth/password', 'GET /history', 'GET /stats', 'GET /admin/users', 'POST /error/diagnose', 'GET /error/task/:taskId', 'GET /error/list', 'GET /error/:id', 'GET /error/stats', 'GET /knowledge/search', 'GET /knowledge/stats']
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
    console.log(`📝 提交: POST /analyze → taskId → GET /task/:taskId`);
    console.log(`💾 结果: GET /result/:taskId | 历史: GET /history`);
    console.log(`⚡ 并发: ${MAX_CONCURRENT} | 队列上限: ${MAX_QUEUE_DEPTH} | TTL: ${TASK_TTL_MS / 60000}min`);
    console.log(`🤖 OCR: ${MODEL_OCR} | 批改: ${MODEL_GRADING} | Prompt: ${PROMPT_VERSION}`);
    console.log(`🔬 错题诊断: POST /error/diagnose | 列表: GET /error/list | 知识点: GET /knowledge/search`);
  });
};

startup();
