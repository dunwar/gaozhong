/**
 * gaozhong.online — 错题整理扫描器 v1.0
 * 
 * 架构（经过 v1-v5 测试迭代）:
 *   阶段1: VL 全图 → 只识别题目 bbox（不检测红笔）
 *   阶段2: 裁切所有题 → 批处理 VL 判错（小图红笔检测+判对错）
 *   阶段3: DeepSeek 纯文本分析
 * 
 * 使用: ESM 模块，api-server.js 通过动态 import() 调用
 */

import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SCANNER_VERSION = 'v2.1';

// ═══════════════════════════════════════
// API 请求
// ═══════════════════════════════════════

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
  return apiRequest({
    hostname: 'dashscope.aliyuncs.com',
    path: '/compatible-mode/v1/chat/completions',
    apiKey: opts.apiKey || process.env.KIMI_API_KEY || '',
    body: {
      model: opts.model || 'kimi-k2.6',
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 8000
    },
    timeout: opts.timeout ?? 300_000
  });
}

// ═══════════════════════════════════════
// 图片工具
// ═══════════════════════════════════════

function imgToBase64(filePath) {
  const buf = readFileSync(filePath);
  return `data:image/${filePath.endsWith('.png')?'png':'jpeg'};base64,${buf.toString('base64')}`;
}

function cropImage(srcPath, bbox, outPath) {
  try {
    // Validate and clamp bbox
    const x = Math.max(0, Math.round(bbox.x));
    const y = Math.max(0, Math.round(bbox.y));
    const w = Math.round(bbox.w);
    const h = Math.round(bbox.h);
    if (w < 20 || h < 20) return false;
    
    execFileSync('convert', [
      srcPath, '-crop', `${w}x${h}+${x}+${y}`,
      '-resize', '640x640>', '-quality', '85', outPath
    ]);
    return true;
  } catch (e) { return false; }
}

// ═══════════════════════════════════════
// JSON 提取（三层 fallback）
// ═══════════════════════════════════════

