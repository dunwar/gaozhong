#!/usr/bin/env node
/** node 版大批次模型探测（绕开 python 代理问题）+ passage 提取验证 */
import { readFileSync } from 'fs';
import https from 'https';

const env = {};
for (const l of readFileSync('.env', 'utf-8').split('\n')) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const prompt = readFileSync('D:/Temp/batch_prompt_p456.txt', 'utf-8');
console.log('prompt:', prompt.length, 'chars');

function call(model) {
  return new Promise((resolve) => {
    const d = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.05,
      max_tokens: 24576,
      thinking: { type: 'disabled' }
    });
    const t0 = Date.now();
    const req = https.request({
      hostname: 'open.bigmodel.cn', path: '/api/paas/v4/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.ZHIPU_API_KEY}`, 'Content-Length': Buffer.byteLength(d) },
      timeout: 300000
    }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => {
        const secs = ((Date.now() - t0) / 1000).toFixed(0);
        if (res.statusCode !== 200) { console.log(`${model}: HTTP ${res.statusCode} (${secs}s) ${b.slice(0, 120)}`); return resolve(null); }
        try {
          const j = JSON.parse(b);
          const content = j.choices?.[0]?.message?.content || '';
          const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/g, '');
          let parsed = null;
          try { parsed = JSON.parse(cleaned); } catch { const m2 = cleaned.match(/\{[\s\S]*\}/); if (m2) { try { parsed = JSON.parse(m2[0]); } catch {} } }
          if (!parsed) { console.log(`${model}: 200 但解析失败, content ${content.length} chars (${secs}s): ${content.slice(0, 120)}`); return resolve(null); }
          resolve({ parsed, secs, usage: j.usage });
        } catch (e) { console.log(`${model}: 解析异常 ${e.message}`); resolve(null); }
      });
    });
    req.on('error', e => { console.log(`${model}: ERR ${e.message}`); resolve(null); });
    req.on('timeout', () => { req.destroy(); console.log(`${model}: TIMEOUT`); resolve(null); });
    req.write(d); req.end();
  });
}

for (const model of ['glm-4.5-flash', 'glm-4-flash-250414', 'glm-4.6v-flash']) {
  console.log(`\n── ${model} ──`);
  const r = await call(model);
  if (r) {
    const qs = r.parsed.questions || [];
    const withP = qs.filter(q => (q.passageText || '').trim());
    console.log(`  ${qs.length} 题 / ${r.secs}s / usage: in=${r.usage?.prompt_tokens} out=${r.usage?.completion_tokens}`);
    console.log(`  题号: ${qs.map(q => q.questionNumber).sort((a, b) => a - b).slice(0, 25).join(',')}`);
    console.log(`  passageText 非空: ${withP.length} 题` + (withP.length ? ` | 最长 Q${withP.reduce((a, b) => a.passageText.length > b.passageText.length ? a : b).questionNumber} ${Math.max(...withP.map(q => q.passageText.length))}字符` : ''));
  }
  await new Promise(r2 => setTimeout(r2, 8000));
}
