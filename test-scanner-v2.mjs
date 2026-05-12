/**
 * Phase 1.1 v2 — 单原图三阶段测试（去掉红笔分离图）
 * 
 * 用法: cd gaozhong.online && node test-scanner-v2.mjs <sessionId> [pageIndex]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = '/app/data/papers';
const OUTPUT_DIR = join(__dirname, 'output', 'scanner-test-v3');
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
  // Try {...} match
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch {}
  // Try [...] match
  const a = cleaned.match(/\[[\s\S]*\]/);
  if (a) try { return JSON.parse(a[0]); } catch {}
  // Last resort: try to close truncated JSON
  try { return JSON.parse(cleaned + '"]}'); } catch {}
  try { return JSON.parse(cleaned + ']'); } catch {}
  // Salvage: extract completed items from truncated array
  const salvaged = salvageTruncated(cleaned);
  if (salvaged) return salvaged;
  return null;
}

function salvageTruncated(text) {
  // For truncated redMarks/questions: find all complete {...} objects
  const objects = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (text[i] === '}') { depth--; if (depth === 0 && start >= 0) { objects.push(text.slice(start, i+1)); start = -1; } }
    else if (text[i] === '"' && text[i-1] !== '\\') { /* skip strings */ let j=i+1; while(j<text.length&&text[j]!=='"'||text[j-1]==='\\')j++; i=j; }
  }
  // Try to determine if we're in redMarks or questions
  const parsed = [];
  for (const obj of objects) {
    try { parsed.push(JSON.parse(obj)); } catch {}
  }
  if (text.includes('"redMarks"') && text.includes('"questions"')) {
    const rmIdx = text.indexOf('"redMarks"');
    const qIdx = text.indexOf('"questions"');
    if (rmIdx < qIdx) {
      // redMarks come first
      return { redMarks: parsed.filter(o => o.markId), questions: parsed.filter(o => o.questionNumber) };
    }
  }
  return null;
}

// ═══════════════════ Prompts ═══════════════════

const STAGE1_PROMPT = `你是高中试卷分析专家。分析这张已批改的试卷图片，完成两个任务。

【任务A — 红笔批改标记检测】
找出图中所有教师手写红笔批改标记，逐一输出坐标、类型和内容。

标记类型：
- "cross"              — ✗ 红色手写打叉（两条交叉斜线）
- "check"              — ✓ 红色手写打勾
- "correct_answer"     — 红色手写的答案字母/单词/数字（通常写在题号旁或原答案旁边）
- "strikethrough"      — 红色横线/斜线划掉学生文字
- "underline"          — 红色下划线/波浪线
- "circle"             — 红色圆圈围绕
- "annotation"         — 红色手写汉字注释
- "score_deduction"    — 扣分标记（如 "-2", "-0.5"）

⚠️ 三条铁律：
1. 印刷体不是批改！试卷边缘整齐排列的字母列(A/B/C/D)是印刷答案键，笔迹规整、间距均匀 → 不是红笔批改，忽略
2. 批改标记一定在题目附近（题目区域上下左右5mm内）。远离题目的红色痕迹不是批改
3. 教师批改习惯：整卷要么全用✓✗判对错、要么全用红笔写正确答案，二选一。同一题同时有✓✗和correct_answer时 → 以✓✗为准，correct_answer仅作为补充信息

对于 correct_answer/annotation/score_deduction 类型，content字段写出红笔文字。
蓝黑笔迹是学生答案，不是批改。

【任务B — 题目区域识别】
识别每道题的语义边界。

题目类型：choice / fill_blank / reading / dictation / translation / writing

⚠️ 默写/填空密集布局：每行 = 序号 + 手写答案，每行 = 独立题目
⚠️ 两栏/三栏布局 → 逐栏逐行
⚠️ bbox 上含题号，下含答案区+批改区，但不包含试卷边缘的印刷答案键列

直接输出纯 JSON（不要 markdown）：
{
  "redMarks": [
    {"markId": 1, "type": "cross", "bbox": {"x": 200, "y": 520, "w": 30, "h": 30}, "content": ""},
    {"markId": 2, "type": "correct_answer", "bbox": {"x": 220, "y": 480, "w": 25, "h": 25}, "content": "C"}
  ],
  "questions": [
    {"questionNumber": 21, "bbox": {"x": 40, "y": 410, "w": 550, "h": 130}, "questionType": "choice"}
  ]
}`;

