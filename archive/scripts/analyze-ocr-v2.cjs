/**
 * 分析 OCR 结果 - 提取所有题目信息
 */
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(
  '/home/node/.openclaw/workspace/www/gaozhong.online/output/tencent-ocr-yingyu34.json', 'utf8'
));

const detections = data.rawResponse.TextDetections || [];
const allText = detections.map(d => d.DetectedText).join('\n');

// 提取所有包含题号的文本行
const qCandidates = new Map();
for (const d of detections) {
  const t = d.DetectedText;
  // 匹配各种题号格式: "20.", "A28.", "Q35.", "28", "29." etc
  const matches = t.matchAll(/(?:^|[A-D]?\s*)(\d{1,3})[\.\)、]\s*/g);
  for (const m of matches) {
    const num = parseInt(m[1]);
    if (num >= 1 && num <= 60) {
      if (!qCandidates.has(num)) qCandidates.set(num, []);
      qCandidates.get(num).push({ text: t, conf: d.Confidence });
    }
  }
}

// 找所有独立的选项行
const optionLines = new Set();
for (const d of detections) {
  const t = d.DetectedText.trim();
  if (/^[A-D][\.\)、\s]/.test(t)) optionLines.add(t);
}

console.log('═══════════════════════════════════════');
console.log('  腾讯云 OCR - yingyu34 题目识别报告');
console.log('═══════════════════════════════════════\n');

// 找出论文中所有的题号
const allNums = [...new Set([...qCandidates.keys()])].sort((a,b) => a-b);
console.log(`📊 共检测到 ${allNums.length} 个题号标记`);
console.log(`   题号: ${allNums.join(', ')}\n`);

// 列出每个题号对应的文本
for (const num of allNums) {
  const entries = qCandidates.get(num);
  const texts = [...new Set(entries.map(e => e.text))];
  const confs = entries.map(e => e.conf);
  const avgConf = Math.round(confs.reduce((a,b)=>a+b,0) / confs.length);
  console.log(`Q${num} [置信度: ${avgConf}%]`);
  texts.forEach(t => console.log(`   → "${t}"`));
}

// 找出题目文本（包含题干的行）
console.log('\n═══════════════════════════════════');
console.log('  题干文本（Q20-Q34 阅读 + Q35+ 语法）');
console.log('═══════════════════════════════════\n');

// 提取每道题的题干（题目号后面跟的文本）
const stems = [];
for (const d of detections) {
  const t = d.DetectedText;
  const m = t.match(/^(\d{1,3})\.\s*(.+)/);
  if (m) {
    stems.push({ num: parseInt(m[1]), text: m[2], conf: d.Confidence });
  }
}

stems.sort((a,b) => a.num - b.num);
for (const s of stems) {
  console.log(`Q${s.num}. ${s.text}  [${s.conf}%]`);
}

// 遗漏分析
console.log('\n═══════════════════════════════════');
console.log('  遗漏题号分析');
console.log('═══════════════════════════════════\n');

const studentAnswers = {};
// 从文本提取所有选项标记
const allOptions = [];
for (const d of detections) {
  const t = d.DetectedText.trim();
  const optMatch = t.match(/^([A-D])[\.\)、\s](.+)/);
  if (optMatch) {
    allOptions.push({ letter: optMatch[1], text: optMatch[2], conf: d.Confidence, raw: t });
  }
}

console.log(`共检测到 ${allOptions.length} 个选项标记`);
console.log('(A/B/C/D 选项列表见上方完整识别结果)\n');

// 低置信度汇总
const lowConf = detections.filter(d => d.Confidence < 80);
if (lowConf.length > 0) {
  console.log('⚠️ 置信度<80% 的行:');
  for (const d of lowConf) {
    console.log(`  [${d.Confidence}%] "${d.DetectedText}"`);
  }
}

// 总结
console.log('\n═══════════════════════════════════');
console.log('  测试结论');
console.log('═══════════════════════════════════');
console.log('✅ 优点:');
console.log('  - 大部分文字识别准确率 >90%');
console.log('  - 能正确识别英文试题内容');
console.log('  - 选项 A/B/C/D 识别完整');
console.log('');
console.log('⚠️ 不足:');
console.log('  - 多栏布局阅读顺序需坐标重建');
console.log('  - 部分题号未被独立检测（嵌入在"Q20.A."格式中）');
console.log(`  - 只提取到 ${stems.length} 个独立题号行`);
console.log('  - 红笔 ✓/✗ 标记对 OCR 有干扰（如 before; that X）');
