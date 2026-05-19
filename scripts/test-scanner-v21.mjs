/**
 * v2.1 Scanner 端到端测试 — yingyu34
 * 用法: node scripts/test-scanner-v21.mjs
 */
import { scanPage } from '../scanner-v1.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SESSION_ID = 'dc791392';  // yingyu34-R3
const PAPERS_DIR = '/app/data/papers';
const PAGE_PATH = path.join(PAPERS_DIR, SESSION_ID, 'page_1.jpg');
const OUTPUT_DIR = `/tmp/yingyu34-v21-test-${Date.now()}`;
const API_KEY = process.env.KIMI_API_KEY;

if (!API_KEY) {
  console.error('❌ 缺少 KIMI_API_KEY 环境变量');
  process.exit(1);
}

if (!fs.existsSync(PAGE_PATH)) {
  console.error(`❌ 找不到图片: ${PAGE_PATH}`);
  process.exit(1);
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

console.log(`🔬 开始 v2.1 Scanner 端到端测试`);
console.log(`📸 图片: ${PAGE_PATH}`);
console.log(`📁 输出: ${OUTPUT_DIR}`);
console.log('');

try {
  const startTime = Date.now();
  const result = await scanPage(PAGE_PATH, {
    apiKey: API_KEY,
    outputDir: OUTPUT_DIR,
    pageIndex: 1
  });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('📊 结果汇总');
  console.log('═══════════════════════════════════════');
  console.log(`  检测题目: ${result.questions}`);
  console.log(`  成功裁切: ${result.crops}`);
  console.log(`  判错总数: ${result.errors}`);
  console.log(`  需复核:   ${result.needsReview}`);
  console.log(`  总耗时:   ${elapsed}s`);
  console.log('');

  console.log('📋 逐题结果:');
  console.log('题号 | 判错? | 置信度 | 学生答案 | 正确/红笔 | 意图 | 证据');
  console.log('-----|-------|--------|----------|-----------|------|------');
  for (const j of result.judgments) {
    const ev = j.evidence || {};
    const evidence = [
      ev.hasHandwrittenRedCross ? '✗' : '',
      ev.hasHandwrittenRedCheck ? '✓' : '',
      ev.hasHandwrittenRedLetters ? `字母:${ev.redLettersContent||'?'}` : '',
      ev.hasStrikethrough ? '划掉' : ''
    ].filter(Boolean).join(',') || '-';
    
    console.log(`${String(j.questionNumber).padStart(3)} | ${j.isError?'❌':'✅'} | ${(j.confidence||'?').padEnd(6)} | ${(j.studentAnswer||'-').padEnd(8)} | ${(j.correctAnswer||'-').padEnd(9)} | ${(j.teacherIntent||j.reason||'-').slice(0,20).padEnd(20)} | ${evidence}`);
  }

  console.log('');
  console.log('🔍 错题详情:');
  const errors = result.judgments.filter(j => j.isError);
  for (const e of errors) {
    console.log(`  Q${e.questionNumber}: ${e.teacherIntent || e.reason} [${e.confidence}] ${e.needsReview ? '⚠️需复核' : ''}`);
  }

  console.log('');
  console.log('⚠️ 需复核题:');
  const reviewItems = result.judgments.filter(j => j.needsReview);
  for (const r of reviewItems) {
    console.log(`  Q${r.questionNumber}: ${r.reviewReason || '未知原因'} (isError=${r.isError})`);
  }

  // 保存完整结果
  const outPath = path.join(OUTPUT_DIR, 'result.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n📄 完整结果已保存: ${outPath}`);

} catch (err) {
  console.error('❌ 测试失败:', err.message);
  console.error(err.stack);
  process.exit(1);
}
