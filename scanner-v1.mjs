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

export const SCANNER_VERSION = 'v1.0';

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

规则 (按优先级):
3条铁律:
1. 印刷体≠批改！整齐排列的字母(A/B/C/D)是答案键 → 忽略
2. 教师红笔一定是手写体，笔迹不规则，在题目内部或紧贴
3. 批改风格二选一: 全用✓✗ 或 全用红笔写正确答案。同时存在时✓✗优先

判定:
1. 红笔✗ → ❌  2. 划掉+写新答案 → ❌  3. 红笔手写答案≠学生选 → ❌
4. 扣分(-2/-0.5) → ❌  5. 红笔✓ → ✅  6. 圈出/下划线/注释 → ✅
7. 无红笔 → ✅  8. 不确定 → ✅

输出纯JSON数组:
[{"qi":21,"isError":true,"studentAnswer":"B","correctAnswer":"D","teacherIntent":"红笔划掉B写D","errorType":"语法/词汇/逻辑/概念/未知","confidence":"high/medium/low"},{"qi":22,"isError":false,"reason":"无红笔标记"}]`;

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
            confidence: r.confidence || 'medium'
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
    if (!j.isError) continue;
    
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
      j.reviewReason = 'VL 模型低置信';
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
