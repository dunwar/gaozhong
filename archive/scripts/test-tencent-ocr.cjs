/**
 * 腾讯云 OCR 服务测试脚本
 * 使用 GeneralAccurateOCR（高精度版，99% 准确率）
 * 对 yingyu34 试卷进行全图文字识别测试
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ========== 配置 ==========
const SECRET_ID = 'REDACTED_TENCENT_SECRET_ID';
const SECRET_KEY = 'REDACTED_TENCENT_SECRET_KEY';
const SERVICE = 'ocr';
const HOST = 'ocr.tencentcloudapi.com';
const ACTION = 'GeneralAccurateOCR';
const VERSION = '2018-11-19';
const REGION = 'ap-guangzhou';

// ========== 工具函数 ==========

function sha256(data, encoding = 'hex') {
  return crypto.createHash('sha256').update(data).digest(encoding);
}

function hmacSha256(key, data, encoding = undefined) {
  return crypto.createHmac('sha256', key).update(data).digest(encoding);
}

// ========== TC3-HMAC-SHA256 签名 ==========

function signTc3(secretKey, date, service, stringToSign) {
  const kDate = hmacSha256('TC3' + secretKey, date);
  const kService = hmacSha256(kDate, service);
  const kSigning = hmacSha256(kService, 'tc3_request');
  return hmacSha256(kSigning, stringToSign, 'hex');
}

// ========== 调用 API ==========

async function callOcr(imageBase64) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().split('T')[0];

  const payload = JSON.stringify({
    ImageBase64: imageBase64
  });

  // Step 1: Canonical Request
  const httpRequestMethod = 'POST';
  const canonicalUri = '/';
  const canonicalQueryString = '';
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${HOST}\nx-tc-action:${ACTION.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const hashedRequestPayload = sha256(payload);

  const canonicalRequest = [
    httpRequestMethod,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    hashedRequestPayload
  ].join('\n');

  // Step 2: String to Sign
  const algorithm = 'TC3-HMAC-SHA256';
  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const hashedCanonicalRequest = sha256(canonicalRequest);

  const stringToSign = [
    algorithm,
    timestamp,
    credentialScope,
    hashedCanonicalRequest
  ].join('\n');

  // Step 3: Signature
  const signature = signTc3(SECRET_KEY, date, SERVICE, stringToSign);

  // Step 4: Authorization header
  const authorization = `${algorithm} Credential=${SECRET_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // Step 5: Send request
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      port: 443,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Host': HOST,
        'X-TC-Action': ACTION,
        'X-TC-Version': VERSION,
        'X-TC-Timestamp': timestamp,
        'X-TC-Region': REGION,
        'Authorization': authorization
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error(`Parse error: ${data.substring(0, 500)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ========== 分析结果 ==========

function extractQuestionNumbers(textDetections) {
  // 尝试从识别的文字中提取题号
  const results = [];
  const questionPattern = /^(\d{1,3})[\.、．)\s]/;
  const sectionPattern = /^([IVXLCDM]+)[\.、．)\s]/;

  for (const item of textDetections) {
    const text = item.DetectedText.trim();
    const confidence = item.Confidence;

    // 检查是否是题号行
    const qMatch = text.match(questionPattern);
    const sMatch = text.match(sectionPattern);

    if (qMatch) {
      results.push({
        type: 'question',
        number: parseInt(qMatch[1]),
        text: text,
        confidence: confidence
      });
    } else if (sMatch) {
      results.push({
        type: 'section',
        label: sMatch[1],
        text: text,
        confidence: confidence
      });
    } else {
      results.push({
        type: 'line',
        text: text,
        confidence: confidence
      });
    }
  }

  return results;
}

// ========== 主流程 ==========

async function main() {
  const imagePath = process.argv[2] || '/app/data/papers/4a96c145/page_1.jpg';

  console.log('═══════════════════════════════════════');
  console.log('  腾讯云 OCR 识别测试');
  console.log('  接口: GeneralAccurateOCR (高精度版)');
  console.log('═══════════════════════════════════════\n');

  // 读取图片
  const imageBuffer = fs.readFileSync(imagePath);
  const imageBase64 = imageBuffer.toString('base64');
  const fileSizeKB = (imageBuffer.length / 1024).toFixed(1);
  console.log(`📷 图片文件: ${path.basename(imagePath)}`);
  console.log(`📏 文件大小: ${fileSizeKB} KB`);
  console.log(`🔗 Base64 长度: ${imageBase64.length} 字符\n`);
  console.log('⏳ 正在调用腾讯云 OCR API...\n');

  try {
    const result = await callOcr(imageBase64);

    if (result.Response.Error) {
      console.error('❌ API 错误:', JSON.stringify(result.Response.Error, null, 2));
      process.exit(1);
    }

    const textDetections = result.Response.TextDetections || [];
    const totalTextLines = textDetections.length;

    console.log('✅ 识别成功！');
    console.log(`📊 共检测到 ${totalTextLines} 行文字`);
    console.log(`🔄 图片旋转角度: ${result.Response.Angle?.toFixed(2)}°\n`);

    // 提取并分类
    const parsed = extractQuestionNumbers(textDetections);

    // 输出完整结果
    console.log('═══════════════════════════════════════');
    console.log('  完整识别结果');
    console.log('═══════════════════════════════════════\n');

    let questionCount = 0;
    let lastQuestionNum = 0;

    for (const item of parsed) {
      if (item.type === 'section') {
        console.log(`\n📌 【${item.label}】 ${item.text}  (置信度: ${item.confidence}%)`);
      } else if (item.type === 'question') {
        questionCount++;
        lastQuestionNum = item.number;
        const marker = item.confidence >= 90 ? '✅' : item.confidence >= 70 ? '⚠️' : '❌';
        console.log(`  ${marker} Q${item.number}: ${item.text}  [置信度: ${item.confidence}%]`);
      } else {
        // 只显示与题目相关的行（紧跟在题号后）
        if (lastQuestionNum > 0) {
          console.log(`     ↳ ${item.text}  [置信度: ${item.confidence}%]`);
        }
      }
    }

    // 统计
    console.log('\n═══════════════════════════════════════');
    console.log('  统计汇总');
    console.log('═══════════════════════════════════════');
    console.log(`📝 总文字行数: ${totalTextLines}`);
    console.log(`🔢 检测到题号行: ${parsed.filter(p => p.type === 'question').length}`);
    console.log(`📂 检测到分区标题: ${parsed.filter(p => p.type === 'section').length}`);

    // 低置信度警告
    const lowConf = parsed.filter(p => p.confidence < 70);
    if (lowConf.length > 0) {
      console.log(`\n⚠️ 低置信度条目 (<70%): ${lowConf.length}`);
      for (const item of lowConf) {
        console.log(`   - [${item.confidence}%] ${item.text}`);
      }
    }

    // 输出原始 JSON 到文件便于分析
    const outputPath = path.join(__dirname, '..', 'output', 'tencent-ocr-result.json');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(result.Response, null, 2));
    console.log(`\n💾 完整 JSON 已保存: ${outputPath}`);

  } catch (err) {
    console.error('❌ 请求失败:', err.message);
    process.exit(1);
  }
}

main();
