#!/usr/bin/env node
// 生成错题示例卷快照 (demo/landa/) — 用于免登录 5 分钟示例体验
// 数据源: eval/results/landa-20260831-v10/scan_output.json (真实管线扫描结果, 非编造)
// 用法: node scripts/build-demo-snapshot.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'eval', 'results', 'landa-20260831-v10');
const PAGES_DIR = 'E:/zdh/公众号运营/公众号助手/gaozhong/错题/英语澜大训练1';
const OUT_DIR = path.join(ROOT, 'demo', 'landa');

const scan = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'scan_output.json'), 'utf-8'));

// —— 与 api-server executePaperTask 的 allErrors 适配格式一致 ——
const errors = (scan.errors || []).map(q => ({
  pageIndex: q.pageIndex,
  questionNumber: q.questionNumber,
  questionType: q.questionType || '',
  questionText: q.questionText || '',
  options: q.options || {},
  studentAnswer: q.studentAnswer || '',
  correctAnswer: q.correctAnswer || '',
  passageText: q.passageText || '',
  bbox: q.bbox || null,
  redAnswer: q.redAnswer || '',
  errorSource: q.errorSource || '',
  confidence: q.confidence || 'high',
  errorType: '未知',
  redRatio: q.redRatio
}));

const allQuestionsFlat = [];
for (const pr of (scan.pageResults || [])) {
  for (const q of pr.questions) {
    allQuestionsFlat.push({
      questionNumber: q.questionNumber,
      questionText: q.questionText || '',
      questionType: q.questionType || 'choice',
      options: q.options || {},
      pageIndex: pr.pageIndex,
      isError: q.isError || false,
      centroidCount: q.centroidCount || 0,
      redEnergy: q.redEnergy || 0
    });
  }
}

const snapshot = {
  _comment: '示例卷快照: 英语澜大训练1, 真实管线扫描结果(v10, scanner v5.3+L2v2), 用于免登录示例体验. 重新生成: node scripts/build-demo-snapshot.mjs',
  subject: '英语',
  title: '示例卷 · 高一英语训练卷',
  totalQuestions: scan.totalQuestions,
  totalErrors: errors.length,
  lowQualityPages: scan.lowQualityPages || [],
  errors,
  allQuestionsFlat
};

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.join(OUT_DIR, 'crops'), { recursive: true });

// 原图 → page_N.jpg (按页序)
const srcPages = fs.readdirSync(PAGES_DIR).filter(f => /\.(jpe?g|png)$/i.test(f)).sort();
srcPages.forEach((f, i) => {
  fs.copyFileSync(path.join(PAGES_DIR, f), path.join(OUT_DIR, `page_${i + 1}.jpg`));
});

// 裁剪图 (确认页 region URL 用)
let cropCount = 0;
for (const f of fs.readdirSync(SRC_DIR)) {
  if (/^p\d+_q\d+\.jpe?g$/i.test(f)) {
    fs.copyFileSync(path.join(SRC_DIR, f), path.join(OUT_DIR, 'crops', f));
    cropCount++;
  }
}

fs.writeFileSync(path.join(OUT_DIR, 'snapshot.json'), JSON.stringify(snapshot, null, 1), 'utf-8');
console.log(`✅ demo/landa/ 生成完成: ${srcPages.length} 页原图, ${cropCount} 张裁剪图, ${errors.length}/${allQuestionsFlat.length} 疑似错题/总题`);