const STAGE2_PROMPT = `你是高中错题整理助手。你的唯一任务是：阅读教师已有的红笔批改标记，判断这道题学生做错了还是做对了。

【你的角色】
你**不做批改**。教师/同学已经完成了批改。你只需「阅读」标记还原结论。

【图片说明】
这是从试卷原图裁切出的单道题区域。你能看到：
- 题目印刷文字 + 选项（如有）
- 学生蓝黑笔作答
- 教师红笔批改标记

【判别铁律】
1. 印刷体不是答案！裁切图边缘整齐排列的字母列(A/B/C/D)是印刷答案键，不是教师批改 → 忽略
2. 批改标记在题目区域内或紧邻（上下左右5mm内）才算本题的批改
3. 同一题同时有✓✗和correct_answer → 以✓✗为准判定对错

【判定规则 — 按优先级】
1. 红笔 ✗ 打叉 → ❌ 错题
2. 红笔划掉+写了新答案 → ❌ 错题，新答案是正确答案
3. 红笔只写答案（没打叉没划掉）→ 对比学生答案，不同则❌
4. 红笔扣分标记 → ❌ 错题
5. 红笔 ✓ 打勾 → ✅ 对
6. 红笔只圈出/下划线/注释 → ✅ 对
7. 无任何红笔标记 → ✅ 对

⚠️ 保守原则：不确定红笔意图 → 按"做对"处理

直接输出单个 JSON 对象：
{
  "questionNumber": 21,
  "isError": true,
  "studentAnswer": "B",
  "correctAnswer": "D",
  "teacherIntent": "红笔在题号旁写D，学生选了B → 错",
  "errorType": "语法/词汇/逻辑/概念/未知",
  "confidence": "high"
}

做对时: {"questionNumber": 21, "isError": false, "reason": "红笔打勾"}`;

// 批处理版本 — 一次送多道题
const STAGE2_BATCH_PROMPT = `你是高中错题整理助手。你的任务：阅读教师已有的批改标记，判断每道题对错。

你会收到多道题的裁切图（每题一张图）。请逐一判断，输出 JSON 数组。

【判别铁律】
1. 印刷体不是答案！裁切图边缘整齐排列的字母列(A/B/C/D)是印刷答案键 → 忽略，不是教师批改
2. 批改标记一定在题目区域内或紧邻。远离题目的红色痕迹不是本题批改
3. ✓✗和correct_answer同时存在 → 以✓✗为准

【判定规则 — 按优先级】
1. 红笔 ✗ 打叉 → ❌ 错题
2. 红笔划掉+写了新答案 → ❌ 错题，新答案=正确答案
3. 红笔只写答案(无打叉) → 对比学生答案，不同则❌
4. 红笔扣分 → ❌ 错
5. 红笔 ✓ 打勾 → ✅ 对
6. 红笔只圈出/下划线/注释 → ✅ 对
7. 无红笔 → ✅ 对
⚠️ 不确定 → 按做对处理

直接输出纯 JSON 数组（不要 markdown）：
[
  {"qi": 1, "isError": true, "studentAnswer": "B", "correctAnswer": "D", "teacherIntent": "红笔写D", "confidence": "high"},
  {"qi": 2, "isError": false, "reason": "红笔打勾"},
  ...
]`;

// ═══════════════════ Step 1 ═══════════════════

