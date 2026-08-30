// 临时诊断: 用 glm-4.6v 检查 v4 裁剪图是否内容正确+正向
import fs from 'fs';
import https from 'https';

const env = fs.readFileSync('.env', 'utf8');
const key = (env.match(/^ZHIPU_API_KEY=(.+)$/m) || [])[1].trim();

function ask(b64, prompt) {
  const body = JSON.stringify({
    model: 'glm-4.6v',
    messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } },
      { type: 'text', text: prompt }
    ]}],
    max_tokens: 120, thinking: { type: 'disabled' }
  });
  return new Promise(res => {
    const req = https.request({
      hostname: 'open.bigmodel.cn', path: '/api/coding/paas/v4/chat/completions',
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'Content-Length': Buffer.byteLength(body) },
      timeout: 60000
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try { const j = JSON.parse(d); res(j.error ? ('ERR ' + j.error.message) : (j.choices[0].message.content || '').slice(0, 160)); }
        catch { res('PARSE_ERR'); }
      });
    });
    req.on('error', e => res('REQ_ERR ' + e.message));
    req.write(body); req.end();
  });
}

const dir = process.argv[2];
const files = process.argv.slice(3);
for (const f of files) {
  const b64 = fs.readFileSync(dir + '/' + f + '.jpg').toString('base64');
  console.log(f + ' → ' + await ask(b64, '图中题目的题号是多少?题干开头8个词?文字是否正向?红笔批改内容?一句话。'));
}
