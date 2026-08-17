#!/usr/bin/env node
/**
 * run-paper.mjs — 对一份试卷目录跑完整识别流水线（本地评测入口）
 *
 * 用法:
 *   node eval/run-paper.mjs <试卷图片目录> [--subject 英语] [--out eval/results/<id>]
 *
 * 流程: prepare-pages → 去红/红笔质心 → TextIn OCR + LLM 解析 → VL 红笔分类 → 质心匹配判错
 * 输出: <out>/scan_output.json（完整 scanPages 结果，供 evaluate.mjs 对比 ground truth）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, resolve, basename } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirnameOf(import.meta.url);
const PROJECT_ROOT = resolve(__dirname, '..');

// ── 解析命令行参数 ──
const argv = process.argv.slice(2);
if (argv.length < 1) {
  console.error('用法: node eval/run-paper.mjs <试卷图片目录> [--subject 英语] [--out 输出目录]');
  process.exit(1);
}
const paperDir = resolve(argv[0]);
let subject = '英语';
let outDir = null;
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--subject') subject = argv[++i];
  else if (argv[i] === '--out') outDir = resolve(argv[++i]);
}

// ── 加载 .env（必须在 import scanner 之前 — ZHIPU_KEY 在模块加载时求值）──
const envFile = join(PROJECT_ROOT, '.env');
if (existsSync(envFile)) {
  for (const raw of readFileSync(envFile, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const key = line.slice(0, line.indexOf('=')).trim();
    const val = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) process.env[key] = val;
  }
}

// ── 收集试卷图片（文件名自然排序，与生产一致）──
const IMG_RE = /\.(jpe?g|png|webp)$/i;
const images = readdirSync(paperDir)
  .filter(f => IMG_RE.test(f) && !f.startsWith('.'))
  .sort(naturalCompare)
  .map(f => join(paperDir, f));

if (images.length === 0) {
  console.error(`目录下没有图片: ${paperDir}`);
  process.exit(1);
}

const paperId = basename(paperDir);
if (!outDir) outDir = join(PROJECT_ROOT, 'eval', 'results', paperId);
mkdirSync(outDir, { recursive: true });

console.log(`═══════════════════════════════════════════`);
console.log(`试卷: ${paperId} (${images.length} 张图, 科目=${subject})`);
images.forEach((p, i) => console.log(`  [${i + 1}] ${basename(p)}`));
console.log(`输出: ${outDir}`);
console.log(`═══════════════════════════════════════════`);

// ── 动态导入 scanner（此时 env 已就位）──
const scanner = await import(pathToFileURL(join(PROJECT_ROOT, 'scanner-v3.mjs')).href);

try {
  const result = await scanner.scanPages(images, {
    apiKey: process.env.KIMI_API_KEY,
    outputDir: outDir,
    markingMethod: 'red_pen',
    subject
  });

  writeFileSync(join(outDir, 'scan_output.json'), JSON.stringify(result, null, 2), 'utf-8');

  console.log(`\n═══════════════════════════════════════════`);
  console.log(`✅ 扫描完成: v${result.version}`);
  console.log(`   页数=${result.pages}  题目=${result.totalQuestions}  错题=${result.totalErrors}  耗时=${result.totalTime}s`);
  console.log(`   结果已写入: ${join(outDir, 'scan_output.json')}`);

  // 摘要: 每页识别情况
  for (const p of result.pageResults) {
    console.log(`   P${p.pageIndex}: engine=${p.engine} q=${p.totalQuestions} err=${p.totalErrors} redRegions=${p.totalRegions} vlMarks=${p.vlMarkCount}`);
  }
  // 摘要: 错题题号
  const errNums = result.errors.map(e => e.questionNumber).sort((a, b) => a - b);
  console.log(`\n   判定错题题号: [${errNums.join(', ')}]`);
  const allNums = result.questions.map(q => q.questionNumber).sort((a, b) => a - b);
  console.log(`   识别题目题号: [${allNums.join(', ')}]`);
} catch (err) {
  console.error(`❌ 扫描失败: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}

// ── 工具函数 ──
function dirnameOf(u) {
  return join(fileURLToPath(u), '..');
}

/** 文件名自然排序（与生产 prepare-pages 的页码提取一致方向） */
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
