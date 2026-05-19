/**
 * 按坐标分栏整理 OCR 结果
 */
const data = require('../output/tencent-ocr-result.json');
const lines = data.TextDetections || [];

// 保存完整结果到文件
const fs = require('fs');
const path = require('path');

// 按 X 坐标分栏：根据图片布局，题目在左侧列(Paper I)和右侧列
// 旋转后图像 1707x1280，文字区域 X ~100到~1500
// 观察：左侧题目 X 在 100-700 范围，右侧题目 X 在 980-1500 范围
// 中间的 X~750-950 是两栏之间的缝隙

function getColumn(x) {
  if (x < 800) return 'left';
  if (x >= 800) return 'right';
  return 'middle';
}

const leftCol = [];
const rightCol = [];

for (const item of lines) {
  const poly = item.Polygon || [];
  const x = poly.length > 0 ? poly[0].X : 0;
  const y = poly.length > 0 ? poly[0].Y : 0;
  const col = getColumn(x);
  
  const entry = { x, y, text: item.DetectedText, confidence: item.Confidence };
  if (col === 'left') leftCol.push(entry);
  else rightCol.push(entry);
}

// 按 Y 坐标排序每栏
leftCol.sort((a, b) => a.y - b.y);
rightCol.sort((a, b) => a.y - b.y);

console.log('═══════════════════════════════════════');
console.log('  腾讯云 OCR - 分栏识别结果');
console.log('  yingyu34 (4a96c145) 英语试卷');
console.log('═══════════════════════════════════════\n');

// ========== 输出左栏 ==========
console.log('┌─────────────────────────────────────┐');
console.log('│  📍 左栏 (Paper I - 阅读理解)         │');
console.log('├─────────────────────────────────────┤');
let lastY = 0;
let questionNum = 0;

for (const item of leftCol) {
  const gap = item.y - lastY;
  if (gap > 50 && lastY > 0) console.log('│');  // 大间距=新题目
  
  // 检测题号
  const qMatch = item.text.match(/^(\d{1,3})[\.\)、]/);
  if (qMatch) {
    questionNum = parseInt(qMatch[1]);
    console.log(`│  Q${questionNum}. ${item.text}  [${item.confidence}%]`);
  } else if (item.text.match(/^[A-D][\.\s]/)) {
    console.log(`│    ${item.text}  [${item.confidence}%]`);
  } else {
    console.log(`│    ${item.text}  [${item.confidence}%]`);
  }
  
  lastY = item.y;
}
console.log('└─────────────────────────────────────┘\n');

// ========== 输出右栏 ==========
console.log('┌─────────────────────────────────────┐');
console.log('│  📍 右栏 (Paper II - Grammar & Vocab) │');
console.log('├─────────────────────────────────────┤');
lastY = 0;
questionNum = 0;

for (const item of rightCol) {
  const gap = item.y - lastY;
  if (gap > 50 && lastY > 0) console.log('│');
  
  const qMatch = item.text.match(/^(\d{1,3})[\.\)、]/);
  if (qMatch) {
    questionNum = parseInt(qMatch[1]);
    console.log(`│  Q${questionNum}. ${item.text}  [${item.confidence}%]`);
  } else if (item.text.match(/^[A-D][\.\s]/)) {
    console.log(`│    ${item.text}  [${item.confidence}%]`);
  } else {
    console.log(`│    ${item.text}  [${item.confidence}%]`);
  }
  
  lastY = item.y;
}
console.log('└─────────────────────────────────────┘\n');

// ========== 统计 ==========
console.log('═══════════════════════════════════════');
console.log('  统计汇总');
console.log('═══════════════════════════════════════');
console.log(`总文字行: ${lines.length}`);
console.log(`左栏行数: ${leftCol.length}`);
console.log(`右栏行数: ${rightCol.length}`);

// 低置信度
const lowConf = lines.filter(l => l.Confidence < 70);
if (lowConf.length > 0) {
  console.log(`\n⚠️ 低置信度 (<70%): ${lowConf.length}条`);
  lowConf.forEach(l => console.log(`  [${l.Confidence}%] ${l.DetectedText}`));
}

// 关键词统计
const allText = lines.map(l => l.DetectedText).join(' ');
const questionMatches = allText.match(/\b(\d{1,3})[\.\)、]/g) || [];
console.log(`\n检测到题号标记: ${questionMatches.length}个`);
console.log('题号列表:', [...new Set(questionMatches)].sort().join(', '));
