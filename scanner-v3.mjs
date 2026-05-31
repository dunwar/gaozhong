/**
 * gaozhong.online — Scanner v4.0
 * 
 * v4.0 变更: OCR 流程重构
 *   - 砍掉多轮 VL OCR（格式不稳定 + 超时），全量逐页并行
 *   - VL_CONCURRENCY 4→6，每页 API timeout 300s→180s（Python侧）
 *   - 逐页自动重试（3次指数退避）+ 正则兜底
 *   - 后处理：跨页阅读文章合并 + 题号去重校验
 * 
 * Architecture:
 *   Primary:   VL OCR (Kimi k2.6) per-page parallel → question structure
 *   Red:       Preprocess v8.0 /red-regions → red centroid map
 *   Classify:  VL (Kimi k2.6) → classify red mark types (✗/✓/letter/etc.)
 *   Fallback:  Tencent Cloud OCR → text blocks + rule engine
 *   All pages scanned in PARALLEL (per-page only, no multi-round)
 */

import { readFileSync } from 'fs';
import { execFile, spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SCANNER_VERSION = 'v4.0';
const PREPROCESS_URL = process.env.PREPROCESS_URL || 'http://localhost:5002';
const VL_CONCURRENCY = 6;
const PREPROCESS_CONCURRENCY = 4;
const VL_RETRIES = 3;          // per-page retries before giving up
const VL_RETRY_BACKOFF_MS = 2000;  // base backoff between retries

// 智谱 VL 配置
const ZHIPU_KEY = process.env.ZHIPU_API_KEY || '';
const ZHIPU_BASE_URL = process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/coding/paas/v4';
const MODEL_ZHIPU_VL = process.env.MODEL_ZHIPU_VL || 'glm-4.6v-flash';
const USE_ZHIPU_VL = !!ZHIPU_KEY;  // 有 key 就启用智谱通道

// ═══════════════════════════════════════
// Concurrency limiter
// ═══════════════════════════════════════

class ConcurrencyGate {
  constructor(limit) {
    this.limit = limit;
    this.running = 0;
    this.queue = [];
  }
  
  async run(fn) {
    while (this.running >= this.limit) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

function imgToBase64(filePath) {
  const buf = readFileSync(filePath);
  return `data:image/${filePath.endsWith('.png') ? 'png' : 'jpeg'};base64,${buf.toString('base64')}`;
}

function runPython(script, args = []) {
  const scriptPath = join(__dirname, 'scripts', script);
  return new Promise((resolve, reject) => {
    execFile('python3', [scriptPath, ...args], {
      encoding: 'utf-8', timeout: 900_000, maxBuffer: 20 * 1024 * 1024
    }, (error, stdout) => {
      const output = (stdout || '').trim();
      // Try parsing stdout as JSON even on non-zero exit (python script returns error JSON)
      if (output) {
        try {
          const parsed = JSON.parse(output);
          // If it's a valid status response, use it regardless of exit code
          if (parsed.status) return resolve(parsed);
        } catch (_) { /* fall through to error handling */ }
      }
      if (error) {
        if (error.killed) return reject(new Error(`Python ${script} timed out (5min)`));
        const detail = output ? `: ${output.slice(0, 200)}` : '';
        return reject(new Error(`Python ${script} failed${detail}`));
      }
      if (!output) return reject(new Error(`Python ${script} returned empty output`));
    });
  });
}

async function httpGetJson(hostname, port, path, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path, method: 'GET', timeout }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function httpPostJson(hostname, port, path, body, timeout = 300_000) {
  const postData = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname, port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(postData); req.end();
  });
}

// ═══════════════════════════════════════
// OCR Engines
// ═══════════════════════════════════════

/**
 * 调用智谱 VL 模型（图片+文字多模态）
 */
async function zhipuVLRequest({ messages, model, max_tokens = 4096, temperature = 0.05 }) {
  const useModel = model || MODEL_ZHIPU_VL;
  const body = JSON.stringify({ model: useModel, messages, max_tokens, temperature });
  const url = new URL(ZHIPU_BASE_URL + '/chat/completions');

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ZHIPU_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 180_000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.error) {
            reject(new Error(`Zhipu API error: ${result.error.message || JSON.stringify(result.error)}`));
            return;
          }
          resolve(result);
        } catch (e) {
          reject(new Error(`Zhipu parse error: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Zhipu VL timeout')); });
    req.write(body);
    req.end();
  });
}

async function detectPreflight() {
  const u = new URL(PREPROCESS_URL);
  const port = parseInt(u.port) || 5002;
  
  // Check health, retry up to 5 times with increasing wait
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const data = await httpGetJson(u.hostname, port, '/health', 8000);
      if (data.status === 'ok') return true;
    } catch (_) {}
    const waitMs = (attempt + 1) * 2000;
    console.log(`[scanner] Preprocess v8.0 not ready, retry ${attempt + 1}/5 in ${waitMs / 1000}s...`);
    await new Promise(r => setTimeout(r, waitMs));
  }
  throw new Error(`预处理服务 v8.0 不可用 (port ${port})，请稍后重试`);
}

async function extractQuestionsVL(pagePath, apiKey) {
  // v4.1: 尝试智谱 VL OCR（如果配置了 key），fallback 到 Python Kimi
  if (USE_ZHIPU_VL) {
    try {
      console.log('[scanner] Trying Zhipu VL OCR...');
      const imageB64 = imgToBase64(pagePath);
      const result = await zhipuVLRequest({
        messages: [
          { role: 'system', content: '你是一位高中老师。你仔细看试卷图片，逐题提取题目结构。最终只输出JSON，不加任何解释。' },
          { role: 'user', content: [
            { type: 'text', text: `请识别这张试卷页面上的所有题目，逐题提取信息。

【核心规则】
1. 看到题号（如 1. 21. 等）= 一道题
2. 一道题 = 题号 + 题干 + 选项（如有）
3. 听力题题干空白时 questionText 填 "(听力题)"
4. Section 标题、Directions、页眉页脚忽略
5. 阅读文章：第一道阅读题 passageText 抄全文，后续填 "[见上题]"

【输出JSON格式】
{"questions":[
  {"questionNumber":1,"questionType":"choice","questionText":"题干","options":{"A":"选项A","B":"选项B","C":"选项C","D":"选项D"},"passageText":"","bbox":{"x":50,"y":200,"w":540,"h":80}}
]}

只输出JSON，不要markdown代码块。` },
            { type: 'image_url', image_url: { url: imageB64, detail: 'high' } }
          ]}
        ],
        max_tokens: 16000,
        temperature: 0.05
      });
      
      const content = result.choices?.[0]?.message?.content || '';
      // Parse JSON
      const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/g, '');
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) parsed = JSON.parse(match[0]);
        else throw new Error('Failed to parse Zhipu VL response');
      }
      
      const questions = parsed.questions || [];
      if (questions.length === 0) throw new Error('Zhipu VL returned 0 questions');
      
      console.log(`[scanner] Zhipu VL OCR: ${questions.length} questions`);
      return { status: 'ok', totalQuestions: questions.length, questions, engine: 'zhipu-vl' };
    } catch (e) {
      console.log(`[scanner] Zhipu VL OCR failed (${e.message}), falling back to Kimi...`);
    }
  }
  
  // Fallback: Kimi k2.6 via Python
  const result = await runPython('ocr-page.py', [pagePath, '--api-key', apiKey]);
  if (result.status !== 'ok') throw new Error(`VL OCR failed: ${result.error}`);
  return result;
}

async function detectRedCentroids(imageBase64) {
  const u = new URL(PREPROCESS_URL);
  const data = await httpPostJson(u.hostname, parseInt(u.port) || 5002, '/red-regions', {
    image: imageBase64,
    options: { deskew: true, enhance: true }
  });
  if (data.status !== 'ok') throw new Error(`Red regions failed: ${data.error}`);
  return data.result;
}

async function detectPreprocess(imageBase64) {
  const u = new URL(PREPROCESS_URL);
  const data = await httpPostJson(u.hostname, parseInt(u.port) || 5002, '/preprocess', {
    image: imageBase64,
    options: { deskew: true }
  });
  if (data.status !== 'ok') throw new Error(`Preprocess failed: ${data.error}`);
  return data.result;
}

async function extractQuestionsTencent(pagePath, tencentSecret) {
  const result = await runPython('ocr-tencent.py', [
    pagePath,
    '--secret-id', tencentSecret.secretId,
    '--secret-key', tencentSecret.secretKey,
    '--region', tencentSecret.region || 'ap-guangzhou',
    '--high-precision'
  ]);
  if (result.status !== 'ok') throw new Error(`Tencent OCR failed: ${result.error}`);
  return result;
}

// ═══════════════════════════════════════
// v3.4: VL Red Mark Classification
// ═══════════════════════════════════════

/**
 * Send the red-highlighted image (white bg + red marks only) to VL
 * to classify each red mark's type.
 * 
 * v4.1: 支持 Zhipu VL（优先）和 Kimi VL（fallback）
 * 
 * @returns {{ classifiedMarks: [], errorQuestionNumbers: Set<number> }}
 */
async function classifyRedMarksVL(redHighlightedPath, questions, apiKey) {
  if (!redHighlightedPath) {
    console.log('[scanner] No red-highlighted image, skipping VL classification');
    return { classifiedMarks: [], errorQuestionNumbers: new Set() };
  }
  
  const imageB64 = imgToBase64(redHighlightedPath);
  
  const prompt = `请分析这张红笔标记提取图（白底上只保留红色标记）。

【你的任务】
找出图中所有的红色标记，逐一判断它们的类型。

【标记类型 — 精准定义】

1. "cross" — ✗ 打叉：两条交叉的斜线（X形状），不是字母X
2. "check" — ✓ 打勾：一条从左上到右下的短斜线 + 一个小弯钩
3. "correct_answer" — 红笔写的字母/单词/数字：英文大写字母(A/B/C/D)、英文单词、阿拉伯数字
4. "underline" — 下划线/波浪线：水平线，位于文字下方
5. "circle" — 红色圆圈/椭圆：围绕某内容的圈
6. "annotation" — 红笔手写汉字注释（如"主谓一致""过去式"）
7. "strikethrough" — 横线/斜线划掉文字
8. "score_deduction" — 红笔扣分标记（如 "-2", "-0.5"）

【判定规则 — 错题判据】
只有两种标记代表"做错"：
- ✗ cross — 教师明确标记做错 → 错题 ✅
- correct_answer（红笔字母/单词）— 教师标注正确答案，学生原选 ≠ 此字母 → 错题 ✅

其余所有标记（✓ check、underline、circle、annotation、strikethrough）均不代表做错，忽略。

【输出格式】纯JSON：
{
  "marks": [
    {"type": "cross", "content": "", "position": "题号22旁边"},
    {"type": "correct_answer", "content": "C", "position": "题号23旁边"},
    {"type": "check", "content": "", "position": "题号21旁边"}
  ]
}

直接输出JSON。`;

  const userContent = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: imageB64, detail: 'high' } }
  ];

  // Helper to parse VL response
  function parseClassifyResponse(content) {
    let marks = [];
    const cleaned = content.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/g, '');
    
    try {
      marks = JSON.parse(cleaned).marks || [];
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try { marks = JSON.parse(match[0]).marks || []; } catch {}
      }
    }
    
    const errorTypes = new Set(['cross', 'correct_answer']);
    return marks.map(m => ({
      ...m,
      isError: errorTypes.has(m.type)
    }));
  }

  // 尝试智谱 VL（优先）
  if (USE_ZHIPU_VL) {
    console.log('[scanner] Classifying red marks via Zhipu VL...');
    try {
      const result = await zhipuVLRequest({
        messages: [
          { role: 'system', content: '你精准识别红笔批改标记。只输出JSON。' },
          { role: 'user', content: userContent }
        ],
        model: MODEL_ZHIPU_VL,
        max_tokens: 4096,
        temperature: 0.05
      });
      
      const content = result.choices?.[0]?.message?.content || '';
      const classifiedMarks = parseClassifyResponse(content);
      const errorMarks = classifiedMarks.filter(m => m.isError).length;
      console.log(`[scanner] Zhipu VL classified ${classifiedMarks.length} marks: ${errorMarks} errors`);
      return { classifiedMarks, errorQuestionNumbers: new Set() };
    } catch (e) {
      console.log(`[scanner] Zhipu VL failed (${e.message}), falling back to Kimi...`);
    }
  }

  // Fallback: Kimi k2.6 (DashScope)
  console.log('[scanner] Classifying red marks via Kimi VL...');
  const body = JSON.stringify({
    model: 'kimi-k2.6',
    messages: [
      { role: 'system', content: '你精准识别红笔批改标记。只输出JSON。' },
      { role: 'user', content: userContent }
    ],
    temperature: 0.05,
    max_tokens: 4000
  });
  
  return new Promise((resolve, reject) => {
    const url = new URL('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    const req = http.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 120_000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          const content = result.choices?.[0]?.message?.content || '';
          const classifiedMarks = parseClassifyResponse(content);
          
          const totalMarks = classifiedMarks.length;
          const errorMarks = classifiedMarks.filter(m => m.isError).length;
          const nonErrorMarks = totalMarks - errorMarks;
          
          console.log(`[scanner] Kimi VL classified ${totalMarks} marks: ${errorMarks} errors, ${nonErrorMarks} non-errors`);
          
          resolve({ classifiedMarks, errorQuestionNumbers: new Set() });
        } catch (e) {
          console.log(`[scanner] VL mark classification failed: ${e.message}. Falling back to centroid-based judgment.`);
          resolve({ classifiedMarks: [], errorQuestionNumbers: new Set(), fallback: true });
        }
      });
    });
    
    req.on('error', (e) => {
      console.log(`[scanner] VL classification request failed: ${e.message}, using centroid fallback`);
      resolve({ classifiedMarks: [], errorQuestionNumbers: new Set(), fallback: true });
    });
    req.on('timeout', () => {
      req.destroy();
      console.log('[scanner] VL classification timed out, using centroid fallback');
      resolve({ classifiedMarks: [], errorQuestionNumbers: new Set(), fallback: true });
    });
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════
// v3.4: Updated centroid matching with VL classification
// ═══════════════════════════════════════

/**
 * Check if a point falls within an expanded bbox.
 * @param {{x:number,y:number}} centroid 
 * @param {{x:number,y:number,w:number,h:number}} bbox
 * @param {number} marginPct - expansion margin (0.1 = 10%)
 */
function centroidInBbox(centroid, bbox, marginPct = 0.1) {
  const mxW = bbox.w * marginPct;
  const mxH = bbox.h * marginPct;
  const x1 = bbox.x - mxW;
  const y1 = bbox.y - mxH;
  const x2 = bbox.x + bbox.w + mxW;
  const y2 = bbox.y + bbox.h + mxH;
  return centroid.x >= x1 && centroid.x <= x2 && centroid.y >= y1 && centroid.y <= y2;
}

/**
 * For each question, count centroids and apply VL classification results.
 * Per error-identification-logic v3.0:
 *   - isError = VL classified as "cross" OR "correct_answer" (letter/word)
 *   - ✓, underline, circle, annotation are NOT errors
 * Falls back to centroid-count threshold if VL classification unavailable.
 */
function matchCentroidsToQuestions(questions, regions, pageStats, vlClassifiedMarks = null) {
  const MIN_RED_ENERGY = Math.max(pageStats.median * 3, 100);
  const results = [];
  
  // Track which region indices have been assigned to prevent one red mark
  // from counting against two adjacent questions
  const assignedRegions = new Set();
  
  for (const q of questions) {
    if (!q.bbox || q.bbox.w == null) {
      results.push({ ...q, centroidCount: 0, redEnergy: 0, matchedRegions: [], isError: false, errorSource: null });
      continue;
    }
    
    const matched = [];
    let redEnergy = 0;
    
    for (let ri = 0; ri < (regions || []).length; ri++) {
      if (assignedRegions.has(ri)) continue; // Already belongs to another question
      const reg = regions[ri];
      if (!reg.centroid) continue;
      
      // Stricter match: centroid must be within bbox with NO margin expansion
      // This prevents boundary-adjacent marks from counting for both neighbor questions
      if (centroidInBbox(reg.centroid, q.bbox, 0)) {
        matched.push(reg);
        assignedRegions.add(ri);
        redEnergy += reg.area || 0;
      }
    }
    
    const centroidCount = matched.length;
    
    // v3.4: Use VL classification when available, fall back to centroid threshold
    let isError = false;
    let errorSource = null;
    let markTypes = [];
    
    if (vlClassifiedMarks && vlClassifiedMarks.length > 0) {
      // Look for VL-classified marks that match this question
      const qMarks = vlClassifiedMarks.filter(m => {
        // Match by position description heuristics OR by centroid proximity
        if (m.position) {
          const pos = m.position.toLowerCase();
          const qn = String(q.questionNumber);
          if (pos.includes(qn) || pos.includes(`题号${qn}`) || pos.includes(`第${qn}题`)) {
            return true;
          }
        }
        return false;
      });
      
      if (qMarks.length > 0) {
        markTypes = qMarks.map(m => m.type);
        isError = qMarks.some(m => m.isError);
        errorSource = isError ? 'vl_classified' : 'vl_classified_non_error';
      } else if (centroidCount > 0) {
        // Has red ink but VL didn't match to this question → use conservative centroid threshold
        isError = centroidCount >= 3 || redEnergy >= MIN_RED_ENERGY * 2;
        errorSource = isError ? 'centroid_fallback' : null;
      }
    } else {
      // No VL classification available → fall back to centroid threshold
      isError = centroidCount >= 2 || redEnergy >= MIN_RED_ENERGY;
      errorSource = isError ? 'red_centroids' : null;
    }
    
    results.push({
      questionNumber: q.questionNumber,
      questionType: q.questionType || 'choice',
      questionText: q.questionText || '',
      options: q.options || {},
      bbox: q.bbox,
      pageIndex: q.pageIndex,
      hasRed: centroidCount > 0,
      centroidCount,
      redEnergy,
      isError,
      errorSource,
      markTypes,
      matchedRegions: matched.map(r => ({ cx: r.centroid.x, cy: r.centroid.y, area: r.area }))
    });
  }
  
  return results;
}

// ═══════════════════════════════════════
// Single page scan
// ═══════════════════════════════════════

export async function scanPage(pagePath, { apiKey, outputDir, pageIndex = 1, markingMethod = 'red_pen', tencentSecret = null, subject = '自动' }) {
  const imageB64 = imgToBase64(pagePath);
  
  // v4.1: 尝试智谱 DirectJudge（端到端双图判错），如果成功则跳过质心匹配
  if (USE_ZHIPU_VL) {
    try {
      // 先并行获取预处理图（红笔突出图）
      const ppImageResult = await detectPreprocess(imageB64);
      const redHighlightedPath = ppImageResult.red_highlighted;
      
      if (redHighlightedPath) {
        console.log(`[scanner] Page ${pageIndex}: Trying Zhipu DirectJudge...`);
        const djResult = await directJudgeDualImage(pagePath, redHighlightedPath, subject);
        
        if (djResult.errors.length > 0 || true) {  // 即使 0 errors 也算成功
          // DirectJudge 成功，直接返回结果
          const errors = djResult.errors.map(e => ({ ...e, pageIndex }));
          console.log(`[scanner] Page ${pageIndex}: DirectJudge found ${errors.length} errors`);
          
          return {
            pageIndex,
            version: SCANNER_VERSION + '-direct-judge',
            engine: 'zhipu-vl-direct-judge',
            totalQuestions: errors.length,  // DirectJudge 只报告错题，总数未知
            totalErrors: errors.length,
            redSignal: 0,
            pageStats: {},
            totalRegions: 0,
            vlMarkCount: 0,
            classificationFallback: false,
            questions: errors,  // questions 和 errors 相同
            errors,
            correctedImage: ppImageResult.corrected,
            redHighlightedImage: redHighlightedPath,
            imageSize: null,
            directJudgeMode: true
          };
        }
      }
    } catch (djErr) {
      console.log(`[scanner] Page ${pageIndex}: DirectJudge failed (${djErr.message}), falling back to pipeline...`);
    }
  }
  
  // Fallback: 原有流水线（OCR + 质心 + VL 分类）
  const [ocrResult, redCentroidResult, ppImageResult] = await Promise.all([
    (async () => {
      try {
        return { ok: true, data: await extractQuestionsVL(pagePath, apiKey), engine: 'vl' };
      } catch (vlErr) {
        console.log(`[scanner] Page ${pageIndex}: VL OCR failed (${vlErr.message}), trying Tencent...`);
        if (tencentSecret) {
          try {
            return { ok: true, data: await extractQuestionsTencent(pagePath, tencentSecret), engine: 'tencent' };
          } catch (tcErr) {
            throw new Error(`Both VL and Tencent OCR failed for page ${pageIndex}: ${tcErr.message}`);
          }
        }
        throw vlErr;
      }
    })(),
    detectRedCentroids(imageB64),
    detectPreprocess(imageB64)
  ]);
  
  if (!ocrResult.ok) throw new Error(`OCR failed for page ${pageIndex}`);
  
  const vlQuestions = ocrResult.data.questions || [];
  const regions = redCentroidResult.regions || [];
  const pageStats = redCentroidResult.page_stats || { median: 0, mean: 0, p75: 0 };
  const redHighlightedPath = ppImageResult.red_highlighted;
  
  console.log(`[scanner] Page ${pageIndex}: ${vlQuestions.length} questions, ${regions.length} red regions (median area=${pageStats.median})`);
  
  // v3.4: VL classify red marks on this page
  let vlMarks = [];
  let classificationFallback = false;
  if (redHighlightedPath && regions.length > 0) {
    try {
      const classifyResult = await classifyRedMarksVL(redHighlightedPath, vlQuestions, apiKey);
      vlMarks = classifyResult.classifiedMarks || [];
      classificationFallback = classifyResult.fallback || false;
    } catch (e) {
      console.log(`[scanner] Page ${pageIndex}: VL classification error (${e.message}), using centroid fallback`);
    }
  }
  
  // Match centroids to questions, now with VL classification
  const questions = matchCentroidsToQuestions(
    vlQuestions.map(q => ({ ...q, pageIndex })), 
    regions, 
    pageStats,
    vlMarks
  );
  
  const errors = questions.filter(q => q.isError);
  
  return {
    pageIndex,
    version: SCANNER_VERSION,
    engine: 'vl-ocr + preprocess-v8.0-centroids + vl-mark-classify',
    totalQuestions: questions.length,
    totalErrors: errors.length,
    redSignal: redCentroidResult.red_signal,
    pageStats,
    totalRegions: regions.length,
    vlMarkCount: vlMarks.length,
    classificationFallback,
    questions,
    errors,
    correctedImage: ppImageResult.corrected,
    redHighlightedImage: redHighlightedPath,
    imageSize: ocrResult.data.imageSize || null
  };
}

// ═══════════════════════════════════════
// MULTI-PAGE PARALLEL SCAN (v3.3)
// ═══════════════════════════════════════

export async function scanPages(pagePaths, { apiKey, outputDir, markingMethod = 'red_pen', tencentSecret = null, subject = '自动' }) {
  const totalStart = Date.now();
  console.log(`[scanner v4.0] Scanning ${pagePaths.length} pages (VL=${VL_CONCURRENCY}, PP=${PREPROCESS_CONCURRENCY})`);
  
  // Preflight: check preprocess v8.0 is alive, restart if dead
  try { await detectPreflight(); } catch (e) {
    throw new Error(`预处理服务不可用 (port 5002): ${e.message}`);
  }
  
  // Preprocess + red centroids (local, fast)
  const ppGate = new ConcurrencyGate(PREPROCESS_CONCURRENCY);
  const preprocessJobs = pagePaths.map((pp, i) => 
    ppGate.run(async () => {
      const b64 = imgToBase64(pp);
      const [centroids, images] = await Promise.all([
        detectRedCentroids(b64),
        detectPreprocess(b64)
      ]);
      return { index: i, centroids, images };
    })
  );
  
  // Phase 2: VL OCR — per-page parallel with retry
  const ocrGate = new ConcurrencyGate(VL_CONCURRENCY);
  
  const ocrResults = await Promise.all(
    pagePaths.map((pp, i) =>
      ocrGate.run(async () => {
        const pageLabel = `Page ${i + 1}`;
        for (let attempt = 0; attempt < VL_RETRIES; attempt++) {
          try {
            const result = await extractQuestionsVL(pp, apiKey);
            if (attempt > 0) console.log(`[scanner] ${pageLabel}: VL ok on retry ${attempt}`);
            return { index: i, result, engine: 'vl', attempts: attempt + 1 };
          } catch (vlErr) {
            const retryLeft = VL_RETRIES - attempt - 1;
            if (retryLeft > 0) {
              const wait = VL_RETRY_BACKOFF_MS * Math.pow(2, attempt);
              console.log(`[scanner] ${pageLabel}: VL attempt ${attempt + 1}/${VL_RETRIES} failed (${vlErr.message}), retry in ${wait}ms`);
              await new Promise(r => setTimeout(r, wait));
            } else {
              console.log(`[scanner] ${pageLabel}: VL all ${VL_RETRIES} retries exhausted, trying Tencent...`);
              if (tencentSecret) {
                try {
                  const result = await extractQuestionsTencent(pp, tencentSecret);
                  return { index: i, result, engine: 'tencent', attempts: VL_RETRIES + 1 };
                } catch (tcErr) {
                  console.log(`[scanner] ${pageLabel}: Tencent also failed (${tcErr.message}), skipped`);
                  return { index: i, result: { questions: [], imageSize: null }, engine: 'failed', skipped: true, attempts: VL_RETRIES + 1 };
                }
              }
              console.log(`[scanner] ${pageLabel}: skipped (no fallback, 0 questions)`);
              return { index: i, result: { questions: [], imageSize: null }, engine: 'failed', skipped: true, attempts: VL_RETRIES };
            }
          }
        }
        return { index: i, result: { questions: [], imageSize: null }, engine: 'failed', skipped: true, attempts: VL_RETRIES };
      })
    )
  );
  
  const ppResults = await Promise.all(preprocessJobs);
  
  const ppTime = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`[scanner] All prep done in ${ppTime}s`);
  
  // Phase 3: VL classify red marks + centroid matching per page
  const VL_CLASSIFY_CONCURRENCY = 2; // Limit concurrent VL classify calls
  const classifyGate = new ConcurrencyGate(VL_CLASSIFY_CONCURRENCY);
  
  const pageResults = [];
  for (let i = 0; i < pagePaths.length; i++) {
    const pp = ppResults.find(r => r.index === i);
    const ocr = ocrResults.find(r => r.index === i);
    
    const vlQuestions = ocr.result.questions || [];
    const regions = pp.centroids.regions || [];
    const pageStats = pp.centroids.page_stats || { median: 0 };
    const redHighlightedPath = pp.images.red_highlighted;
    
    // v3.4: VL classify red marks for this page
    let vlMarks = [];
    let classificationFallback = false;
    if (redHighlightedPath && regions.length > 0) {
      try {
        const classifyResult = await classifyGate.run(() => 
          classifyRedMarksVL(redHighlightedPath, vlQuestions, apiKey)
        );
        vlMarks = classifyResult.classifiedMarks || [];
        classificationFallback = classifyResult.fallback || false;
      } catch (e) {
        console.log(`[scanner] Page ${i + 1}: VL classification error (${e.message}), using centroid fallback`);
        classificationFallback = true;
      }
    }
    
    const questions = matchCentroidsToQuestions(
      vlQuestions.map(q => ({ ...q, pageIndex: i + 1 })),
      regions,
      pageStats,
      vlMarks
    );
    
    pageResults.push({
      pageIndex: i + 1,
      engine: ocr.engine,
      totalQuestions: questions.length,
      totalErrors: questions.filter(q => q.isError).length,
      redSignal: pp.centroids.red_signal,
      pageStats,
      totalRegions: regions.length,
      vlMarkCount: vlMarks.length,
      classificationFallback,
      questions,
      errors: questions.filter(q => q.isError),
      correctedImage: pp.images.corrected,
      redHighlightedImage: redHighlightedPath
    });
  }
  
  // Post-OCR: cross-page passage merge
  const skipCount = pageResults.filter(p => p.engine === 'failed').length;
  const qCountRaw = pageResults.reduce((s, p) => s + p.questions.length, 0);
  mergeCrossPagePassages(pageResults);
  validateQuestionNumbers(pageResults);
  const qCountFinal = pageResults.reduce((s, p) => s + p.questions.length, 0);
  
  const totalTime = ((Date.now() - totalStart) / 1000).toFixed(1);
  const allQuestions = pageResults.flatMap(p => p.questions);
  const allErrors = pageResults.flatMap(p => p.errors);
  
  console.log(`[scanner v4.0] Done: ${pageResults.length} pages, ${qCountFinal} questions, ${allErrors.length} errors in ${totalTime}s` +
    (skipCount ? ` (${skipCount} pages skipped)` : ''));
  
  return {
    version: SCANNER_VERSION,
    engine: 'vl-ocr-v4-per-page-parallel + preprocess-v8.0 + vl-mark-classify',
    pages: pageResults.length,
    totalQuestions: qCountFinal,
    totalErrors: allErrors.length,
    totalTime,
    skipCount,
    markingMethod,
    questions: allQuestions,
    errors: allErrors,
    pageResults
  };
}

// ═══════════════════════════════════════
// v4.1: Zhipu DirectJudge — 端到端双图判错
// ═══════════════════════════════════════

/**
 * 端到端双图判错：原图+红笔图一起发给 VL，一次完成 OCR+判错。
 * 跳过质心匹配环节，减少中间信息丢失。
 * 
 * @param {string} originalPath - 原图文件路径
 * @param {string} redHighlightedPath - 红笔突出图路径
 * @param {string} subject - 科目
 * @returns {Promise<{questions:[], errors:[]}>}
 */
async function directJudgeDualImage(originalPath, redHighlightedPath, subject) {
  const origB64 = imgToBase64(originalPath);
  const redB64 = redHighlightedPath ? imgToBase64(redHighlightedPath) : null;
  
  const subjectHint = subject && subject !== '自动' ? `\n当前学科：${subject}` : '';
  
  const prompt = `你是试卷错题识别专家。你会收到两张图片。

📷 图1（原图）：读取题目文字、选项、学生蓝黑笔作答
🔴 图2（红笔提取图）：白底只保留红色批改标记，非红内容已淡化

═══ 铁律 ═══
- 蓝/黑笔迹 = 学生答案（图1查看）
- 红色笔迹 = 教师批改（图2查看）
- 红色印刷（标题、边框）≠ 批改，忽略
- 只有红笔明确标记"错误"才算错题

═══ 红笔标记判定表 ═══
✗打叉 → 错题（studentAnswer=学生原选，correctAnswer=从题目推断）
红笔划掉+写新答案 → 错题（studentAnswer=被划，correctAnswer=红笔写的）
红笔标注答案且≠学生原选 → 错题
红笔圈出选项 → 被圈=正确答案，学生选别的=错题
✓打勾 → 对题，跳过
红笔注释/下划线/波浪线 → 标记重点，不是错题
无红笔标记 → 对题，跳过

═══ 质量自检 ═══
一页试卷通常 3-10 道错题。如果超过 15 道，重新检查。
不确定的题 → 跳过，宁可漏判不要误判。

═══ 输出格式 — 纯JSON ═══
{
  "errors": [
    {
      "questionNumber": 21,
      "questionText": "完整题干",
      "questionType": "choice",
      "options": {"A":"选项A","B":"选项B","C":"选项C","D":"选项D"},
      "studentAnswer": "B",
      "correctAnswer": "D",
      "markType": "cross",
      "confidence": "high"
    }
  ]
}

没有错题输出 {"errors":[]}
直接输出JSON，不要markdown代码块。${subjectHint}`;

  const images = [
    { type: 'image_url', image_url: { url: origB64, detail: 'high' } }
  ];
  if (redB64) {
    images.push({ type: 'image_url', image_url: { url: redB64, detail: 'high' } });
  }

  const result = await zhipuVLRequest({
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: prompt }, ...images]
    }],
    max_tokens: 16000,
    temperature: 0.05
  });

  const content = result.choices?.[0]?.message?.content || '';
  
  // Parse JSON
  const cleaned = content.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/g, '');
  
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error('DirectJudge: 无法解析 JSON');
  }
  
  const errors = (parsed.errors || []).map(e => ({
    questionNumber: e.questionNumber,
    questionText: e.questionText || '',
    questionType: e.questionType || 'choice',
    options: e.options || {},
    studentAnswer: (e.studentAnswer || '').trim().toUpperCase(),
    correctAnswer: (e.correctAnswer || '').trim().toUpperCase(),
    markType: e.markType || '',
    confidence: e.confidence || 'medium',
    isError: true,
    pageIndex: 0,  // caller will set
    errorSource: 'zhipu_direct_judge'
  }));
  
  console.log(`[scanner] DirectJudge: ${errors.length} errors detected`);
  return { errors, raw: parsed };
}

// ═══════════════════════════════════════
// Post-OCR: cross-page passage merge + validation
// ═══════════════════════════════════════

/**
 * Merge reading passages that span consecutive pages.
 * When page N's last reading question has passageText and page N+1's first
 * reading question has "[见前半部分]" / "[见上题]" — link them.
 */
function mergeCrossPagePassages(pageResults) {
  if (pageResults.length < 2) return;
  
  for (let i = 0; i < pageResults.length - 1; i++) {
    const thisPage = pageResults[i];
    const nextPage = pageResults[i + 1];
    if (thisPage.engine === 'failed' || nextPage.engine === 'failed') continue;
    
    // Find the last reading/cloze question on this page with actual passageText
    const thisQs = thisPage.questions;
    const nextQs = nextPage.questions;
    
    if (!thisQs.length || !nextQs.length) continue;
    
    // Look for reading passages that span pages:
    // 1. This page's last reading question has passageText (not "[见上题]")
    // 2. Next page's first reading question references it
    for (let t = thisQs.length - 1; t >= 0; t--) {
      const qThis = thisQs[t];
      const isReading = ['reading', 'cloze'].includes(qThis.questionType);
      if (!isReading) continue;
      
      const passage = qThis.passageText || '';
      if (!passage || passage === '[见上题]' || passage === '[见前半部分]') continue;
      
      // Check next page for a reading/cloze question that references this
      for (let n = 0; n < Math.min(3, nextQs.length); n++) {
        const qNext = nextQs[n];
        const nextPassage = qNext.passageText || '';
        if (nextPassage === '[见上题]' || nextPassage === '[见前半部分]') {
          console.log(`[scanner] Merge: Q${qThis.questionNumber} passage → Q${qNext.questionNumber} on next page`);
          qNext.passageText = passage;
          break;
        }
      }
      break;
    }
  }
}

/**
 * Validate question numbering: detect duplicates, gaps, and out-of-order sequences.
 * Logs warnings but does not modify data.
 */
function validateQuestionNumbers(pageResults) {
  const allNumbers = [];
  const seen = new Map(); // number → [{page, idx}]
  
  for (const page of pageResults) {
    if (page.engine === 'failed') continue;
    for (let qi = 0; qi < page.questions.length; qi++) {
      const qn = page.questions[qi].questionNumber;
      allNumbers.push(qn);
      if (!seen.has(qn)) seen.set(qn, []);
      seen.get(qn).push({ page: page.pageIndex, idx: qi });
    }
  }
  
  // Check for duplicates
  for (const [qn, locations] of seen) {
    if (locations.length > 1) {
      const pages = locations.map(l => `P${l.page}`).join(', ');
      console.log(`[scanner] ⚠️ Duplicate question ${qn} found on ${pages} — keeping first occurrence`);
      // Remove duplicates (keep first occurrence)
      const first = locations[0];
      for (let i = 1; i < locations.length; i++) {
        const p = pageResults.find(pr => pr.pageIndex === locations[i].page);
        if (p) p.questions[locations[i].idx] = null; // mark for removal
      }
    }
  }
  
  // Clean up nulled duplicates
  for (const page of pageResults) {
    page.questions = page.questions.filter(q => q !== null);
    page.totalQuestions = page.questions.length;
    page.errors = page.errors.filter(q => q !== null);
    page.totalErrors = page.errors.length;
  }
  
  // Check for gaps
  const sorted = [...new Set(allNumbers)].sort((a, b) => a - b);
  if (sorted.length > 1) {
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] > 1) {
        gaps.push(`${sorted[i - 1]}→${sorted[i]}`);
      }
    }
    if (gaps.length) {
      console.log(`[scanner] ℹ️ Question number gaps detected: ${gaps.join(', ')} (may be normal — different sections)`);
    }
  }
  
  if (!allNumbers.length) {
    console.log('[scanner] ⚠️ 0 questions extracted from all pages!');
  }
}

export default { SCANNER_VERSION, scanPage, scanPages };
