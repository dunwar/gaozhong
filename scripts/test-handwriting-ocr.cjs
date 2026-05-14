/**
 * 腾讯云手写体 OCR 测试 — 红笔批改识别
 * 使用 GeneralHandwritingOCR + Scene=only_hw 只检测手写内容
 */
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

const SECRET_ID = 'REDACTED_TENCENT_SECRET_ID';
const SECRET_KEY = 'REDACTED_TENCENT_SECRET_KEY';
const HOST = 'ocr.tencentcloudapi.com';
const SERVICE = 'ocr';

function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function hmacSha256(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }

function signTc3(secretKey, date, service, stringToSign) {
  const kDate = hmacSha256('TC3' + secretKey, date);
  const kService = hmacSha256(kDate, service);
  const kSigning = hmacSha256(kService, 'tc3_request');
  return crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
}

async function callOcr(imageBase64, action, extraPayload = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().split('T')[0];
  
  const payload = JSON.stringify({ ImageBase64: imageBase64, ...extraPayload });
  
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${HOST}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const hashedPayload = sha256(payload);
  
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${sha256(canonicalRequest)}`;
  const signature = signTc3(SECRET_KEY, date, SERVICE, stringToSign);
  const authorization = `TC3-HMAC-SHA256 Credential=${SECRET_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: HOST, port: 443, path: '/', method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Host': HOST,
        'X-TC-Action': action,
        'X-TC-Version': '2018-11-19',
        'X-TC-Timestamp': timestamp,
        'Authorization': authorization
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(data.substring(0,500))); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  const img = fs.readFileSync('/app/data/papers/4a96c145/page_1.jpg');
  const b64 = img.toString('base64');

  console.log('═══════════════════════════════════════');
  console.log('  腾讯云手写体 OCR — 红笔批改识别测试');
  console.log('  试卷: yingyu34 | 接口: GeneralHandwritingOCR');
  console.log('═══════════════════════════════════════\n');

  // 测试1: only_hw 模式 — 只输出手写内容（红笔标记）
  console.log('🔬 测试1: Scene=only_hw（仅识别手写体，过滤印刷体）\n');
  const r1 = await callOcr(b64, 'GeneralHandwritingOCR', { Scene: 'only_hw' });
  
  if (r1.Response.Error) {
    console.log('❌', r1.Response.Error.Message);
  } else {
    const hw = r1.Response.TextDetections || [];
    console.log(`检测到手写内容: ${hw.length} 行`);
    hw.forEach((d, i) => {
      const poly = d.Polygon || [];
      const x = poly[0]?.X || 0;
      const y = poly[0]?.Y || 0;
      console.log(`  ${i+1}. [${d.Confidence}%] (${x},${y}) "${d.DetectedText}"`);
    });
    if (hw.length === 0) console.log('  (无手写内容被检测到)');
  }

  // 测试2: 普通模式 — 全部识别（印刷+手写）
  console.log('\n🔬 测试2: 普通模式（不限制Scene，识别全部文字）\n');
  const r2 = await callOcr(b64, 'GeneralHandwritingOCR');
  
  if (r2.Response.Error) {
    console.log('❌', r2.Response.Error.Message);
  } else {
    const all = r2.Response.TextDetections || [];
    console.log(`检测到文字: ${all.length} 行，角度 ${r2.Response.Angle?.toFixed(1)}°`);
    
    // 筛选可能的手写/标记内容（✓✗X 等符号 + 异常文字）
    const marks = all.filter(d => {
      const t = d.DetectedText || '';
      return /[✓✗Xx×]/.test(t) || d.Confidence < 70 || t.length <= 3;
    });
    
    if (marks.length > 0) {
      console.log(`\n📝 可能的批改标记/低置信度内容 (${marks.length}条):`);
      marks.forEach(d => {
        console.log(`  [${d.Confidence}%] "${d.DetectedText}"`);
      });
    }
  }

  // 测试3: GeneralAccurateOCR 的结果中找标记
  console.log('\n🔬 测试3: 对比 GeneralAccurateOCR 结果中的标记\n');
  const r3 = await callOcr(b64, 'GeneralAccurateOCR');
  if (!r3.Response.Error) {
    const dets = r3.Response.TextDetections || [];
    const marks3 = dets.filter(d => {
      const t = d.DetectedText || '';
      return /[✓✗Xx×]/.test(t) || d.Confidence < 60 || /^[A-D][\s]*$/.test(t.trim());
    });
    console.log(`检测到文字: ${dets.length} 行`);
    console.log(`标记相关内容 (${marks3.length}条):`);
    marks3.forEach(d => {
      console.log(`  [${d.Confidence}%] "${d.DetectedText}"`);
    });
  }

  console.log('\n═══════════════════════════════════════');
}

main().catch(e => { console.error(e); process.exit(1); });