function extractJSON(text) {
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  
  // Layer 1: 严格解析
  try { return JSON.parse(cleaned); } catch {}
  
  // Layer 2: 正则匹配 {...} 或 [...]
  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch {} }
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch {} }
  
  // Layer 3: 尝试闭合截断的 JSON
  try { return JSON.parse(cleaned + '"]}'); } catch {}
  try { return JSON.parse(cleaned + ']'); } catch {}
  
  // Layer 4: 抢救已完成的对象
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < cleaned.length; i++) {
    if (esc) { esc = false; continue; }
    if (cleaned[i] === '\\') { esc = true; continue; }
    if (cleaned[i] === '"' && !esc) { inStr = !inStr; continue; }
    if (inStr) continue;
    if (cleaned[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (cleaned[i] === '}') { depth--; if (depth === 0 && start >= 0) { objs.push(cleaned.slice(start, i+1)); start = -1; } }
  }
  if (objs.length > 0) {
    const parsed = objs.map(o => { try { return JSON.parse(o); } catch { return null; } }).filter(Boolean);
    if (parsed.length > 0) {
      if (parsed.some(p => p.questionNumber)) return { questions: parsed.filter(p => p.questionNumber) };
      if (parsed.some(p => p.isError !== undefined)) return parsed;
    }
  }
  
  return null;
}

// ═══════════════════════════════════════
// Prompt 模板
// ═══════════════════════════════════════

const PROMPT_DETECT_QUESTIONS = `你是高中试卷版面分析专家。分析这张试卷图片，只做一件事：识别每道题目的边界。

题目类型: choice / fill_blank / reading / dictation / translation / writing

规则:
1. 识别整页所有题号(如1,2,3...或21,22,23...)，每个题号=一道独立题目
2. ⚠️ 一栏布局：题目按题号从上到下排列，不是两栏。所有题目在页面左半区
3. bbox 左起题号，右至选项/答案区末尾(约页面2/3宽度)
4. bbox 上含题号，下含本题末行
5. ⚠️ 不要包含试卷右边缘整齐排列的印刷字母列(答案键)
6. 跨页续题(只有选项无题干)也独立成题

直接输出纯JSON:
{"questions":[{"questionNumber":21,"bbox":{"x":40,"y":80,"w":550,"h":120},"questionType":"choice"}]}`;

const PROMPT_JUDGE_BATCH = `你是高中试卷批改阅读专家。分析以下多道题的裁切图(每题一张)，逐一判断对错。

## 唯一判定标准：手写红笔在答案区 = 批改

印刷红色、非手写红笔标记 = 噪音忽略。宁可漏判不要误判；不确定时默认为"做对"。

## 手写红笔 vs 印刷红色（必须区分！）

| 手写红笔 | 印刷红色 |
|---------|---------|
| 紧贴学生答案区域 | 试卷固定位置（标题/边框/装饰） |
| 不规则、粗细变化、有笔锋 | 均匀、规整、字体一致 |
| 只在有学生作答的题目旁出现 | 全卷均匀分布 |
| 颜色可能有深浅变化 | 与试卷其他印刷红色色值一致 |

印刷红色（标题、页码、边框装饰、答案键）不是批改标记，必须忽略。

## 判定决策树（按优先级）

1. 学生答案旁有手写红笔 ✗ 吗？ → ❌ 错题 (confidence: high)
2. 学生答案旁有手写红笔 ✓ 吗？ → ✅ 对题 (confidence: high)
3. 学生手写答案旁有手写红笔字母/单词/数字吗？ → ❌ 错题 (教师标注了正确答案, confidence: high)
4. 有红笔划掉/覆盖学生原答案吗？ → ❌ 错题 (confidence: high)
5. 有红笔扣分标记(-2/-0.5等)吗？ → ❌ 错题 (confidence: medium)
6. 有红笔圈画/下划线/波浪线吗？ → 忽略(不是判错标记)，继续下一条
7. 无上述手写红笔标记 → ✅ 对题 (confidence: low，标记"无批改标记")

⚠️ 红笔圈题号、下划线、波浪线、边框 = 教师标注/高亮，不是判错！忽略这些继续判定。
⚠️ 同一道题上 ✗ 和手写字母可以共存。

## 输出格式

纯JSON数组，每题一个对象:
[{
  "qi": 21,
  "isError": true,
  "studentAnswer": "B",
  "correctAnswer": "D",
  "teacherIntent": "红笔在B上打✗并在旁写D",
  "errorType": "语法/词汇/逻辑/概念/未知",
  "confidence": "high/medium/low",
  "evidence": {
    "hasHandwrittenRedCross": true,
    "hasHandwrittenRedCheck": false,
    "hasHandwrittenRedLetters": true,
    "redLettersContent": "D",
    "hasStrikethrough": false
  }
}]`;

// ═══════════════════════════════════════
// 阶段1: 只检测题目区域
// ═══════════════════════════════════════

export async function detectQuestions(pagePath, apiKey) {
  const b64 = imgToBase64(pagePath);
  const result = await kimiVision([
    { role: 'system', content: '只输出纯JSON，不要markdown，不要解释。' },
    { role: 'user', content: [{ type: 'text', text: PROMPT_DETECT_QUESTIONS }, { type: 'image_url', image_url: { url: b64, detail: 'auto' } }] }
  ], { apiKey, maxTokens: 6000, temperature: 0.1 });
  
  const content = result.choices?.[0]?.message?.content || '';
  const parsed = extractJSON(content);
  
  if (!parsed || !parsed.questions || parsed.questions.length === 0) {
    throw new Error(`阶段1 未识别到题目: ${content.slice(0, 300)}`);
  }
  
  return parsed.questions;
}

// ═══════════════════════════════════════
// 阶段2: 裁切所有题 + 批处理判错
// ═══════════════════════════════════════

export function cropAllQuestions(pagePath, questions, outputDir, pageIndex = 1) {
  const crops = [];
  const errors = [];
  for (const q of questions) {
    const b = q.bbox;
    if (b.x > 500) {
      errors.push({ questionNumber: q.questionNumber, reason: `bbox x=${b.x} 疑似误定位到答案键区域，跳过` });
      continue;
    }
    const outPath = join(outputDir, `p${pageIndex}_q${q.questionNumber}.jpg`);
    const ok = cropImage(pagePath, b, outPath);
    if (ok) {
      crops.push({ questionNumber: q.questionNumber, questionType: q.questionType, cropPath: outPath });
    } else {
      errors.push({ questionNumber: q.questionNumber, reason: 'crop failed' });
    }
  }
  if (errors.length > 0) {
    console.error('[scanner] crop errors:', errors);
  }
  return crops;
}

export async function judgePerQuestionBatch(crops, apiKey) {
  const BATCH_SIZE = 8;
  const allResults = [];
  
  for (let i = 0; i < crops.length; i += BATCH_SIZE) {
    const batch = crops.slice(i, i + BATCH_SIZE);
    const content = [
      { type: 'text', text: `${PROMPT_JUDGE_BATCH}\n\n题号映射: ${batch.map((c,j) => `图${j+1}=Q${c.questionNumber}`).join(', ')}。qi字段用实际题号。` }
    ];
    for (const c of batch) {
      content.push({ type: 'image_url', image_url: { url: imgToBase64(c.cropPath), detail: 'auto' } });
    }
    
    try {
      const result = await kimiVision([
        { role: 'system', content: '只输出纯JSON数组。' },
        { role: 'user', content }
      ], { apiKey, maxTokens: batch.length * 800, temperature: 0.1 });
      
      const parsed = extractJSON(result.choices?.[0]?.message?.content || '');
      if (Array.isArray(parsed)) {
        for (const r of parsed) {
          const qn = parseInt(String(r.qi || r.questionNumber || '').replace('Q', ''));
          allResults.push({
            questionNumber: qn || 0,
            isError: !!r.isError,
            studentAnswer: r.studentAnswer || '',
            correctAnswer: r.correctAnswer || '',
            teacherIntent: r.teacherIntent || r.reason || '',
            errorType: r.errorType || '未知',
            confidence: r.confidence || 'medium',
            evidence: r.evidence || {}
          });
        }
      }
    } catch (e) {
      // 批次失败：全部判对（保守）
      for (const c of batch) {
        allResults.push({ questionNumber: c.questionNumber, isError: false, reason: 'batch error', confidence: 'low' });
      }
    }
  }
  
  return allResults;
}

// ═══════════════════════════════════════
// 置信度评估
// ═══════════════════════════════════════

export function assessConfidence(judgments) {
  for (const j of judgments) {
    if (!j.isError) {
      // 非错题但无手写红笔标记 → 可能漏批，需复核
      if (j.confidence === 'low' && (!j.evidence || 
          (!j.evidence.hasHandwrittenRedCross && 
           !j.evidence.hasHandwrittenRedCheck && 
           !j.evidence.hasHandwrittenRedLetters))) {
        j.needsReview = true;
        j.reviewReason = '无批改标记，可能漏批';
      }
      continue;
    }
    
    // 一致性检查：学生答案=正确答案 → 不应判错
    if (j.studentAnswer && j.correctAnswer && 
        j.studentAnswer.toUpperCase() === j.correctAnswer.toUpperCase()) {
      j.isError = false;
      j.isModified = true;
      j.teacherIntent = (j.teacherIntent || '') + ' [自动纠正: 学生答案=正确答案，取消误判]';
      continue;
    }
    
    if (j.confidence === 'low') {
      j.needsReview = true;
      j.reviewReason = 'VL 模型低置信'
        + (j.evidence && !j.evidence.hasHandwrittenRedCross && j.evidence.hasHandwrittenRedLetters 
           ? '（基于红笔字母判定）' : '');
    } else if (j.confidence === 'medium') {
      j.needsReview = true;
      j.reviewReason = '建议人工复核';
    } else {
      j.needsReview = false;
    }
  }
  return judgments;
}

// ═══════════════════════════════════════
// 完整流水线
// ═══════════════════════════════════════

export async function scanPage(pagePath, { apiKey, outputDir, pageIndex = 1 }) {
  // 1. 检测题目
  const questions = await detectQuestions(pagePath, apiKey);
  
  // 2. 裁切
  const crops = cropAllQuestions(pagePath, questions, outputDir, pageIndex);
  
  // 3. 判错
  const judgments = await judgePerQuestionBatch(crops, apiKey);
  
  // 4. 置信度
  const assessed = assessConfidence(judgments);
  
  const errors = assessed.filter(j => j.isError);
  
  return {
    questions: questions.length,
    crops: crops.length,
    totalJudged: judgments.length,
    errors: errors.length,
    needsReview: assessed.filter(j => j.needsReview).length,
    judgments: assessed,
    errorItems: errors
  };
}
