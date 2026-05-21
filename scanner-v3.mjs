/**
 * gaozhong.online — Scanner v3.3
 * 
 * v3.3 变更: 连通域质心落点匹配，替代页面级阈值
 *   - 使用 /red-regions (connectedComponentsWithStats) 代替轮廓分析
 *   - 质心 Point-in-BBox (10% margin) 替代重叠面积比
 *   - 逐题局部密度替代全局 red_signal × 2.5
 * 
 * Architecture:
 *   Primary:   VL OCR (Kimi k2.6) → question structure
 *   Red:       Preprocess v8.0 /red-regions → red centroid map
 *   Fallback:  Tencent Cloud OCR → text blocks + rule engine
 *   All pages scanned in PARALLEL
 */

import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SCANNER_VERSION = 'v3.3';
const PREPROCESS_URL = process.env.PREPROCESS_URL || 'http://localhost:5002';
const VL_CONCURRENCY = 4;
const PREPROCESS_CONCURRENCY = 20;

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
  const result = spawnSync('python3', [scriptPath, ...args], {
    encoding: 'utf-8', timeout: 300_000, maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) throw result.error;
  const stdout = result.stdout.trim();
  if (!stdout) throw new Error(`Python ${script} returned empty output`);
  try { return JSON.parse(stdout); }
  catch (e) { throw new Error(`Python ${script} invalid JSON: ${stdout.slice(0, 200)}`); }
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

function extractQuestionsVL(pagePath, apiKey) {
  const result = runPython('ocr-page.py', [pagePath, '--api-key', apiKey]);
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
  const result = runPython('ocr-tencent.py', [
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
// v3.3: Centroid-based matching
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
 * For each question, count centroids inside its expanded bbox and sum red energy.
 * Returns per-question { centroidCount, redEnergy, matchedRegions[] }
 */
function matchCentroidsToQuestions(questions, regions, pageStats) {
  const MIN_RED_ENERGY = Math.max(pageStats.median * 3, 100);  // floor: 100px
  const results = [];
  
  for (const q of questions) {
    if (!q.bbox || q.bbox.w == null) {
      results.push({ ...q, centroidCount: 0, redEnergy: 0, matchedRegions: [], isError: false });
      continue;
    }
    
    const matched = [];
    let redEnergy = 0;
    
    for (const reg of (regions || [])) {
      if (!reg.centroid) continue;
      if (centroidInBbox(reg.centroid, q.bbox)) {
        matched.push(reg);
        redEnergy += reg.area || 0;
      }
    }
    
    const centroidCount = matched.length;
    // 判定: ≥2个红笔质心 OR 累积红笔面积超过阈值
    const isError = centroidCount >= 2 || redEnergy >= MIN_RED_ENERGY;
    
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
      errorSource: isError ? 'red_centroids' : null,
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
  
  console.log(`[scanner] Page ${pageIndex}: ${vlQuestions.length} questions, ${regions.length} red regions (median area=${pageStats.median})`);
  
  // Match centroids to questions
  const questions = matchCentroidsToQuestions(
    vlQuestions.map(q => ({ ...q, pageIndex })), 
    regions, 
    pageStats
  );
  
  const errors = questions.filter(q => q.isError);
  
  return {
    pageIndex,
    version: SCANNER_VERSION,
    engine: 'vl-ocr + preprocess-v8.0-centroids',
    totalQuestions: questions.length,
    totalErrors: errors.length,
    redSignal: redCentroidResult.red_signal,
    pageStats,
    totalRegions: regions.length,
    questions,
    errors,
    correctedImage: ppImageResult.corrected,
    redHighlightedImage: ppImageResult.red_highlighted,
    imageSize: ocrResult.data.imageSize || null
  };
}

// ═══════════════════════════════════════
// MULTI-PAGE PARALLEL SCAN (v3.3)
// ═══════════════════════════════════════

export async function scanPages(pagePaths, { apiKey, outputDir, markingMethod = 'red_pen', tencentSecret = null }) {
  const totalStart = Date.now();
  console.log(`[scanner v3.3] Scanning ${pagePaths.length} pages (VL=${VL_CONCURRENCY}, PP=${PREPROCESS_CONCURRENCY})`);
  
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
  
  // Phase 3: Centroid matching per page
  const pageResults = [];
  for (let i = 0; i < pagePaths.length; i++) {
    const pp = ppResults.find(r => r.index === i);
    const ocr = ocrResults.find(r => r.index === i);
    
    const vlQuestions = ocr.result.questions || [];
    const regions = pp.centroids.regions || [];
    const pageStats = pp.centroids.page_stats || { median: 0 };
    
    const questions = matchCentroidsToQuestions(
      vlQuestions.map(q => ({ ...q, pageIndex: i + 1 })),
      regions,
      pageStats
    );
    
    pageResults.push({
      pageIndex: i + 1,
      engine: ocr.engine,
      totalQuestions: questions.length,
      totalErrors: questions.filter(q => q.isError).length,
      redSignal: pp.centroids.red_signal,
      pageStats,
      totalRegions: regions.length,
      questions,
      errors: questions.filter(q => q.isError),
      correctedImage: pp.images.corrected,
      redHighlightedImage: pp.images.red_highlighted
    });
  }
  
  const totalTime = ((Date.now() - totalStart) / 1000).toFixed(1);
  const allQuestions = pageResults.flatMap(p => p.questions);
  const allErrors = pageResults.flatMap(p => p.errors);
  
  console.log(`[scanner v3.3] Done: ${pageResults.length} pages, ${allQuestions.length} Q, ${allErrors.length} errors in ${totalTime}s`);
  
  return {
    version: SCANNER_VERSION,
    engine: 'vl-ocr + preprocess-v8.0-centroids (parallel)',
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
