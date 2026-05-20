/**
 * gaozhong.online — Scanner v3.1
 * 
 * Hybrid architecture:
 *   VL OCR → accurate question structure (text, numbers, options)
 *   Preprocess v7.2 → deterministic red pen detection (OpenCV HSV)
 *   Cross-reference by Y-bbox overlap → classify errors
 * 
 * This combines VL's excellent text recognition with OpenCV's deterministic
 * red pen detection, avoiding PaddleOCR's poor English recognition.
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SCANNER_VERSION = 'v3.1';
const PREPROCESS_URL = process.env.PREPROCESS_URL || 'http://localhost:5002';

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
    encoding: 'utf-8',
    timeout: 300_000,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) throw result.error;
  const stdout = result.stdout.trim();
  if (!stdout) throw new Error(`Python ${script} returned empty output`);
  try {
    return JSON.parse(stdout);
  } catch (e) {
    console.error(`[scanner] Parse error for ${script}:`, stdout.slice(0, 500));
    throw new Error(`Python ${script} returned invalid JSON`);
  }
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
    req.write(postData);
    req.end();
  });
}

// ═══════════════════════════════════════
// Phase 1: VL OCR for question structure
// ═══════════════════════════════════════

function extractQuestionsVL(pagePath, apiKey) {
  console.log(`[scanner] VL OCR: extracting questions from ${pagePath}`);
  const result = runPython('ocr-page.py', [pagePath, '--api-key', apiKey]);
  
  if (result.status !== 'ok') {
    throw new Error(`VL OCR failed: ${result.error}`);
  }
  
  console.log(`[scanner] VL OCR found ${result.totalQuestions} questions`);
  return result;
}

// ═══════════════════════════════════════
// Phase 2: Preprocess v7.2 for red pen detection
// ═══════════════════════════════════════

async function detectRedRegions(imageBase64) {
  console.log(`[scanner] Preprocess: detecting red pen regions`);
  
  const u = new URL(PREPROCESS_URL);
  const data = await httpPostJson(u.hostname, parseInt(u.port) || 5002, '/preprocess', {
    image: imageBase64,
    options: { deskew: true, red: true, layout: false }  // layout=false: skip PaddleOCR, just red detection + grid regions
  });
  
  if (data.status !== 'ok') {
    throw new Error(`Preprocess failed: ${data.error}`);
  }
  
  const r = data.result;
  console.log(`[scanner] Red regions: ${r.region_count || 0}, with red: ${r.regions_with_red || 0}, signal: ${r.red_signal}`);
  
  return r;
}

/**
 * Compute red overlap ratio for a question bbox against preprocess red regions.
 */
function computeRedOverlap(questionBbox, redRegions) {
  const qx1 = questionBbox.x;
  const qy1 = questionBbox.y;
  const qx2 = qx1 + questionBbox.w;
  const qy2 = qy1 + questionBbox.h;
  
  let maxRedRatio = 0;
  
  for (const reg of (redRegions || [])) {
    if (!reg.bbox || reg.bbox.length < 4) continue;
    const [rx, ry, rw, rh] = reg.bbox;
    const rx2 = rx + rw;
    const ry2 = ry + rh;
    
    // Intersection
    const ix1 = Math.max(qx1, rx);
    const iy1 = Math.max(qy1, ry);
    const ix2 = Math.min(qx2, rx2);
    const iy2 = Math.min(qy2, ry2);
    
    if (ix1 < ix2 && iy1 < iy2) {
      // Some overlap exists → use the region's red ratio
      maxRedRatio = Math.max(maxRedRatio, reg.red_ratio || 0);
    }
  }
  
  return maxRedRatio;
}

// ═══════════════════════════════════════
// Full pipeline — scan one page
// ═══════════════════════════════════════

export async function scanPage(pagePath, { apiKey, outputDir, pageIndex = 1, markingMethod = 'red_pen' }) {
  console.log(`[scanner] === Page ${pageIndex}: ${pagePath} ===`);
  
  // Run VL OCR and red detection in parallel
  const imageB64 = imgToBase64(pagePath);
  
  const [vlResult, redResult] = await Promise.all([
    Promise.resolve().then(() => extractQuestionsVL(pagePath, apiKey)),
    detectRedRegions(imageB64)
  ]);
  
  const vlQuestions = vlResult.questions || [];
  const redRegions = redResult.regions || [];
  
  console.log(`[scanner] Cross-referencing ${vlQuestions.length} VL questions × ${redRegions.length} red regions`);
  
  // Cross-reference: for each VL question, compute red overlap ratio
  // Use relative threshold: a question has red marks if its red_ratio > 2x the page's baseline
  const pageRedSignal = redResult.red_signal || 0.001;
  const RED_MULTIPLIER = 2.5;  // Need 2.5x the page average to count as red marks
  
  const questions = vlQuestions.map(vq => {
    const redRatio = computeRedOverlap(vq.bbox, redRegions);
    const hasRed = redRatio > pageRedSignal * RED_MULTIPLIER;
    
    return {
      questionNumber: vq.questionNumber,
      questionType: vq.questionType || 'choice',
      questionText: vq.questionText || '',
      options: vq.options || {},
      bbox: vq.bbox,
      pageIndex,
      hasRed,
      redRatio: Math.round(redRatio * 100000) / 100000,
      isError: hasRed,
      errorSource: hasRed ? 'red_overlap' : null
    };
  });
  
  const errors = questions.filter(q => q.isError);
  
  console.log(`[scanner] Result: ${questions.length} questions, ${errors.length} errors (red_signal=${redResult.red_signal})`);
  
  return {
    pageIndex,
    version: SCANNER_VERSION,
    engine: 'vl-ocr + preprocess-v7.2-red',
    totalQuestions: questions.length,
    totalErrors: errors.length,
    redSignal: redResult.red_signal,
    questions,
    errors,
    correctedImage: redResult.corrected,
    redHighlightedImage: redResult.red_highlighted,
    imageSize: vlResult.imageSize || null
  };
}

/**
 * Scan multiple pages sequentially.
 */
export async function scanPages(pagePaths, { apiKey, outputDir, markingMethod = 'red_pen' }) {
  const pageResults = [];
  
  for (const pagePath of pagePaths) {
    const pageResult = await scanPage(pagePath, {
      apiKey, outputDir,
      pageIndex: pageResults.length + 1,
      markingMethod
    });
    pageResults.push(pageResult);
  }
  
  const allQuestions = pageResults.flatMap(p => p.questions);
  const allErrors = pageResults.flatMap(p => p.errors);
  
  return {
    version: SCANNER_VERSION,
    engine: 'vl-ocr + preprocess-v7.2-red',
    pages: pageResults.length,
    totalQuestions: allQuestions.length,
    totalErrors: allErrors.length,
    markingMethod,
    questions: allQuestions,
    errors: allErrors,
    pageResults
  };
}

export default { SCANNER_VERSION, scanPage, scanPages };
