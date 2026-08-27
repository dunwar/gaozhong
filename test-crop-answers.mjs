#!/usr/bin/env node
/** 在真实裁剪图上验证 readCropAnswers 改进 prompt（只走智谱VL，不依赖DeepSeek） */
import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import https from 'https';

const ROOT = resolve(import.meta.dirname);
const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf-8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !m[2].startsWith('"')) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const KEY = env.ZHIPU_API_KEY;
const MODEL = env.MODEL_ZHIPU_VL || 'glm-4.6v';
if (!KEY) { console.error('no ZHIPU key'); process.exit(1); }

function zhipu(body) {
  return new Promise((resolveP, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'open.bigmodel.cn', path: '/api/paas/v4/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}`, 'Content-Length': Buffer.byteLength(data) },
      timeout: 60000
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolveP(JSON.parse(buf)); } catch (e) { reject(new Error(buf.slice(0, 200))); }
      });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}

const cropDir = join(ROOT, 'eval/results/rerun-20260824');
const crops = readdirSync(cropDir).filter(f => /^p\d+_q\d+\.jpg$/.test(f)).sort((a, b) => {
  const [pa, qa] = a.match(/p(\d+)_q(\d+)/).slice(1).map(Number);
  const [pb, qb] = b.match(/p(\d+)_q(\d+)/).slice(1).map(Number);
  return pa - pb || qa - qb;
}).filter(f => f.startsWith('p4') || f.startsWith('p3'));

const prompt = `这是一道高中试卷题目的裁剪图，包含：
- 印刷体题目和选项（黑字）
- 老师的红笔批改：题号旁的红笔字母通常是老师标注的正确答案；✗/勾是判定标记
- 学生的作答：蓝笔/黑笔/铅笔写的字母或单词，常见位置——选项旁圈选、题号旁、括号( )内、空格____上

请分别读出：
1. studentAnswer — 学生自己的作答（铅笔/蓝笔/黑笔笔迹）。⚠️ 红笔字母是老师的，不要当成学生答案；确实看不到学生笔迹就填 ""
2. correctAnswer — 红笔标注的正确答案字母/内容（没有填 ""）

只输出JSON：{"studentAnswer":"","correctAnswer":""}`;

let saCount = 0;
for (const f of crops) {
  const b64 = readFileSync(join(cropDir, f)).toString('base64');
  try {
    const r = await zhipu({
      model: MODEL,
      messages: [
        { role: 'system', content: '只输出JSON，无其他文字。' },
        { role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'high' } }
        ]}
      ],
      temperature: 0.1, max_tokens: 200, thinking: { type: 'disabled' }
    });
    const content = (r.choices?.[0]?.message?.content || '').trim().replace(/```json|```/g, '');
    let parsed = {};
    try { parsed = JSON.parse(content); } catch { const m = content.match(/\{[\s\S]*\}/); if (m) try { parsed = JSON.parse(m[0]); } catch {} }
    const sa = (parsed.studentAnswer || '').toUpperCase();
    const ca = (parsed.correctAnswer || '').toUpperCase();
    if (sa) saCount++;
    console.log(`${f}: student="${sa}" correct="${ca}"`);
  } catch (e) { console.log(`${f}: ERROR ${e.message}`); }
}
console.log(`\nstudentAnswer 命中: ${saCount}/${crops.length}`);
