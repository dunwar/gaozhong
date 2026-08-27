#!/usr/bin/env node
/** TextIn v3 智能抽取实测 — 用自定义 schema 抽取试卷题目结构（阶段验证：能否替代LLM解析层）
 *  用法: node test-textin-extract.mjs <图片路径> [--dewarp] [--out 输出.json]
 */
import { readFileSync, writeFileSync } from 'fs';
import https from 'https';

const env = {};
for (const l of readFileSync('.env', 'utf-8').split('\n')) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
if (!env.TEXTIN_APP_ID || !env.TEXTIN_SECRET_CODE) {
  console.error('缺少 TEXTIN_APP_ID / TEXTIN_SECRET_CODE'); process.exit(1);
}

const args = process.argv.slice(2);
const imgPath = args.find(a => !a.startsWith('--'));
const dewarp = args.includes('--dewarp');
const outIdx = args.indexOf('--out');
const outPath = outIdx > -1 ? args[outIdx + 1] : null;

const SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          questionNumber: { type: 'string', description: '试卷印刷题号数字，如 "25"' },
          questionType: { type: 'string', description: '题型：听力/单项选择/完形填空/阅读理解/选词填空/句子填空/翻译/写作' },
          questionText: { type: 'string', description: '题干完整文字' },
          options: { type: 'string', description: '该题的选项，格式 "A.选项A内容 B.选项B内容 C.选项C内容 D.选项D内容"；无选项的题留空字符串' },
          passageText: { type: 'string', description: '该题所属的共享文章/短文全文（阅读理解、完形填空、语篇填空才有；单独题留空字符串）' },
          studentAnswer: { type: 'string', description: '学生在该题旁/空格上手写作答的字母或单词（蓝笔/黑笔/铅笔笔迹）；看不到留空字符串' },
          teacherAnswer: { type: 'string', description: '老师红笔在该题旁标注的正确答案字母（如 C）；没有留空字符串' }
        },
        required: ['questionNumber', 'questionType', 'questionText', 'options', 'passageText', 'studentAnswer', 'teacherAnswer']
      }
    }
  },
  required: ['questions']
};

const b64 = readFileSync(imgPath).toString('base64');
const body = JSON.stringify({
  file: { file_base64: b64, file_name: 'page.jpg' },
  schema: SCHEMA,
  parse_options: {
    parse_mode: 'scan',
    crop_dewarp: dewarp ? 1 : 0,
    get_image: 'none',
    formula_level: 0
  },
  extract_options: { generate_citations: true }
});

console.log(`图片: ${imgPath} (${(b64.length / 1024).toFixed(0)}KB b64) | dewarp=${dewarp}`);
const t0 = Date.now();

const req = https.request({
  hostname: 'api.textin.com', path: '/ai/service/v3/entity_extraction', method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-ti-app-id': env.TEXTIN_APP_ID,
    'x-ti-secret-code': env.TEXTIN_SECRET_CODE,
    'Content-Length': Buffer.byteLength(body)
  },
  timeout: 300000
}, res => {
  let buf = '';
  res.on('data', c => buf += c);
  res.on('end', () => {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    let j = null;
    try { j = JSON.parse(buf); } catch {}
    if (!j) { console.log(`HTTP ${res.statusCode} (${secs}s) 非JSON:`, buf.slice(0, 300)); return; }
    console.log(`HTTP ${j.code} ${j.message} (${secs}s) version=${j.version}`);
    if (j.code !== 200) { console.log(JSON.stringify(j).slice(0, 400)); return; }
    const qs = j.result?.extracted_schema?.questions || [];
    console.log(`题目数: ${qs.length}`);
    console.log('题号:', qs.map(q => q.questionNumber).join(','));
    // 坐标可用性检查
    const cites = j.result?.citations?.questions;
    let withPos = 0;
    if (Array.isArray(cites)) {
      for (const c of cites) {
        const qn = c?.questionNumber?.bounding_regions?.[0]?.position;
        if (qn && qn.length === 8) withPos++;
      }
    }
    console.log(`题号坐标可回显: ${withPos}/${qs.length}`);
    // 样例
    for (const q of qs.slice(0, 3)) {
      const opts = String(q.options || '');
      console.log(`  Q${q.questionNumber} [${q.questionType || '?'}] ${String(q.questionText || '').slice(0, 50)}... opts=${opts.slice(0, 40)}`);
    }
    const withP = qs.filter(q => (q.passageText || '').trim());
    if (withP.length) console.log(`passageText 非空: ${withP.length} 题, 最长 ${Math.max(...withP.map(q => q.passageText.length))} 字符`);
    if (outPath) { writeFileSync(outPath, JSON.stringify(j, null, 1)); console.log('完整响应已存:', outPath); }
  });
});
req.on('error', e => console.log('ERR', e.message));
req.on('timeout', () => { req.destroy(); console.log('TIMEOUT'); });
req.write(body); req.end();