async function stage1_detect(originalPath) {
  console.log('\n' + '═'.repeat(60));
  console.log('📸 Step 1 — 原图 VL：红笔标记 + 题目区域（单图）');
  console.log('═'.repeat(60));
  
  const b64 = imageToBase64(originalPath);
  console.log(`  图片: ${originalPath} (${(readFileSync(originalPath).length/1024).toFixed(1)}KB)`);
  console.log('  🤖 调用 Kimi VL...');
  
  const result = await kimiVision([
    { role: 'system', content: '只输出纯JSON，不要markdown代码块，不要解释。' },
    { role: 'user', content: [{ type: 'text', text: STAGE1_PROMPT }, { type: 'image_url', image_url: { url: b64, detail: 'auto' } }] }
  ], { maxTokens: 16000, temperature: 0.3 });
  
  const elapsed = ((Date.now() - TOTAL_API_CALLS * 0 + Date.now() - (Date.now() - 100))).toFixed(1); // approximate
  const rawContent = result.choices?.[0]?.message?.content || '';
  const parsed = extractJSON(rawContent);
  
  if (!parsed) {
    console.error('  ❌ JSON 解析失败！原始内容:', rawContent.slice(0, 500));
    return null;
  }
  
  const redMarks = parsed.redMarks || [];
  const questions = parsed.questions || [];
  
  console.log(`  ⏱️  第${TOTAL_API_CALLS}次调用`);
  console.log(`  📝 响应: ${rawContent.length} 字符`);
  console.log(`\n  🔴 红笔标记: ${redMarks.length} 个`);
  
  const typeCount = {};
  for (const m of redMarks) {
    typeCount[m.type] = (typeCount[m.type] || 0) + 1;
    const icon = {cross:'✗',check:'✓',correct_answer:'✎',strikethrough:'⌫',underline:'_',circle:'○',annotation:'💬',score_deduction:'-分'}[m.type]||'?';
    console.log(`     ${icon} #${m.markId} ${m.type.padEnd(16)} @(${m.bbox.x},${m.bbox.y}) ${m.bbox.w}x${m.bbox.h} ${m.content ? '"'+m.content+'"' : ''}`);
  }
  console.log(`     类型分布:`, typeCount);
  
  console.log(`\n  📋 题目区域: ${questions.length} 个`);
  const qTypes = {};
  for (const q of questions) {
    qTypes[q.questionType] = (qTypes[q.questionType] || 0) + 1;
  }
  console.log(`     题型分布:`, qTypes);
  
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, 'stage1-raw.json'), JSON.stringify({ raw: rawContent, parsed }, null, 2));
  
  return { redMarks, questions };
}

// ═══════════════════ Step 2: 裁切 + 关联 ═══════════════════

function stage2_cropAndAssociate(originalPath, stage1Result) {
  console.log('\n' + '═'.repeat(60));
  console.log('✂️  Step 2 — 原图裁切 + 红笔关联');
  console.log('═'.repeat(60));
  
  const { redMarks, questions } = stage1Result;
  const cropDir = join(OUTPUT_DIR, 'crops');
  mkdirSync(cropDir, { recursive: true });
  
  // 关联红笔到题目
  const questionMarks = new Map();
  for (const q of questions) {
    const associated = [];
    const qBox = q.bbox;
    const expandX = qBox.w * 0.1;
    const expandY = qBox.h * 0.1;
    for (const rm of redMarks) {
      const cx = rm.bbox.x + rm.bbox.w / 2;
      const cy = rm.bbox.y + rm.bbox.h / 2;
      if (cx >= qBox.x - expandX && cx <= qBox.x + qBox.w + expandX && cy >= qBox.y - expandY && cy <= qBox.y + qBox.h + expandY) {
        associated.push(rm);
      }
    }
    questionMarks.set(q.questionNumber, associated);
  }
  
  // 分三类题
  const cropsWithMarks = [];   // 有红笔 → 需VL判
  const cropsNoMarks = [];     // 无红笔 → 自动判对
  const cropsFailed = [];      // 裁切失败
  
  let skipCount = 0;
  
  for (const q of questions) {
    const qMarks = questionMarks.get(q.questionNumber) || [];
    const b = q.bbox;
    const outPath = join(cropDir, `q${q.questionNumber}.jpg`);
    const ok = cropImage(originalPath, b, outPath);
    
    if (!ok) {
      cropsFailed.push({ questionNumber: q.questionNumber, reason: 'crop failed' });
      continue;
    }
    
    if (qMarks.length === 0) {
      skipCount++;
      cropsNoMarks.push({ questionNumber: q.questionNumber, questionType: q.questionType });
    } else {
      const markSummary = qMarks.map(m => `${m.type}${m.content?':'+m.content:''}`).join(', ');
      cropsWithMarks.push({
        questionNumber: q.questionNumber,
        questionType: q.questionType,
        marks: qMarks,
        cropPath: outPath,
        markSummary
      });
    }
  }
  
  console.log(`  ✅ 有红笔需判: ${cropsWithMarks.length} 题`);
  console.log(`  ⏭️  无红笔跳过: ${skipCount} 题 → 自动判对`);
  console.log(`  ❌ 裁切失败: ${cropsFailed.length} 题`);
  
  for (const c of cropsWithMarks) {
    console.log(`     Q${String(c.questionNumber).padStart(2)} [${c.markSummary}]`);
  }
  
  // 未关联红笔
  const associatedIds = new Set();
  for (const [, marks] of questionMarks) for (const m of marks) associatedIds.add(m.markId);
  const unassociated = redMarks.filter(m => !associatedIds.has(m.markId));
  if (unassociated.length > 0) {
    console.log(`\n  ⚠️  ${unassociated.length} 个标记未关联`);
    for (const m of unassociated) console.log(`     #${m.markId} ${m.type} @(${m.bbox.x},${m.bbox.y})`);
  }
  
  return { cropsWithMarks, cropsNoMarks, cropsFailed, unassociated };
}

