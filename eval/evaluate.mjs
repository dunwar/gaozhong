#!/usr/bin/env node
/**
 * gaozhong.online — Scanner Evaluation Tool
 * 
 * Usage:
 *   node eval/evaluate.mjs --paper <paperId>           # Run scanner + compare
 *   node eval/evaluate.mjs --paper <paperId> --scan-only  # Only run scanner, save result
 *   node eval/evaluate.mjs --paper <paperId> --compare-only # Compare saved scan vs ground truth
 * 
 * Output: JSON metrics + human-readable summary
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const EVAL_DIR = __dirname;
const GT_DIR = join(EVAL_DIR, 'ground-truth');
const RESULTS_DIR = join(EVAL_DIR, 'results');

// Parse args
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf('--' + name);
  return idx >= 0 && idx < args.length - 1 ? args[idx + 1] : null;
}
const hasFlag = (name) => args.includes('--' + name);

const paperId = getArg('paper');
if (!paperId) {
  console.error('Usage: node eval/evaluate.mjs --paper <paperId> [--scan-only] [--compare-only] [--json]');
  process.exit(1);
}

const scanOnly = hasFlag('scan-only');
const compareOnly = hasFlag('compare-only');
const jsonOutput = hasFlag('json');

// ═══════════════════════════════════════
// Load ground truth
// ═══════════════════════════════════════

function loadGroundTruth(paperId) {
  const gtPath = join(GT_DIR, `${paperId}.json`);
  if (!existsSync(gtPath)) {
    console.error(`❌ Ground truth not found: ${gtPath}`);
    console.error(`   Create one with: node eval/evaluate.mjs --paper ${paperId} --scan-only`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(gtPath, 'utf-8'));
  return raw;
}

// ═══════════════════════════════════════
// Run scanner
// ═══════════════════════════════════════

async function runScanner(paperId) {
  const papersDir = process.env.PAPERS_DIR || '/app/data/papers';
  const paperDir = join(papersDir, paperId);
  
  if (!existsSync(paperDir)) {
    console.error(`❌ Paper images not found: ${paperDir}`);
    process.exit(1);
  }

  // Collect page images
  const pagePaths = [];
  for (let i = 1; i <= 20; i++) {
    const p = join(paperDir, `page_${i}.jpg`);
    if (existsSync(p)) pagePaths.push(p);
    else break;
  }

  if (pagePaths.length === 0) {
    console.error(`❌ No page images found in ${paperDir}`);
    process.exit(1);
  }

  console.log(`📄 Running scanner on ${pagePaths.length} pages for paper ${paperId}...`);

  // Import scanner
  process.chdir(PROJECT_ROOT);
  const scanner = await import('../scanner-v3.mjs');

  const startTime = Date.now();
  const result = await scanner.scanPages(pagePaths, {
    apiKey: process.env.KIMI_KEY || process.env.DASHSCOPE_API_KEY,
    outputDir: paperDir,
    markingMethod: 'red_pen',
    subject: '英语',
    dualColumn: true
  });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`✅ Scanner completed in ${elapsed}s: ${result.totalQuestions} questions, ${result.totalErrors} errors`);

  // Save raw result
  if (!existsSync(RESULTS_DIR)) {
    const { mkdirSync } = await import('fs');
    mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const resultPath = join(RESULTS_DIR, `${paperId}-scan.json`);
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  console.log(`💾 Saved scan result to ${resultPath}`);

  return result;
}

// ═══════════════════════════════════════
// Load saved scan result
// ═══════════════════════════════════════

function loadScanResult(paperId) {
  const resultPath = join(RESULTS_DIR, `${paperId}-scan.json`);
  if (!existsSync(resultPath)) {
    console.error(`❌ Scan result not found: ${resultPath}`);
    console.error(`   Run scanner first: node eval/evaluate.mjs --paper ${paperId}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(resultPath, 'utf-8'));
}

// ═══════════════════════════════════════
// Compare scan result vs ground truth
// ═══════════════════════════════════════

function compare(scanResult, groundTruth) {
  const gtQuestions = groundTruth.questions;
  
  // Build lookup maps by question number
  const gtMap = new Map();
  for (const q of gtQuestions) {
    gtMap.set(q.questionNumber, q);
  }

  const scanQuestions = scanResult.questions || [];
  const scanErrors = new Set((scanResult.errors || []).map(q => q.questionNumber));
  const scanMap = new Map();
  for (const q of scanQuestions) {
    scanMap.set(q.questionNumber, q);
  }

  // === Question Detection Metrics ===
  let detected = 0;       // Question exists in both GT and scan
  let missed = 0;         // In GT but not in scan
  let hallucinated = 0;   // In scan but not in GT
  
  const missedQuestions = [];
  const hallucinatedQuestions = [];

  for (const [qn, q] of gtMap) {
    if (scanMap.has(qn)) {
      detected++;
    } else {
      missed++;
      missedQuestions.push(qn);
    }
  }

  for (const [qn, q] of scanMap) {
    if (!gtMap.has(qn)) {
      hallucinated++;
      hallucinatedQuestions.push(qn);
    }
  }

  const questionRecall = gtQuestions.length > 0 ? detected / gtQuestions.length : 0;
  const questionPrecision = scanQuestions.length > 0 ? detected / scanQuestions.length : 0;

  // === Error Detection Metrics ===
  // Only evaluate error detection for questions that were detected by both
  let errorTP = 0;  // Both GT and scan say error
  let errorFP = 0;  // GT says correct, scan says error
  let errorFN = 0;  // GT says error, scan says correct
  let errorTN = 0;  // Both say correct

  const fpDetails = [];
  const fnDetails = [];

  for (const [qn, gtQ] of gtMap) {
    if (!scanMap.has(qn)) continue; // Skip questions not detected
    const scanIsError = scanErrors.has(qn);
    const gtIsError = gtQ.isError;

    if (gtIsError && scanIsError) errorTP++;
    else if (!gtIsError && scanIsError) { errorFP++; fpDetails.push(qn); }
    else if (gtIsError && !scanIsError) { errorFN++; fnDetails.push(qn); }
    else errorTN++;
  }

  const errorPrecision = (errorTP + errorFP) > 0 ? errorTP / (errorTP + errorFP) : 1;
  const errorRecall = (errorTP + errorFN) > 0 ? errorTP / (errorTP + errorFN) : 1;
  const errorF1 = (errorPrecision + errorRecall) > 0 ? 2 * errorPrecision * errorRecall / (errorPrecision + errorRecall) : 0;

  // === Question Type Accuracy ===
  let typeMatch = 0;
  let typeMismatch = 0;
  const typeMismatches = [];

  for (const [qn, gtQ] of gtMap) {
    if (!scanMap.has(qn)) continue;
    const scanQ = scanMap.get(qn);
    if (gtQ.questionType === scanQ.questionType) {
      typeMatch++;
    } else {
      typeMismatch++;
      typeMismatches.push({ qn, gt: gtQ.questionType, scan: scanQ.questionType });
    }
  }

  const typeAccuracy = (typeMatch + typeMismatch) > 0 ? typeMatch / (typeMatch + typeMismatch) : 0;

  // === Page Assignment Accuracy ===
  let pageMatch = 0;
  let pageMismatch = 0;
  for (const [qn, gtQ] of gtMap) {
    if (!scanMap.has(qn)) continue;
    const scanQ = scanMap.get(qn);
    if (gtQ.pageIndex === scanQ.pageIndex) {
      pageMatch++;
    } else {
      pageMismatch++;
    }
  }

  const pageAccuracy = (pageMatch + pageMismatch) > 0 ? pageMatch / (pageMatch + pageMismatch) : 0;

  // === Build result ===
  const metrics = {
    paperId: groundTruth.paperId,
    subject: groundTruth.subject,
    gtVerified: groundTruth.verified,
    scannerVersion: scanResult.version,
    
    questionDetection: {
      total: gtQuestions.length,
      detected,
      missed,
      hallucinated,
      recall: questionRecall,
      precision: questionPrecision,
      missedQuestions,
      hallucinatedQuestions,
    },

    errorDetection: {
      tp: errorTP,
      fp: errorFP,
      fn: errorFN,
      tn: errorTN,
      precision: errorPrecision,
      recall: errorRecall,
      f1: errorF1,
      fpDetails,
      fnDetails,
    },

    typeClassification: {
      match: typeMatch,
      mismatch: typeMismatch,
      accuracy: typeAccuracy,
      mismatches: typeMismatches,
    },

    pageAssignment: {
      match: pageMatch,
      mismatch: pageMismatch,
      accuracy: pageAccuracy,
    },

    timing: {
      scanTime: scanResult.totalTime,
      pages: scanResult.pages,
    }
  };

  return metrics;
}

// ═══════════════════════════════════════
// Format output
// ═══════════════════════════════════════

function printReport(metrics) {
  const pct = (v) => (v * 100).toFixed(1) + '%';

  if (jsonOutput) {
    console.log(JSON.stringify(metrics, null, 2));
    return;
  }

  console.log('\n' + '═'.repeat(60));
  console.log(`  📊 EVAL REPORT — Paper ${metrics.paperId} (${metrics.subject})`);
  console.log('═'.repeat(60));

  if (!metrics.gtVerified) {
    console.log('  ⚠️  Ground truth NOT verified — treat metrics as provisional');
  }

  console.log(`\n  🔍 Question Detection`);
  console.log(`     Ground truth: ${metrics.questionDetection.total} questions`);
  console.log(`     Detected:     ${metrics.questionDetection.detected}`);
  console.log(`     Missed:       ${metrics.questionDetection.missed}${metrics.questionDetection.missedQuestions.length ? ' (' + metrics.questionDetection.missedQuestions.join(', ') + ')' : ''}`);
  console.log(`     Hallucinated: ${metrics.questionDetection.hallucinated}${metrics.questionDetection.hallucinatedQuestions.length ? ' (' + metrics.questionDetection.hallucinatedQuestions.join(', ') + ')' : ''}`);
  console.log(`     Recall:       ${pct(metrics.questionDetection.recall)}`);
  console.log(`     Precision:    ${pct(metrics.questionDetection.precision)}`);

  console.log(`\n  ❌ Error Detection (红笔判错)`);
  console.log(`     TP: ${metrics.errorDetection.tp}  FP: ${metrics.errorDetection.fp}  FN: ${metrics.errorDetection.fn}  TN: ${metrics.errorDetection.tn}`);
  if (metrics.errorDetection.fpDetails.length) {
    console.log(`     False Positives (误判为错): Q${metrics.errorDetection.fpDetails.join(', Q')}`);
  }
  if (metrics.errorDetection.fnDetails.length) {
    console.log(`     False Negatives (漏判): Q${metrics.errorDetection.fnDetails.join(', Q')}`);
  }
  console.log(`     Precision: ${pct(metrics.errorDetection.precision)}`);
  console.log(`     Recall:    ${pct(metrics.errorDetection.recall)}`);
  console.log(`     F1:        ${pct(metrics.errorDetection.f1)}`);

  console.log(`\n  🏷️  Type Classification`);
  console.log(`     Match: ${metrics.typeClassification.match}  Mismatch: ${metrics.typeClassification.mismatch}`);
  console.log(`     Accuracy: ${pct(metrics.typeClassification.accuracy)}`);
  if (metrics.typeClassification.mismatches.length) {
    for (const m of metrics.typeClassification.mismatches) {
      console.log(`     Q${m.qn}: GT=${m.gt} → Scan=${m.scan}`);
    }
  }

  console.log(`\n  📍 Page Assignment`);
  console.log(`     Accuracy: ${pct(metrics.pageAssignment.accuracy)} (${metrics.pageAssignment.match}/${metrics.pageAssignment.match + metrics.pageAssignment.mismatch})`);

  console.log(`\n  ⏱️  Timing`);
  console.log(`     ${metrics.timing.pages} pages in ${metrics.timing.scanTime}s`);

  // Overall score
  const overall = (metrics.questionDetection.recall + metrics.errorDetection.f1 + metrics.typeClassification.accuracy) / 3;
  console.log(`\n  📈 Overall Score: ${pct(overall)}`);
  console.log('═'.repeat(60) + '\n');
}

// ═══════════════════════════════════════
// Main
// ═══════════════════════════════════════

async function main() {
  if (scanOnly) {
    await runScanner(paperId);
    return;
  }

  let scanResult;
  if (compareOnly) {
    scanResult = loadScanResult(paperId);
  } else {
    scanResult = await runScanner(paperId);
  }

  const groundTruth = loadGroundTruth(paperId);
  const metrics = compare(scanResult, groundTruth);
  printReport(metrics);

  // Save metrics
  if (!existsSync(RESULTS_DIR)) {
    const { mkdirSync } = await import('fs');
    mkdirSync(RESULTS_DIR, { recursive: true });
  }
  const metricsPath = join(RESULTS_DIR, `${paperId}-metrics.json`);
  writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
  console.log(`💾 Metrics saved to ${metricsPath}`);
}

main().catch(err => {
  console.error('❌ Evaluation failed:', err.message);
  process.exit(1);
});
