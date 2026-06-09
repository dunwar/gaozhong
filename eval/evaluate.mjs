#!/usr/bin/env node
/**
 * gaozhong.online — Scanner 评测脚本
 * 
 * 用法:
 *   node eval/evaluate.mjs --session 3623c60f           # 评测单张试卷
 *   node eval/evaluate.mjs --all                        # 评测所有 ground-truth 试卷
 *   node eval/evaluate.mjs --compare cdf102b c4d3824    # 对比两个版本
 *   node eval/evaluate.mjs --version HEAD               # 指定版本标签
 * 
 * 输出: 量化评测报告（召回率、精确率、题型准确率、错题判定）
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const PAPERS_DIR = '/app/data/papers';
const API_URL = 'http://localhost:3001';

// ═══════════════════════════════════════
// CLI 参数解析
// ═══════════════════════════════════════

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { session: null, all: false, compare: null, version: 'HEAD', timeout: 600 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--session': opts.session = args[++i]; break;
      case '--all': opts.all = true; break;
      case '--compare': opts.compare = [args[++i], args[++i]]; break;
      case '--version': opts.version = args[++i]; break;
      case '--timeout': opts.timeout = parseInt(args[++i]); break;
      case '--help':
        console.log(`
用法:
  node eval/evaluate.mjs --session <id>     评测单张试卷
  node eval/evaluate.mjs --all              评测所有标注试卷
  node eval/evaluate.mjs --compare <a> <b>  对比两个 git commit
  node eval/evaluate.mjs --version <tag>    指定版本标签
`);
        process.exit(0);
    }
  }
  return opts;
}

// ═══════════════════════════════════════
// 评测核心逻辑
// ═══════════════════════════════════════

/**
 * 计算单张试卷的评测指标
 */
function evaluatePaper(scanResult, groundTruth) {
  const gtQuestions = groundTruth.questions || [];
  const scanQuestions = scanResult.questions || [];
  
  // Build lookup by question number
  const gtByNumber = new Map();
  for (const q of gtQuestions) {
    gtByNumber.set(q.questionNumber, q);
  }
  
  const scanByNumber = new Map();
  for (const q of scanQuestions) {
    scanByNumber.set(q.questionNumber, q);
  }
  
  // 1. Question recall: how many GT questions were found
  let recallHits = 0;
  let numberMatches = 0;
  let typeMatches = 0;
  
  for (const [num, gtQ] of gtByNumber) {
    if (scanByNumber.has(num)) {
      recallHits++;
      const scanQ = scanByNumber.get(num);
      // Number match (exact)
      if (scanQ.questionNumber === num) numberMatches++;
      // Type match
      if (scanQ.questionType === gtQ.questionType) typeMatches++;
    }
  }
  
  const questionRecall = gtQuestions.length > 0 ? recallHits / gtQuestions.length : 0;
  const numberPrecision = scanQuestions.length > 0 ? numberMatches / scanQuestions.length : 0;
  const typeAccuracy = recallHits > 0 ? typeMatches / recallHits : 0;
  
  // 2. Error detection evaluation
  const gtErrors = new Set(gtQuestions.filter(q => q.isError).map(q => q.questionNumber));
  const scanErrors = new Set(scanQuestions.filter(q => q.isError).map(q => q.questionNumber));
  
  let errorRecallCount = 0;
  for (const e of gtErrors) {
    if (scanErrors.has(e)) errorRecallCount++;
  }
  
  let falsePositives = 0;
  for (const e of scanErrors) {
    if (!gtErrors.has(e)) falsePositives++;
  }
  
  const errorRecall = gtErrors.size > 0 ? errorRecallCount / gtErrors.size : (scanErrors.size === 0 ? 1 : 0);
  const errorPrecision = scanErrors.size > 0 ? (scanErrors.size - falsePositives) / scanErrors.size : (gtErrors.size === 0 ? 1 : 0);
  
  return {
    totalQuestions: gtQuestions.length,
    foundQuestions: scanQuestions.length,
    recallHits,
    questionRecall: Math.round(questionRecall * 1000) / 10,
    numberPrecision: Math.round(numberPrecision * 1000) / 10,
    typeAccuracy: Math.round(typeAccuracy * 1000) / 10,
    gtErrorCount: gtErrors.size,
    foundErrorCount: scanErrors.size,
    errorRecallCount,
    falsePositives,
    errorRecall: Math.round(errorRecall * 1000) / 10,
    errorPrecision: Math.round(errorPrecision * 1000) / 10,
    totalTime: scanResult.totalTime || scanResult.time || null
  };
}

/**
 * 运行 scanner API 扫描
 */
async function runScan(sessionId, timeout = 600) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  
  try {
    const resp = await fetch(`${API_URL}/paper/test-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
      signal: controller.signal
    });
    clearTimeout(timer);
    
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API ${resp.status}: ${text.substring(0, 200)}`);
    }
    return await resp.json();
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`Timeout after ${timeout}s`);
    throw e;
  }
}

/**
 * 格式化单个试卷评测结果
 */
