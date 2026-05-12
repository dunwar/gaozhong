/**
 * Phase 1.1 v4 — 新架构：阶段1只切题 → 阶段2裁切图红笔检测+判错
 * 
 * 核心改变：阶段1不再检测红笔标记，全部题目裁切后由阶段2在小图上判断
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = '/app/data/papers';
const OUTPUT_DIR = join(__dirname, 'output', 'scanner-test-v4');
const KIMI_KEY = process.env.KIMI_API_KEY || '';
if (!KIMI_KEY) { console.error('❌ KIMI_API_KEY not set'); process.exit(1); }

let TOTAL_API_CALLS = 0;
let TOTAL_VL_TIME = 0;

// ═══════════════════ API ═══════════════════

function apiRequest({ hostname, path, apiKey, body, timeout = 300_000 }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ ...body, stream: false });
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(data) },
      timeout
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error(`JSON parse: ${buf.slice(0,300)}`)); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}

function kimiVision(messages, opts = {}) {
  TOTAL_API_CALLS++;
  const start = Date.now();
  return apiRequest({
    hostname: 'dashscope.aliyuncs.com', path: '/compatible-mode/v1/chat/completions',
    apiKey: KIMI_KEY,
    body: { model: 'kimi-k2.6', messages, temperature: opts.temperature ?? 0.3, max_tokens: opts.maxTokens ?? 8000 },
    timeout: opts.timeout ?? 300_000
  }).then(r => { TOTAL_VL_TIME += Date.now() - start; return r; });
}

// ═══════════════════ 工具 ═══════════════════

function imageToBase64(filePath) {
  const buf = readFileSync(filePath);
  return `data:image/${filePath.endsWith('.png')?'png':'jpeg'};base64,${buf.toString('base64')}`;
}

function cropImage(srcPath, bbox, outPath) {
  try {
    execFileSync('convert', [srcPath, '-crop', `${bbox.w}x${bbox.h}+${bbox.x}+${bbox.y}`, '-resize', '640x640>', '-quality', '85', outPath]);
    return true;
  } catch (e) { return false; }
}

function extractJSON(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch {}
  const a = cleaned.match(/\[[\s\S]*\]/);
  if (a) try { return JSON.parse(a[0]); } catch {}
  try { return JSON.parse(cleaned + '"]}'); } catch {}
  try { return JSON.parse(cleaned + ']'); } catch {}
  // Salvage truncated
  const objs = [];
  let depth = 0, start = -1;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (cleaned[i] === '}') { depth--; if (depth === 0 && start >= 0) { objs.push(cleaned.slice(start, i+1)); start = -1; } }
    else if (cleaned[i] === '"' && cleaned[i-1] !== '\\') { let j=i+1; while(j<cleaned.length&&cleaned[j]!=='"'||cleaned[j-1]==='\\')j++; i=j; }
  }
  if (objs.length > 0) {
    const parsed = objs.map(o => { try { return JSON.parse(o); } catch { return null; } }).filter(Boolean);
    if (cleaned.includes('"questions"') || parsed.some(p => p.questionNumber)) return { questions: parsed.filter(p => p.questionNumber) };
  }
  return null;
}

// ═══════════════════ 红笔像素预检 ═══════════════════

function hasRedPixels(cropPath) {
  try {
    // Use ImageMagick to detect red pixels in crop
    // Output: count of pixels in red range
    const result = execFileSync('convert', [
      cropPath,
      '-colorspace', 'HSV',
      '-channel', '0',  // Hue channel
      '-separate',
      '- threshold', '95%',  // Not efficient but quick check
      '-format', '%[fx:mean]',
      'info:'
    ], { timeout: 5000, encoding: 'utf8' });
    // If mean > 0, there are red-ish pixels
    return true; // Simple: always pass through for now, let VL judge
  } catch { return true; }
}

// ═══════════════════ Prompts ═══════════════════

const STAGE1_ONLY_QUESTIONS = `你是高中试卷版面分析专家。分析这张试卷图片，只做一件事：识别每道题的边界。

题目类型：choice(选择题) / fill_blank(填空) / reading(阅读) / dictation(默写) / translation(翻译) / writing(作文)

⚠️ 规则：
1. 识别整页所有题号(如21,22,23...或1,2,3...)，每个题号=一道题
2. 两栏布局要逐栏逐行
3. bbox 上含题号，下含选项区/答案区
4. 不留题号空隙（如从21题开始到45题结束，不要跳到22题中间）
5. 跨页续题（只有选项/答案没有题干的）也要独立成题

⚠️ 注意：这张图里只有题目排版和文字，你的任务不是批改，只是找题目边界。

直接输出纯 JSON（不要 markdown）：
{
  "questions": [
    {"questionNumber": 21, "bbox": {"x": 40, "y": 410, "w": 550, "h": 130}, "questionType": "choice"}
  ]
}`;

const STAGE2_JUDGE_PER_CROP = `你是高中试卷批改阅读专家。分析这道题的裁切图，判断学生做错了吗。

【图片】
从试卷原图裁切出的单道题。你能看到：
- 题目印刷文字 + 选项
- 学生蓝黑笔手写答案
- 教师红笔批改标记（如有）

【判别铁律】
⚠️ 印刷体不是批改！整齐排列的标准字体字母(A/B/C/D)是印刷答案键，不是教师批改 → 忽略
⚠️ 教师红笔一定是手写体，笔迹不规则、位置在题目内部或紧贴边缘
⚠️ 整卷批改风格要么全用✓✗，要么全用红笔写正确答案，二选一

【判定规则 — 按优先级】
1. 红笔 ✗ 打叉 → ❌ 错题
2. 红笔划掉学生答案+写了新答案 → ❌ 错题，新答案是正确答案
3. 红笔写了答案字母(手写体)且不同于学生手写选项 → ❌ 错题
4. 红笔扣分标记(-2/-0.5) → ❌ 错题
5. 红笔 ✓ 打勾 → ✅ 对
6. 红笔只圈出/下划线/注释(无打叉无改答案) → ✅ 对
7. 无任何红笔标记 → ✅ 对
8. 不确定红笔意图 → ✅ 对（保守）

对于错题，输出：
{"qi": 题号, "isError": true, "studentAnswer": "学生答", "correctAnswer": "红笔正确解", "teacherIntent": "红笔判定依据一句话", "confidence": "high/medium/low"}

对于对题，输出：
{"qi": 题号, "isError": false, "reason": "理由"}`;

const STAGE2_BATCH_PROMPT = `你是高中试卷批改阅读专家。分析以下多道题的裁切图（每题一张图），逐一判断对错。

【判别铁律】
⚠️ 印刷体≠批改！整齐排列的字母列(A/B/C/D)是印刷答案键 → 忽略
⚠️ 红笔一定是手写体，笔迹不规则，位置在题目内部
⚠️ 批改风格二选一：全用✓✗ 或 全用红笔写正确答案

【判定规则】
1. 红笔 ✗ → ❌ 2. 划掉+新答案→❌ 3. 红笔手写答案≠学生选→❌
4. 扣分→❌ 5. 红笔 ✓→✅ 6. 圈出/下划线/注释→✅ 7. 无红笔→✅
⚠️ 不确定→✅

输出纯JSON数组（不要markdown）：
[
  {"qi": 21, "isError": true, "studentAnswer": "B", "correctAnswer": "D", "teacherIntent": "红笔划掉B写D", "confidence": "high"},
  {"qi": 22, "isError": false, "reason": "无红笔标记"}
]`;

// ═══════════════════ Step 1: 只切题 ═══════════════════

async function stage1_detectQuestions(originalPath) {
  console.log('\n' + '═'.repeat(60));
  console.log('📸 Step 1 — 版面分析：只识别题目区域（不检测红笔）');
  console.log('═'.repeat(60));
  
  const b64 = imageToBase64(originalPath);
  console.log(`  图片: ${(readFileSync(originalPath).length/1024).toFixed(1)}KB`);
  console.log('  🤖 调用 VL...');
  
  const result = await kimiVision([
    { role: 'system', content: '只输出纯JSON，不要markdown，不要解释。' },
    { role: 'user', content: [{ type: 'text', text: STAGE1_ONLY_QUESTIONS }, { type: 'image_url', image_url: { url: b64, detail: 'auto' } }] }
  ], { maxTokens: 8000, temperature: 0.2 });
  
  const rawContent = result.choices?.[0]?.message?.content || '';
  const parsed = extractJSON(rawContent);
  
  if (!parsed || !parsed.questions || parsed.questions.length === 0) {
    console.error('  ❌ 未识别到题目！原始:', rawContent.slice(0, 500));
    return null;
  }
  
  const questions = parsed.questions;
  console.log(`  📝 响应: ${rawContent.length} 字符`);
  console.log(`  📋 题目区域: ${questions.length} 个`);
  
  const qTypes = {};
  for (const q of questions) {
    qTypes[q.questionType] = (qTypes[q.questionType] || 0) + 1;
    console.log(`     Q${String(q.questionNumber).padStart(2)} ${(q.questionType||'').padEnd(12)} @(${q.bbox.x},${q.bbox.y}) ${q.bbox.w}x${q.bbox.h}`);
  }
  console.log(`  题型分布:`, qTypes);
  
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, 'stage1-raw.json'), JSON.stringify({ raw: rawContent, parsed }, null, 2));
  
  return { questions };
}

// ═══════════════════ Step 2: 裁切 + 判错 ═══════════════════

function stage2_cropAll(originalPath, questions) {
  console.log('\n' + '═'.repeat(60));
  console.log('✂️  Step 2a — 裁切所有题目');
  console.log('═'.repeat(60));
  
  const cropDir = join(OUTPUT_DIR, 'crops');
  mkdirSync(cropDir, { recursive: true });
  
  const crops = [];
  let failed = 0;
  
  for (const q of questions) {
    const outPath = join(cropDir, `q${q.questionNumber}.jpg`);
    const ok = cropImage(originalPath, q.bbox, outPath);
    if (ok) {
      crops.push({ questionNumber: q.questionNumber, questionType: q.questionType, cropPath: outPath });
    } else {
      failed++;
    }
  }
  
  console.log(`  ✅ ${crops.length} 题裁切成功 | ❌ ${failed} 失败`);
  return crops;
}

async function stage2_judgeBatch(crops) {
  console.log('\n' + '═'.repeat(60));
  console.log('🔍 Step 2b — 批处理：裁切图红笔检测+判错');
  console.log('═'.repeat(60));
  
  if (crops.length === 0) return [];
  
  const BATCH_SIZE = 8;
  const allResults = [];
  
  for (let i = 0; i < crops.length; i += BATCH_SIZE) {
    const batch = crops.slice(i, i + BATCH_SIZE);
    const qids = batch.map(c => c.questionNumber);
    console.log(`\n  📦 批次 ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(crops.length/BATCH_SIZE)}: Q${qids.join(', Q')} (${batch.length}题)`);
    
    const content = [
      { type: 'text', text: `${STAGE2_BATCH_PROMPT}\n\n题号: ${batch.map((c,j) => `图${j+1}=Q${c.questionNumber}`).join(', ')}。qi用实际题号。` }
    ];
    for (const c of batch) {
      content.push({ type: 'image_url', image_url: { url: imageToBase64(c.cropPath), detail: 'auto' } });
    }
    
    try {
      const result = await kimiVision([
        { role: 'system', content: '只输出纯JSON数组，不要markdown，不要解释。' },
        { role: 'user', content }
      ], { maxTokens: batch.length * 800, temperature: 0.2 });
      
      const contentStr = result.choices?.[0]?.message?.content || '';
      const parsed = extractJSON(contentStr);
      
      if (Array.isArray(parsed)) {
        for (const r of parsed) {
          const qn = String(r.qi || r.questionNumber || '').replace('Q', '');
          allResults.push({
            questionNumber: parseInt(qn) || 0,
            isError: r.isError || false,
            studentAnswer: r.studentAnswer || '',
            correctAnswer: r.correctAnswer || '',
            teacherIntent: r.teacherIntent || r.reason || '',
            confidence: r.confidence || 'medium'
          });
          
          const icon = r.isError ? '❌' : '✅';
          const detail = r.isError
            ? `${r.studentAnswer||'-'}→${r.correctAnswer||'-'} | ${r.teacherIntent||''} | 置信:${r.confidence||'?'}`
            : r.reason || '';
          console.log(`     ${icon} Q${qn} ${detail}`);
        }
      } else {
        console.error('     ⚠️  JSON 解析失败，逐题fallback');
        for (const c of batch) {
          try {
            const r2 = await kimiVision([
              { role: 'system', content: '只输出单个JSON对象。' },
              { role: 'user', content: [{ type: 'text', text: STAGE2_JUDGE_PER_CROP }, { type: 'image_url', image_url: { url: imageToBase64(c.cropPath), detail: 'auto' } }] }
            ], { maxTokens: 2000, temperature: 0.2 });
            const p = extractJSON(r2.choices?.[0]?.message?.content || '');
            if (p) {
              allResults.push({ questionNumber: c.questionNumber, isError: p.isError||false, studentAnswer: p.studentAnswer||'', correctAnswer: p.correctAnswer||'', teacherIntent: p.teacherIntent||p.reason||'', confidence: p.confidence||'low', _fallback: true });
              console.log(`     ${p.isError?'❌':'✅'} Q${c.questionNumber} (fallback) ${p.teacherIntent||p.reason||''}`);
            }
          } catch (e) {
            allResults.push({ questionNumber: c.questionNumber, isError: false, reason: 'parse error' });
          }
        }
      }
    } catch (e) {
      console.error(`     ❌ 批次失败: ${e.message}`);
      for (const c of batch) allResults.push({ questionNumber: c.questionNumber, isError: false, reason: 'batch error' });
    }
  }
  
  return allResults;
}

// ═══════════════════ 置信度评估 ═══════════════════

function assessConfidence(results) {
  for (const r of results) {
    if (r.isError) {
      // VL mark is low confidence or fallback → flag
      if (r._fallback) {
        r.needsReview = true;
        r.reviewReason = 'VL 批次解析失败，逐题降级调用';
      } else if (r.confidence === 'low') {
        r.needsReview = true;
        r.reviewReason = 'VL 模型自身低置信';
      } else if (r.confidence === 'medium') {
        r.needsReview = true;
        r.reviewReason = '建议人工复核确认';
      } else {
        r.needsReview = false;
      }
    }
  }
  return results;
}

// ═══════════════════ 主流程 ═══════════════════

async function main() {
  const sessionId = process.argv[2];
  const pageIndex = parseInt(process.argv[3]) || 1;
  
  if (!sessionId) {
    console.log('用法: node test-scanner-v4.mjs <sessionId> [pageIndex]');
    process.exit(1);
  }
  
  const originalPath = join(SESSION_DIR, sessionId, `page_${pageIndex}.jpg`);
  if (!existsSync(originalPath)) { console.error(`❌ 原图不存在: ${originalPath}`); process.exit(1); }
  
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   v4 Scanner — 阶段1只切题 + 阶段2裁切判错     ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`Session: ${sessionId} | Page: ${pageIndex}`);
  
  const totalStart = Date.now();
  
  // Step 1 — 只切题
  const stage1 = await stage1_detectQuestions(originalPath);
  if (!stage1) { console.error('❌ 阶段1失败'); process.exit(1); }
  
  // Step 2 — 裁切所有题
  const crops = stage2_cropAll(originalPath, stage1.questions);
  
  // Step 3 — 批处理判错
  const judgments = await stage2_judgeBatch(crops);
  
  // 置信度评估
  const assessed = assessConfidence(judgments);
  
  const totalTime = ((Date.now() - totalStart) / 1000).toFixed(1);
  
  // ═══════════ 汇总 ═══════════
  console.log('\n' + '═'.repeat(60));
  console.log('📊 汇总报告');
  console.log('═'.repeat(60));
  
  const errorCount = assessed.filter(j => j.isError).length;
  const reviewCount = assessed.filter(j => j.needsReview).length;
  
  console.log(`  总题数: ${stage1.questions.length} | 裁切: ${crops.length}`);
  console.log(`  判错: ${errorCount} | 需复核: ${reviewCount}`);
  console.log(`  API 调用: ${TOTAL_API_CALLS} 次 | 总耗时: ${totalTime}s`);
  
  assessed.sort((a,b) => (a.questionNumber||0) - (b.questionNumber||0));
  
  console.log('\n  📋 逐题判定:');
  for (const j of assessed) {
    const icon = j.isError ? '❌' : '✅';
    const review = j.needsReview ? ' 🔍需复核' : '';
    const detail = j.isError
      ? `${j.studentAnswer||'-'}→${j.correctAnswer||'-'} | ${j.teacherIntent||''}`
      : (j.reason || '');
    console.log(`     ${icon} Q${String(j.questionNumber).padStart(2)} ${detail}${review}`);
  }
  
  // 保存报告
  writeFileSync(join(OUTPUT_DIR, 'report.json'), JSON.stringify({
    sessionId, pageIndex, totalTime, apiCalls: TOTAL_API_CALLS,
    totalQuestions: stage1.questions.length, errorCount, reviewCount,
    judgments: assessed.map(j => ({ qn: j.questionNumber, isError: j.isError, studentAnswer: j.studentAnswer, correctAnswer: j.correctAnswer, reason: j.teacherIntent||j.reason, confidence: j.confidence, needsReview: j.needsReview }))
  }, null, 2));
  
  console.log(`\n  📁 报告: ${join(OUTPUT_DIR, 'report.json')}`);
  console.log(`  🖼️  裁切图: ${join(OUTPUT_DIR, 'crops/')}`);
}

main().catch(e => { console.error('💥', e); process.exit(1); });