// ═══════════════════ Step 3: 批处理判错 ═══════════════════

async function stage3_judgeBatch(cropsWithMarks) {
  console.log('\n' + '═'.repeat(60));
  console.log('🔍 Step 3 — 批处理判错（有红笔的题才调 VL）');
  console.log('═'.repeat(60));
  
  if (cropsWithMarks.length === 0) {
    console.log('  无需 VL 调用（全部无红笔）');
    return [];
  }
  
  const BATCH_SIZE = 8;
  const allResults = [];
  
  for (let i = 0; i < cropsWithMarks.length; i += BATCH_SIZE) {
    const batch = cropsWithMarks.slice(i, i + BATCH_SIZE);
    const qids = batch.map(c => c.questionNumber);
    console.log(`\n  📦 批次 ${Math.floor(i/BATCH_SIZE)+1}: Q${qids.join(', Q')} (${batch.length} 题)`);
    
    // 构建多图消息
    const content = [
      { type: 'text', text: `${STAGE2_BATCH_PROMPT}\n\n题号映射: ${batch.map((c,j) => `第${j+1}张图 = Q${c.questionNumber}`).join(', ')}。注意: qi 字段用实际题号，不是图片序号。` }
    ];
    for (const c of batch) {
      content.push({ type: 'image_url', image_url: { url: imageToBase64(c.cropPath), detail: 'auto' } });
    }
    
    try {
      const result = await kimiVision([
        { role: 'system', content: '只输出纯JSON数组，不要markdown，不要解释。' },
        { role: 'user', content }
      ], { maxTokens: batch.length * 600, temperature: 0.2 });
      
      const contentStr = result.choices?.[0]?.message?.content || '';
      const parsed = extractJSON(contentStr);
      
      if (Array.isArray(parsed)) {
        for (const r of parsed) {
          // qi 可能是字符串或数字
          const qn = String(r.qi || r.questionNumber || '').replace('Q', '');
          const crop = batch.find(c => String(c.questionNumber) === qn);
          allResults.push({
            questionNumber: parseInt(qn) || 0,
            isError: r.isError || false,
            studentAnswer: r.studentAnswer || '',
            correctAnswer: r.correctAnswer || '',
            teacherIntent: r.teacherIntent || r.reason || '',
            confidence: r.confidence || 'medium',
            markTypes: crop?.marks.map(m => m.type) || []
          });
          
          const icon = r.isError ? '❌' : '✅';
          const detail = r.isError
            ? `${r.studentAnswer||'-'}→${r.correctAnswer||'-'} | ${r.teacherIntent||''}`
            : r.reason || '';
          console.log(`     ${icon} Q${qn} ${detail}`);
        }
      } else {
        console.error(`     ⚠️  JSON 解析失败，回退逐题调用`);
        // Fallback: 逐题
        for (const c of batch) {
          try {
            const r2 = await kimiVision([
              { role: 'system', content: '只输出单个JSON对象。' },
              { role: 'user', content: [{ type: 'text', text: STAGE2_PROMPT }, { type: 'image_url', image_url: { url: imageToBase64(c.cropPath), detail: 'auto' } }] }
            ], { maxTokens: 2000, temperature: 0.2 });
            const p = extractJSON(r2.choices?.[0]?.message?.content || '');
            if (p) {
              allResults.push({ questionNumber: c.questionNumber, ...p });
              console.log(`     ${p.isError?'❌':'✅'} Q${c.questionNumber} (fallback) ${p.teacherIntent||p.reason||''}`);
            }
          } catch (e) {
            allResults.push({ questionNumber: c.questionNumber, isError: false, reason: 'parse error' });
          }
        }
      }
    } catch (e) {
      console.error(`     ❌ 批次失败: ${e.message}`);
      for (const c of batch) {
        allResults.push({ questionNumber: c.questionNumber, isError: false, reason: 'batch error' });
      }
    }
  }
  
  return allResults;
}

// ═══════════════════ 主流程 ═══════════════════