function formatPaperReport(sessionId, metrics, meta) {
  const label = meta?.subject || '';
  const pages = meta?.pages || '?';
  const lines = [];
  lines.push(`试卷 ${sessionId} (${pages}p${label ? ', ' + label : ''}):`);
  lines.push(`  题目召回: ${metrics.recallHits}/${metrics.totalQuestions} (${metrics.questionRecall}%)`);
  lines.push(`  题号精确: ${metrics.numberPrecision}%`);
  lines.push(`  题型准确: ${metrics.typeAccuracy}%`);
  lines.push(`  错题判定: ${metrics.errorRecallCount}/${metrics.gtErrorCount} 召回, ${metrics.falsePositives} 误报 (精确 ${metrics.errorPrecision}%)`);
  if (metrics.totalTime) lines.push(`  耗时: ${metrics.totalTime}s`);
  return lines.join('\n');
}

// ═══════════════════════════════════════
// 主流程
// ═══════════════════════════════════════

async function main() {
  const opts = parseArgs();
  
  // Determine which sessions to evaluate
  let sessions = [];
  if (opts.session) {
    sessions = [opts.session];
  } else if (opts.all) {
    const gtDir = join(PROJECT_ROOT, 'eval', 'ground-truth');
    sessions = readdirSync(gtDir).filter(d => {
      return existsSync(join(gtDir, d, 'ground-truth.json'));
    });
  } else {
    console.log('请指定 --session <id> 或 --all');
    console.log('用法: node eval/evaluate.mjs --help');
    process.exit(1);
  }
  
  if (sessions.length === 0) {
    console.log('❌ 没有找到可评测的试卷。');
    console.log('请先创建 ground truth: eval/ground-truth/<session_id>/ground-truth.json');
    process.exit(1);
  }
  
  // Get git version info
  let gitHash = 'unknown';
  let gitMsg = '';
  try {
    gitHash = execSync('git rev-parse --short HEAD', { cwd: PROJECT_ROOT }).toString().trim();
    gitMsg = execSync('git log -1 --format="%s"', { cwd: PROJECT_ROOT }).toString().trim();
  } catch {}
  
  console.log('═══════════════════════════════════════════');
  console.log(`📊 Scanner 评测报告 — ${opts.version} (${gitHash})`);
  console.log(`   ${gitMsg}`);
  console.log('═══════════════════════════════════════════');
  console.log('');
  
  const allMetrics = [];
  
  for (const sessionId of sessions) {
    const gtPath = join(PROJECT_ROOT, 'eval', 'ground-truth', sessionId, 'ground-truth.json');
    const metaPath = join(PROJECT_ROOT, 'eval', 'ground-truth', sessionId, 'meta.json');
    
    if (!existsSync(gtPath)) {
      console.log(`⚠️ 跳过 ${sessionId}: 缺少 ground-truth.json`);
      continue;
    }
    
    const groundTruth = JSON.parse(readFileSync(gtPath, 'utf8'));
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : {};
    
    console.log(`🔍 扫描 ${sessionId} ...`);
    try {
      const scanResult = await runScan(sessionId, opts.timeout);
      const metrics = evaluatePaper(scanResult, groundTruth);
      
      console.log(formatPaperReport(sessionId, metrics, meta));
      console.log('');
      
      allMetrics.push({ sessionId, metrics, meta });
      
      // Save raw result
      const resultPath = join(PROJECT_ROOT, 'eval', 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}_${gitHash}_${sessionId}.json`);
      writeFileSync(resultPath, JSON.stringify({ gitHash, version: opts.version, sessionId, scanResult, metrics }, null, 2));
      
    } catch (e) {
      console.log(`❌ ${sessionId}: ${e.message}`);
      console.log('');
    }
  }
  
  // Summary
  if (allMetrics.length > 1) {
    const totalGT = allMetrics.reduce((s, m) => s + m.metrics.totalQuestions, 0);
    const totalRecall = allMetrics.reduce((s, m) => s + m.metrics.recallHits, 0);
    const totalGTErrors = allMetrics.reduce((s, m) => s + m.metrics.gtErrorCount, 0);
    const totalErrorRecall = allMetrics.reduce((s, m) => s + m.metrics.errorRecallCount, 0);
    const totalFP = allMetrics.reduce((s, m) => s + m.metrics.falsePositives, 0);
    
    console.log('───────────────────────────────────────────');
    console.log(`汇总 (${allMetrics.length} 张试卷):`);
    console.log(`  总题目召回: ${totalRecall}/${totalGT} (${Math.round(totalRecall/totalGT*1000)/10}%)`);
    console.log(`  总错题判定: ${totalErrorRecall}/${totalGTErrors} 召回, ${totalFP} 误报`);
    console.log('═══════════════════════════════════════════');
  }
  
  // Save summary as baseline if requested
  const summaryPath = join(PROJECT_ROOT, 'eval', 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}_${gitHash}_summary.json`);
  writeFileSync(summaryPath, JSON.stringify({ gitHash, version: opts.version, timestamp: new Date().toISOString(), papers: allMetrics }, null, 2));
  console.log(`\n📁 结果已保存: ${summaryPath}`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
