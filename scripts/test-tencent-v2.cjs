/**
 * 腾讯云 OCR 测试 - 完整版（含坐标重建）
 * 使用 GeneralAccurateOCR，自动处理旋转
 */
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

const SECRET_ID = 'REDACTED_TENCENT_SECRET_ID';
const SECRET_KEY = 'REDACTED_TENCENT_SECRET_KEY';
const SERVICE = 'ocr';
const HOST = 'ocr.tencentcloudapi.com';

function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function hmacSha256(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }

function signTc3(secretKey, date, service, stringToSign) {
  const kDate = hmacSha256('TC3' + secretKey, date);
  const kService = hmacSha256(kDate, service);
  const kSigning = hmacSha256(kService, 'tc3_request');
  return crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
}

async function callTencentOcr(imageBase64, action) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().split('T')[0];
  
  const payload = JSON.stringify({ ImageBase64: imageBase64 });
  
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

// ========== 坐标重建 ==========
// 当 Angle≈90°时，API 交换了 X/Y。原始图片 1280x1707，需要把坐标还原
function rebuildCoordinates(detections, origW, origH, angle) {
  const needSwap = Math.abs(angle) > 45 && Math.abs(angle) < 135;
  
  return detections.map(d => {
    const poly = d.Polygon || [];
    if (poly.length === 0) return { ...d, _fixed: false };
    
    let fixedPoly;
    if (needSwap) {
      // 90° clockwise: 原始 (x,y) → OCR 的 (y, W-x)
      // 还原: OCR (X,Y) → 原始 (H-Y, X) 或类似
      fixedPoly = poly.map(p => ({
        X: Math.round(origH - p.Y),
        Y: Math.round(p.X)
      }));
    } else {
      fixedPoly = poly;
    }
    
    // 计算中心点用于排序
    const cx = fixedPoly.reduce((s,p) => s + p.X, 0) / fixedPoly.length;
    const cy = fixedPoly.reduce((s,p) => s + p.Y, 0) / fixedPoly.length;
    
    return {
      ...d,
      cx: Math.round(cx),
      cy: Math.round(cy),
      _fixed: needSwap,
      FixedPolygon: fixedPoly
    };
  });
}

// ========== 按坐标排序（先 Y 后 X，模拟阅读顺序）==========
function sortByReadingOrder(items, colThreshold) {
  // 将文本行按 Y 坐标分组为"行"，每组内按 X 排序
  const sorted = [...items].sort((a, b) => a.cy - b.cy);
  
  const rows = [];
  let currentRow = [];
  let currentY = sorted[0]?.cy || 0;
  
  for (const item of sorted) {
    if (Math.abs(item.cy - currentY) > 20) {
      if (currentRow.length > 0) {
        currentRow.sort((a, b) => a.cx - b.cx);
        rows.push(currentRow);
      }
      currentRow = [item];
      currentY = item.cy;
    } else {
      currentRow.push(item);
    }
  }
  if (currentRow.length > 0) {
    currentRow.sort((a, b) => a.cx - b.cx);
    rows.push(currentRow);
  }
  
  return rows;
}

// ========== 主流程 ==========
async function main() {
  const imagePath = '/app/data/papers/4a96c145/page_1.jpg';
  const imageBuffer = fs.readFileSync(imagePath);
  const imageBase64 = imageBuffer.toString('base64');

  console.log('═══════════════════════════════════════');
  console.log('  腾讯云 OCR 识别测试');
  console.log('  试卷: yingyu34 (4a96c145)');
  console.log('  接口: GeneralAccurateOCR');
  console.log('═══════════════════════════════════════\n');
  console.log(`📷 图片: ${path.basename(imagePath)}`);
  console.log(`📏 尺寸: 1280×1707 (${(imageBuffer.length/1024).toFixed(0)}KB)\n`);
  console.log('⏳ 调用 API...\n');

  // 调用 OCR
  const result = await callTencentOcr(imageBase64, 'GeneralAccurateOCR');
  
  if (result.Response.Error) {
    console.error('❌', JSON.stringify(result.Response.Error));
    process.exit(1);
  }

  const resp = result.Response;
  const detections = resp.TextDetections || [];
  const angle = resp.Angle || 0;

  console.log(`✅ 成功！${detections.length} 行文字，角度 ${angle.toFixed(1)}°\n`);

  // 坐标重建
  const fixed = rebuildCoordinates(detections, 1280, 1707, angle);
  
  // 按阅读顺序排序
  const rows = sortByReadingOrder(fixed);

  // 输出结果
  console.log('═══════════════════════════════════════');
  console.log('  识别结果（坐标重建后，按阅读顺序）');
  console.log('═══════════════════════════════════════\n');

  let lastY = 0;
  for (const row of rows) {
    const y = row[0].cy;
    if (y - lastY > 40) console.log(''); // 段落分隔
    
    const lineText = row.map(r => {
      const conf = r.Confidence >= 90 ? '' : ` [${r.Confidence}%]`;
      return r.DetectedText + conf;
    }).join('  ');
    
    if (lineText.trim()) {
      console.log(lineText);
    }
    lastY = y;
  }

  // 提取题目列表
  console.log('\n\n═══════════════════════════════════════');
  console.log('  题目识别列表（供核对）');
  console.log('═══════════════════════════════════════\n');

  const allText = detections.map(d => d.DetectedText).join(' ');
  
  // 提取所有可能的题号
  const qPattern = /\b(\d{1,3})[\.\)、]\s*([A-D][\.\)\s])?/g;
  const questions = new Map();
  let match;
  while ((match = qPattern.exec(allText)) !== null) {
    const num = parseInt(match[1]);
    if (num >= 1 && num <= 60) {
      if (!questions.has(num)) questions.set(num, []);
      questions.get(num).push(match[0]);
    }
  }

  // 有序输出题目
  const sortedQ = [...questions.keys()].sort((a,b) => a-b);
  console.log(`检测到 ${sortedQ.length} 个题号标记`);
  console.log('题号:', sortedQ.join(', '));

  // 保存原始结果
  const outPath = path.join(__dirname, '..', 'output', 'tencent-ocr-yingyu34.json');
  fs.writeFileSync(outPath, JSON.stringify({
    angle, detections, fixedCount: fixed.length, rowCount: rows.length,
    questions: sortedQ,
    rawResponse: resp
  }, null, 2));
  console.log(`\n💾 完整结果: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