async function main() {
  const sessionId = process.argv[2];
  const pageIndex = parseInt(process.argv[3]) || 1;
  
  if (!sessionId) {
    console.log('用法: node test-scanner-v2.mjs <sessionId> [pageIndex]');
    console.log('示例: node test-scanner-v2.mjs fbc20049 1  (yingyu34)');
    process.exit(1);
  }
  
  const originalPath = join(SESSION_DIR, sessionId, `page_${pageIndex}.jpg`);
  if (!existsSync(originalPath)) { console.error(`❌ 原图不存在: ${originalPath}`); process.exit(1); }
  
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   v2 Scanner 测试 — 单原图三阶段（无红笔分离）  ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`Session: ${sessionId} | Page: ${pageIndex}`);
  console.log(`原图: ${originalPath}`);
  
  const totalStart = Date.now();
  
  // Step 1
  const stage1 = await stage1_detect(originalPath);
  if (!stage1) { console.error('❌ 阶段1失败'); process.exit(1); }
  
  // Step 2
  const { cropsWithMarks, cropsNoMarks, cropsFailed, unassociated } = stage2_cropAndAssociate(originalPath, stage1);
  
  // Step 3 — 批处理
  const judgments = await stage3_judgeBatch(cropsWithMarks);
  
  // 加上无红笔的（自动判对）
  for (const c of cropsNoMarks) {
    judgments.push({ questionNumber: c.questionNumber, isError: false, reason: '无红笔标记', confidence: 'high', autoSkipped: true });
  }
  for (const c of cropsFailed) {
    judgments.push({ questionNumber: c.questionNumber, isError: false, reason: '裁切失败', confidence: 'low', autoSkipped: true });
  }
  
  const totalTime = ((Date.now() - totalStart) / 1000).toFixed(1);
  
  // ═══════════ 汇总 ═══════════
  console.log('\n' + '═'.repeat(60));
  console.log('📊 汇总报告');
  console.log('═'.repeat(60));
  
  const errorCount = judgments.filter(j => j.isError).length;
  const autoSkipped = judgments.filter(j => j.autoSkipped).length;
  
  console.log(`  总题数: ${stage1.questions.length}`);
  console.log(`  红笔标记: ${stage1.redMarks.length} | 未关联: ${unassociated.length}`);
  console.log(`  裁切: ${cropsWithMarks.length+cropsNoMarks.length} ✅ | ${cropsFailed.length} ❌`);
  console.log(`  判错题数: ${errorCount}`);
  console.log(`  自动跳过: ${autoSkipped} (无红笔或裁切失败)`);
  console.log(`  API 调用: ${TOTAL_API_CALLS} 次`);
  console.log(`  总耗时: ${totalTime}s`);
  
  // 置信度分布
  const confDist = {};
  for (const j of judgments) if (j.isError) confDist[j.confidence||'unknown'] = (confDist[j.confidence||'unknown']||0) + 1;
  if (Object.keys(confDist).length > 0) {
    console.log(`  错题置信度:`, confDist);
  }
  
  // 完整判定
  judgments.sort((a,b) => (a.questionNumber||0) - (b.questionNumber||0));
  console.log('\n  📋 逐题判定:');
  for (const j of judgments) {
    const icon = j.autoSkipped ? '⏭️' : (j.isError ? '❌' : '✅');
    const detail = j.isError
      ? `${j.studentAnswer||'-'}→${j.correctAnswer||'-'} | ${j.teacherIntent||''}`
      : (j.reason || '');
    console.log(`     ${icon} Q${String(j.questionNumber).padStart(2)} ${detail}`);
  }
  
  // 保存完整报告
  const report = {
    sessionId, pageIndex, totalTime,
    apiCalls: TOTAL_API_CALLS, vlTime: TOTAL_VL_TIME,
    stage1: { redMarks: stage1.redMarks.length, questions: stage1.questions.length },
    stage2: { cropsWithMarks: cropsWithMarks.length, cropsNoMarks: cropsNoMarks.length },
    stage3: { total: judgments.length, errors: errorCount, autoSkipped },
    judgments: judgments.map(j => ({ qn: j.questionNumber, isError: j.isError, studentAnswer: j.studentAnswer, correctAnswer: j.correctAnswer, reason: j.teacherIntent || j.reason, confidence: j.confidence }))
  };
  writeFileSync(join(OUTPUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n  📁 完整报告: ${join(OUTPUT_DIR, 'report.json')}`);
}

main().catch(e => { console.error('💥', e); process.exit(1); });
