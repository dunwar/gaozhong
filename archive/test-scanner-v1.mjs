/**
 * Phase 1.1 — v1.0 Scanner 独立测试
 * 
 * 用法: cd gaozhong.online && node test-scanner-v1.mjs <sessionId> [pageIndex]
 * 示例: node test-scanner-v1.mjs 970cee90 1
 * 
 * 分三步验证:
 *   Step 1: 阶段1 VL → 红笔标记检测 + 题目区域识别
 *   Step 2: ImageMagick 裁切 → 逐题双图输出
 *   Step 3: 阶段2 VL → 逐题判错
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ═══════════════════════════════════════
// 配置
// ═══════════════════════════════════════

const SESSION_DIR = '/app/data/papers';
const OUTPUT_DIR = join(__dirname, 'output', 'scanner-test');
const KIMI_KEY = process.env.KIMI_API_KEY || '';
const MODEL_OCR = process.env.MODEL_OCR || 'kimi-k2.6';

if (!KIMI_KEY) {
  console.error('❌ KIMI_API_KEY not set. 请设置环境变量后重试。');
  process.exit(1);
}

// ═══════════════════════════════════════
// Kimi API 请求 (同 api-server.js 逻辑)
// ═══════════════════════════════════════

function apiRequest({ hostname, path, apiKey, body, timeout = 300_000 }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ ...body, stream: false });
    const req = https.request({
      hostname, path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(data)
      },
      timeout
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error(`JSON parse: ${buf.slice(0, 300)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function kimiVision(messages, opts = {}) {
  return apiRequest({
    hostname: 'dashscope.aliyuncs.com',
    path: '/compatible-mode/v1/chat/completions',
    apiKey: KIMI_KEY,
    body: {
      model: MODEL_OCR,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 8000
    },
    timeout: opts.timeout ?? 300_000
  });
}

// ═══════════════════════════════════════
// 图片工具
// ═══════════════════════════════════════

function imageToBase64(filePath) {
  const buf = readFileSync(filePath);
  const ext = filePath.endsWith('.png') ? 'png' : 'jpeg';
  return `data:image/${ext};base64,${buf.toString('base64')}`;
}

function cropImage(srcPath, bbox, outPath) {
  try {
    execFileSync('convert', [
      srcPath,
      '-crop', `${bbox.w}x${bbox.h}+${bbox.x}+${bbox.y}`,
      '-resize', '640x640>',
      '-quality', '85',
      outPath
    ]);
    return true;
  } catch (e) {
    console.error(`  ⚠️ crop 失败: ${e.message}`);
    return false;
  }
}

// ═══════════════════════════════════════
// Prompt 模板（内联，同步自 paper-workbook-scanner.js）
// ═══════════════════════════════════════

const STAGE1_PROMPT = `你是高中试卷分析专家。你会收到同一页试卷的两张图片，请完成两个任务。

【图片说明】
📷 图1（原图）：完整的试卷原图，包含题目文字、选项、学生蓝黑笔作答
🔴 图2（红笔突出图）：白底上只保留红色批改标记，非红色内容已淡化至极

【任务A — 红笔标记检测】（使用图2）
在图2中找出所有红色批改标记，逐一输出坐标和类型。

标记类型枚举：
- "cross"              — ✗ 打叉
- "check"              — ✓ 打勾
- "correct_answer"     — 红笔手写的答案字母/单词
- "underline"          — 下划线/波浪线
- "strikethrough"      — 横线划掉文字
- "circle"             — 红色圆圈围绕
- "annotation"         — 红笔手写汉字注释
- "score_deduction"    — 扣分标记(-2/-0.5)

content字段：对 correct_answer/annotation/score_deduction 写出红笔文字内容

【任务B — 题目区域识别】（使用图1）
在图1中识别每一道题目的语义边界。

题目类型：choice / fill_blank / reading / dictation / translation / writing

⚠️ 密集布局检测：默写/填空题型每行 = 一道题，每个序号 = 独立bbox
⚠️ 两栏/三栏布局 → 逐栏逐行识别
⚠️ bbox 要合理：上含题号，涵盖答案区+批改区

直接输出纯 JSON（不要 markdown）：
{
  "redMarks": [
    {"markId": 1, "type": "correct_answer", "bbox": {"x": 220, "y": 480, "w": 25, "h": 25}, "content": "C"}
  ],
  "questions": [
    {"questionNumber": 21, "bbox": {"x": 40, "y": 410, "w": 550, "h": 130}, "questionType": "choice"}
  ]
}`;

const STAGE2_PROMPT = `你是高中错题整理助手。你的唯一任务是：读取教师已完成的批改标记，判断这道题学生「做错了」还是「做对了」。

【你的角色】
你**不做批改**。教师/同学已经完成了批改（红笔标记）。
你的工作是「阅读」已有的红笔标记，还原教师的批改结论。

【两张图的分工】
📷 图1（原图裁剪）：该题的题干、选项、学生蓝黑笔作答
🔴 图2（红笔图裁剪）：同一区域的红笔批改标记，非红内容已淡化

铁律：
- 蓝色/黑色笔迹 = 学生的答案
- 红色笔迹 = 教师的批改
- 红色印刷文字/边框不是批改，忽略

【判定规则 — 按优先级】
1. 红笔 ✗ 打叉 → ❌ 错题
2. 红笔划掉/覆盖学生原答案 → ❌ 错题
3. 红笔写了正确答案字母且不同于学生原选 → ❌ 错题
4. 红笔扣分标记 → ❌ 错题
5. 红笔 ✓ 打勾 → ✅ 对
6. 红笔只圈出/下划线/写注释 → ✅ 对
7. 此题无任何红笔标记 → ✅ 对

⚠️ 不确定 → 按"做对"处理（宁可漏判不要误判）

直接输出单个 JSON 对象：
{
  "questionNumber": 21,
  "isError": true,
  "studentAnswer": "B",
  "correctAnswer": "D",
  "teacherIntent": "红笔在题号旁写D，学生选了B",
  "redMarkTypes": ["correct_answer"],
  "errorType": "语法/词汇/逻辑/概念/未知",
  "confidence": "high"
}

如果做对: {"questionNumber": 21, "isError": false, "reason": "红笔打勾"}`;

// ═══════════════════════════════════════
// JSON 提取
// ═══════════════════════════════════════

function extractJSON(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  // 尝试严格解析
  try { return JSON.parse(cleaned); } catch {}
  // 尝试匹配最外层 {...} 或 [...]
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try { return JSON.parse(objMatch[0]); } catch {}
  }
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch {}
  }
  return null;
}

// ═══════════════════════════════════════
// Step 1: 阶段1 — 红笔标记 + 题目区域
// ═══════════════════════════════════════

async function stage1_detectRedMarksAndQuestions(originalPath, redPath) {
  console.log('\n' + '═'.repeat(60));
  console.log('📸 Step 1 — 阶段1：红笔标记检测 + 题目区域识别');
  console.log('═'.repeat(60));
  
  const originalB64 = imageToBase64(originalPath);
  const redB64 = imageToBase64(redPath);
  
  console.log(`  原图: ${originalPath} (${(readFileSync(originalPath).length / 1024).toFixed(1)}KB)`);
  console.log(`  红笔: ${redPath} (${(readFileSync(redPath).length / 1024).toFixed(1)}KB)`);
  console.log('  🤖 调用 Kimi VL...');
  
  const start = Date.now();
  const result = await kimiVision([
    {
      role: 'system',
      content: '只输出纯JSON，不要markdown代码块，不要解释。'
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: STAGE1_PROMPT },
        { type: 'image_url', image_url: { url: originalB64, detail: 'auto' } },
        { type: 'image_url', image_url: { url: redB64, detail: 'auto' } }
      ]
    }
  ], { maxTokens: 8000, temperature: 0.3 });
  
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const rawContent = result.choices?.[0]?.message?.content || '';
  
  console.log(`  ⏱️  耗时: ${elapsed}s`);
  console.log(`  📝 原始响应长度: ${rawContent.length} 字符`);
  
  const parsed = extractJSON(rawContent);
  
  if (!parsed) {
    console.error('  ❌ JSON 解析失败！原始内容前300字:', rawContent.slice(0, 300));
    return null;
  }
  
  const redMarks = parsed.redMarks || [];
  const questions = parsed.questions || [];
  
  console.log(`\n  🔴 红笔标记: ${redMarks.length} 个`);
  const typeCount = {};
  for (const m of redMarks) {
    typeCount[m.type] = (typeCount[m.type] || 0) + 1;
    console.log(`     #${m.markId} ${m.type.padEnd(16)} @ (${m.bbox.x},${m.bbox.y}) ${m.bbox.w}x${m.bbox.h} ${m.content ? '"'+m.content+'"' : ''}`);
  }
  console.log(`     类型分布:`, typeCount);
  
  console.log(`\n  📋 题目区域: ${questions.length} 个`);
  const qTypes = {};
  for (const q of questions) {
    qTypes[q.questionType] = (qTypes[q.questionType] || 0) + 1;
    console.log(`     Q${q.questionNumber} ${(q.questionType||'').padEnd(14)} @ (${q.bbox.x},${q.bbox.y}) ${q.bbox.w}x${q.bbox.h}`);
  }
  console.log(`     题型分布:`, qTypes);
  
  // 保存原始响应
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(join(OUTPUT_DIR, 'stage1-raw.json'), JSON.stringify({ raw: rawContent, parsed, elapsed }, null, 2));
  
  return { redMarks, questions, elapsed };
}

// ═══════════════════════════════════════
// Step 2: 裁切 + 关联红笔到题目
// ═══════════════════════════════════════

function stage2_cropAndAssociate(originalPath, redPath, stage1Result) {
  console.log('\n' + '═'.repeat(60));
  console.log('✂️  Step 2 — 裁切 + 红笔-题目关联');
  console.log('═'.repeat(60));
  
  const { redMarks, questions } = stage1Result;
  const cropDir = join(OUTPUT_DIR, 'crops');
  mkdirSync(cropDir, { recursive: true });
  
  // 关联红笔到题目（程序化 IOU/中心点判断）
  const questionMarks = new Map();
  for (const q of questions) {
    const associated = [];
    const qBox = q.bbox;
    const expandX = qBox.w * 0.1;
    const expandY = qBox.h * 0.1;
    
    for (const rm of redMarks) {
      const rmCenterX = rm.bbox.x + rm.bbox.w / 2;
      const rmCenterY = rm.bbox.y + rm.bbox.h / 2;
      if (
        rmCenterX >= qBox.x - expandX &&
        rmCenterX <= qBox.x + qBox.w + expandX &&
        rmCenterY >= qBox.y - expandY &&
        rmCenterY <= qBox.y + qBox.h + expandY
      ) {
        associated.push(rm);
      }
    }
    questionMarks.set(q.questionNumber, associated);
  }
  
  // 裁切每道题
  const crops = [];
  for (const q of questions) {
    const qMarks = questionMarks.get(q.questionNumber) || [];
    const b = q.bbox;
    
    const origOut = join(cropDir, `q${q.questionNumber}_orig.jpg`);
    const redOut = join(cropDir, `q${q.questionNumber}_red.jpg`);
    
    const origOk = cropImage(originalPath, b, origOut);
    const redOk = cropImage(redPath, b, redOut);
    
    const markSummary = qMarks.map(m => `${m.type}${m.content ? ':'+m.content : ''}`).join(', ');
    
    console.log(`  Q${String(q.questionNumber).padStart(2)} ${(q.questionType||'?').padEnd(12)} | bbox(${b.x},${b.y},${b.w}x${b.h}) | 红笔: ${qMarks.length} [${markSummary || '无'}] | crop: ${origOk&&redOk?'✅':'❌'}`);
    
    crops.push({
      questionNumber: q.questionNumber,
      questionType: q.questionType,
      bbox: b,
      marks: qMarks,
      origPath: origOk ? origOut : null,
      redPath: redOk ? redOut : null
    });
  }
  
  // 输出未关联的红笔
  const associatedIds = new Set();
  for (const [, marks] of questionMarks) {
    for (const m of marks) associatedIds.add(m.markId);
  }
  const unassociated = redMarks.filter(m => !associatedIds.has(m.markId));
  if (unassociated.length > 0) {
    console.log(`\n  ⚠️  ${unassociated.length} 个红笔标记未关联到任何题目:`);
    for (const m of unassociated) {
      console.log(`     #${m.markId} ${m.type} @ (${m.bbox.x},${m.bbox.y})`);
    }
  }
  
  return { crops, unassociated };
}

// ═══════════════════════════════════════
// Step 3: 阶段2 — 逐题判错
// ═══════════════════════════════════════

async function stage3_judgePerQuestion(crops) {
  console.log('\n' + '═'.repeat(60));
  console.log('🔍 Step 3 — 阶段2：逐题双图判错');
  console.log('═'.repeat(60));
  
  const results = [];
  
  for (const crop of crops) {
    if (!crop.origPath || !crop.redPath) {
      console.log(`  Q${crop.questionNumber} ⏭️  跳过（裁切失败）`);
      results.push({ questionNumber: crop.questionNumber, isError: false, skipped: true, reason: 'crop failed' });
      continue;
    }
    
    const origB64 = imageToBase64(crop.origPath);
    const redB64 = imageToBase64(crop.redPath);
    
    const marksHint = crop.marks.length > 0
      ? `\n附近的红笔标记类型: ${crop.marks.map(m => m.type + (m.content ? ':'+m.content : '')).join(', ')}`
      : '';
    
    console.log(`  Q${crop.questionNumber} 🤖 调用 VL (${crop.marks.length} 个标记)...`);
    const start = Date.now();
    
    const result = await kimiVision([
      { role: 'system', content: '只输出单个JSON对象，不要数组，不要markdown。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: STAGE2_PROMPT + marksHint },
          { type: 'image_url', image_url: { url: origB64, detail: 'auto' } },
          { type: 'image_url', image_url: { url: redB64, detail: 'auto' } }
        ]
      }
    ], { maxTokens: 2000, temperature: 0.2 });
    
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const content = result.choices?.[0]?.message?.content || '';
    const parsed = extractJSON(content);
    
    if (parsed) {
      const icon = parsed.isError ? '❌' : '✅';
      console.log(`    ${icon} ${elapsed}s | isError=${parsed.isError} | answer: ${parsed.studentAnswer || '-'} → ${parsed.correctAnswer || '-'} | ${parsed.teacherIntent || parsed.reason || ''}`);
      results.push({ ...parsed, elapsed, raw: content });
    } else {
      console.log(`    ⚠️ ${elapsed}s | JSON 解析失败 → 保守判对`);
      results.push({ questionNumber: crop.questionNumber, isError: false, skipped: true, reason: 'parse failed', raw: content });
    }
  }
  
  return results;
}

// ═══════════════════════════════════════
// 主流程
// ═══════════════════════════════════════

async function main() {
  const sessionId = process.argv[2];
  const pageIndex = parseInt(process.argv[3]) || 1;
  
  if (!sessionId) {
    console.log('用法: node test-scanner-v1.mjs <sessionId> [pageIndex]');
    console.log('示例: node test-scanner-v1.mjs 970cee90 1');
    process.exit(1);
  }
  
  const sessionDir = join(SESSION_DIR, sessionId);
  const originalPath = join(sessionDir, `page_${pageIndex}.jpg`);
  const redPath = join(sessionDir, `red_${pageIndex}.jpg`);
  
  if (!existsSync(originalPath)) {
    console.error(`❌ 原图不存在: ${originalPath}`);
    process.exit(1);
  }
  if (!existsSync(redPath)) {
    console.error(`❌ 红笔图不存在: ${redPath}`);
    console.log('💡 可能需要先生成红笔图（运行完整 analyze 流程）');
    process.exit(1);
  }
  
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   v1.0 Scanner 独立测试 — 三阶段流水线              ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`Session: ${sessionId} | Page: ${pageIndex}`);
  console.log(`原图: ${originalPath}`);
  console.log(`红笔: ${redPath}`);
  
  // Step 1
  const stage1 = await stage1_detectRedMarksAndQuestions(originalPath, redPath);
  if (!stage1) {
    console.error('❌ 阶段1失败，终止测试');
    process.exit(1);
  }
  
  // Step 2
  const { crops, unassociated } = stage2_cropAndAssociate(originalPath, redPath, stage1);
  
  // Step 3
  const judgments = await stage3_judgePerQuestion(crops);
  
  // 汇总
  console.log('\n' + '═'.repeat(60));
  console.log('📊 汇总报告');
  console.log('═'.repeat(60));
  
  const errorCount = judgments.filter(j => j.isError && !j.skipped).length;
  const total = judgments.length;
  
  console.log(`  总题数: ${total}`);
  console.log(`  红笔标记: ${stage1.redMarks.length}`);
  console.log(`  未关联标记: ${unassociated.length}`);
  console.log(`  判错题数: ${errorCount}`);
  console.log(`  跳过错题: ${judgments.filter(j => j.skipped).length}`);
  console.log(`  阶段1耗时: ${stage1.elapsed}s`);
  
  const s3Total = judgments.reduce((s, j) => s + (parseFloat(j.elapsed) || 0), 0);
  console.log(`  阶段3总耗时: ${s3Total.toFixed(1)}s`);
  
  // 输出裁切文件位置
  console.log(`\n  📁 输出: ${OUTPUT_DIR}`);
  console.log(`     stage1-raw.json — 阶段1原始结果`);
  console.log(`     crops/ — 各题裁切图 (qN_orig.jpg, qN_red.jpg)`);
  
  // 详细判错结果
  console.log('\n  📋 逐题判定:');
  for (const j of judgments) {
    const icon = j.skipped ? '⏭️' : (j.isError ? '❌错' : '✅对');
    const detail = j.isError
      ? `${j.studentAnswer || '-'}→${j.correctAnswer || '-'} | ${j.teacherIntent || j.reason || ''}`
      : (j.reason || '无红笔');
    console.log(`     ${icon} Q${String(j.questionNumber).padStart(2)} ${detail}`);
  }
}

main().catch(e => {
  console.error('💥 测试失败:', e);
  process.exit(1);
});
