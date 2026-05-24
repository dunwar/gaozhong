/**
 * gaozhong.online — Scanner v3.4
 * 
 * v3.4 变更: VL 红笔标记分类，替代纯定量判错
 *   - 新增 classifyRedMarks(): VL 识别 ✗ / ✓ / 字母 / 下划线 / 圈 / 注释
 *   - 判定规则 (error-identification-logic v3.0): 仅 ✗ 和红笔字母 = 错题
 *   - 质心检测 → "有红笔" → VL 分类 → "什么类型" → 精准判错
 * 
 * Architecture:
 *   Primary:   VL OCR (Kimi k2.6) → question structure
 *   Red:       Preprocess v8.0 /red-regions → red centroid map
 *   Classify:  VL (Kimi k2.6) → classify red mark types (✗/✓/letter/etc.)
 *   Fallback:  Tencent Cloud OCR → text blocks + rule engine
 *   All pages scanned in PARALLEL
 */

import { readFileSync } from 'fs';
import { execFile, spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SCANNER_VERSION = 'v3.4';
const PREPROCESS_URL = process.env.PREPROCESS_URL || 'http://localhost:5002';
const VL_CONCURRENCY = 4;
const PREPROCESS_CONCURRENCY = 4;

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
      encoding: 'utf-8', timeout: 300_000, maxBuffer: 10 * 1024 * 1024
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
 * and ask Kimi to classify each red mark's type.
 * 
 * Only marks classified as "cross" or "correct_answer" (letter/word)
 * are counted as errors per error-identification-logic v3.0.
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

  const body = JSON.stringify({
    model: 'kimi-k2.6',
    messages: [
      { role: 'system', content: '你精准识别红笔批改标记。只输出JSON。' },
      { role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageB64, detail: 'high' } }
      ]}
    ],
    temperature: 0.05,
    max_tokens: 4000
  });
  
  console.log('[scanner] Classifying red marks via VL...');
  
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
          
          // Extract JSON from response
          let marks = [];
          const cleaned = content.trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/g, '');
          
          try {
            marks = JSON.parse(cleaned).marks || [];
          } catch {
            // Try regex extraction
            const match = cleaned.match(/\{[\s\S]*\}/);
            if (match) {
              try { marks = JSON.parse(match[0]).marks || []; } catch {}
            }
          }
          
          const errorTypes = new Set(['cross', 'correct_answer']);
          const classifiedMarks = marks.map(m => ({
            ...m,
            isError: errorTypes.has(m.type)
          }));
          
          const totalMarks = classifiedMarks.length;
          const errorMarks = classifiedMarks.filter(m => m.isError).length;
          const nonErrorMarks = totalMarks - errorMarks;
          
          console.log(`[scanner] VL classified ${totalMarks} marks: ${errorMarks} errors (✗/letters), ${nonErrorMarks} non-errors (✓/underline/circle/annotation)`);
          
          resolve({ classifiedMarks, errorQuestionNumbers: new Set() /* filled by caller */ });
        } catch (e) {
          // If VL classification fails, fall back to centroid-based judgment with warning
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

export async function scanPage(pagePath, { apiKey, outputDir, pageIndex = 1, markingMethod = 'red_pen', tencentSecret = null }) {
  const imageB64 = imgToBase64(pagePath);
  
  // Run OCR, red centroids, and preprocess images in parallel
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

export async function scanPages(pagePaths, { apiKey, outputDir, markingMethod = 'red_pen', tencentSecret = null }) {
  const totalStart = Date.now();
  console.log(`[scanner v3.3] Scanning ${pagePaths.length} pages (VL=${VL_CONCURRENCY}, PP=${PREPROCESS_CONCURRENCY})`);
  
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
  
  // VL OCR (API-limited)
  const ocrGate = new ConcurrencyGate(VL_CONCURRENCY);
  const ocrJobs = pagePaths.map((pp, i) =>
    ocrGate.run(async () => {
      try {
        const result = await extractQuestionsVL(pp, apiKey);
        return { index: i, result, engine: 'vl' };
      } catch (vlErr) {
        console.log(`[scanner] Page ${i + 1}: VL failed (${vlErr.message}), trying Tencent...`);
        if (tencentSecret) {
          try {
            const result = await extractQuestionsTencent(pp, tencentSecret);
            return { index: i, result, engine: 'tencent' };
          } catch (tcErr) {
            throw new Error(`Page ${i + 1}: both OCR engines failed`);
          }
        }
        throw vlErr;
      }
    })
  );
  
  const [ppResults, ocrResults] = await Promise.all([
    Promise.all(preprocessJobs),
    Promise.all(ocrJobs)
  ]);
  
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
  
  const totalTime = ((Date.now() - totalStart) / 1000).toFixed(1);
  const allQuestions = pageResults.flatMap(p => p.questions);
  const allErrors = pageResults.flatMap(p => p.errors);
  
  console.log(`[scanner v3.3] Done: ${pageResults.length} pages, ${allQuestions.length} Q, ${allErrors.length} errors in ${totalTime}s`);
  
  return {
    version: SCANNER_VERSION,
    engine: 'vl-ocr + preprocess-v8.0-centroids + vl-mark-classify (parallel)',
    pages: pageResults.length,
    totalQuestions: allQuestions.length,
    totalErrors: allErrors.length,
    totalTime,
    markingMethod,
    questions: allQuestions,
    errors: allErrors,
    pageResults
  };
}

export default { SCANNER_VERSION, scanPage, scanPages };
