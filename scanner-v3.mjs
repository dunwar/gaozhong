/**
 * gaozhong.online — Scanner v3.0
 * 
 * Architecture:
 *   Phase 1: OCR extraction — hybrid PaddleOCR (bbox detection) + VL (text reading)
 *   Phase 2: OpenCV → detect red pen marks (HSV + contour analysis)
 *   Phase 3: Position matching → determine wrong questions
 *   Phase 4: Human confirmation → user validates in UI
 *   Phase 5: DeepSeek analysis → analyze confirmed wrong questions
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { execFileSync, spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SCANNER_VERSION = 'v3.0';

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
  try {
    return JSON.parse(result.stdout.trim());
  } catch (e) {
    console.error(`[scanner-v3] Python output parse error for ${script}:`, result.stdout?.slice(0, 500));
    throw new Error(`Python ${script} returned invalid JSON`);
  }
}

// ═══════════════════════════════════════
// Phase 1: Extract questions (PaddleOCR detection + VL text reading)
// ═══════════════════════════════════════

export async function extractQuestions(pagePath, apiKey) {
  console.log(`[scanner-v3] Phase 1: OCR extraction for ${pagePath}`);
  
  // Try PaddleOCR first (faster, free, local)
  try {
    const padResult = runPython('ocr-page-paddle.py', [pagePath]);
    if (padResult.status === 'ok' && padResult.totalQuestions >= 5) {
      console.log(`[scanner-v3] PaddleOCR extracted ${padResult.totalQuestions} questions (${padResult.totalBlocks} blocks)`);
      return padResult;
    }
    console.log(`[scanner-v3] PaddleOCR found only ${padResult.totalQuestions} questions, falling back to VL`);
  } catch (e) {
    console.log(`[scanner-v3] PaddleOCR failed: ${e.message}, falling back to VL`);
  }
  
  // Fallback to VL OCR (more accurate but uses API)
  const vlResult = runPython('ocr-page.py', [pagePath, '--api-key', apiKey]);
  
  if (vlResult.status !== 'ok') {
    throw new Error(`OCR extraction failed: ${vlResult.error}`);
  }
  
  console.log(`[scanner-v3] VL OCR extracted ${vlResult.totalQuestions} questions`);
  return vlResult;
}

// ═══════════════════════════════════════
// Phase 2: Detect red marks via OpenCV
// ═══════════════════════════════════════

export function detectRedMarks(pagePath, outputDir) {
  console.log(`[scanner-v3] Phase 2: Red mark detection for ${pagePath}`);
  
  const debugDir = join(outputDir, 'debug');
  mkdirSync(debugDir, { recursive: true });
  
  const args = [pagePath, '--debug-dir', debugDir];
  
  const result = runPython('detect-red.py', args);
  
  if (result.status !== 'ok') {
    throw new Error(`Red mark detection failed: ${result.error}`);
  }
  
  console.log(`[scanner-v3] Detected ${result.totalMarks} red marks`);
  return result;
}

// ═══════════════════════════════════════
// Phase 3: Match marks to questions
// ═══════════════════════════════════════

export function matchAndClassify(ocrResult, marksResult, { markingMethod = 'red_pen', margin = 10 } = {}) {
  console.log(`[scanner-v3] Phase 3: Position matching (method=${markingMethod})`);
  
  // Write temp files for Python script
  const tmpDir = '/tmp/gaozhong-scanner';
  mkdirSync(tmpDir, { recursive: true });
  
  const ocrFile = join(tmpDir, `ocr_${Date.now()}.json`);
  const marksFile = join(tmpDir, `marks_${Date.now()}.json`);
  const outFile = join(tmpDir, `match_${Date.now()}.json`);
  
  require('fs').writeFileSync(ocrFile, JSON.stringify(ocrResult));
  require('fs').writeFileSync(marksFile, JSON.stringify(marksResult));
  
  const result = runPython('match-errors.py', [
    '--ocr', ocrFile,
    '--marks', marksFile,
    '--method', markingMethod,
    '--margin', String(margin),
    '--output', outFile
  ]);
  
  if (result.status !== 'ok') {
    throw new Error(`Position matching failed: ${result.error}`);
  }
  
  console.log(`[scanner-v3] Matched: ${result.summary.errorQuestions} errors, ${result.summary.correctQuestions} correct`);
  return result;
}

// ═══════════════════════════════════════
// Full pipeline
// ═══════════════════════════════════════

export async function scanPage(pagePath, { apiKey, outputDir, pageIndex = 1, markingMethod = 'red_pen' }) {
  console.log(`[scanner-v3] === Scanning page ${pageIndex}: ${pagePath} ===`);
  
  // Phase 1: OCR
  const ocrResult = await extractQuestions(pagePath, apiKey);
  
  // Phase 2: Red marks
  const marksResult = detectRedMarks(pagePath, outputDir);
  
  // Phase 3: Match and classify
  const matchResult = matchAndClassify(ocrResult, marksResult, { markingMethod });
  
  return {
    pageIndex,
    ocr: ocrResult,
    marks: marksResult,
    analysis: matchResult
  };
}

/**
 * Scan multiple pages and aggregate results.
 * 
 * @param {string[]} pagePaths - Array of page image paths
 * @param {object} options - { apiKey, outputDir, markingMethod }
 * @returns {object} Aggregated scan results
 */
export async function scanPages(pagePaths, { apiKey, outputDir, markingMethod = 'red_pen' }) {
  const results = [];
  
  // Process pages sequentially to avoid API rate limiting
  for (let i = 0; i < pagePaths.length; i++) {
    const pageResult = await scanPage(pagePaths[i], {
      apiKey,
      outputDir,
      pageIndex: i + 1,
      markingMethod
    });
    results.push(pageResult);
  }
  
  // Aggregate
  const allQuestions = [];
  const allErrors = [];
  let totalMarks = 0;
  
  for (const page of results) {
    for (const q of page.analysis.questions) {
      allQuestions.push({
        ...q,
        pageIndex: page.pageIndex
      });
      if (q.isError) {
        allErrors.push({
          ...q,
          pageIndex: page.pageIndex
        });
      }
    }
    totalMarks += page.marks.totalMarks;
  }
  
  return {
    version: SCANNER_VERSION,
    pages: results.length,
    totalQuestions: allQuestions.length,
    totalErrors: allErrors.length,
    totalMarks,
    markingMethod,
    questions: allQuestions,
    errors: allErrors,
    pageResults: results
  };
}

export default { SCANNER_VERSION, extractQuestions, detectRedMarks, matchAndClassify, scanPage, scanPages };
