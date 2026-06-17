/**
 * gaozhong.online - OCR 文本提取器
 *
 * 调用预处理微服务，提取：
 *   1. PaddleOCR 版面分析文本（印刷+手写）
 *   2. 红笔像素区域（用于检测哪道题有批改标记）
 *   3. 红笔分离图 base64（供 VL 标记读取用）
 *
 * 输出：结构化的题目文本块 + 红笔区域坐标
 */

const PREPROCESS_URL = process.env.PREPROCESS_URL || 'http://172.17.0.1:5001';

/**
 * 调用预处理微服务
 */
async function callPreprocess(imageBase64, options = {}) {
  const res = await fetch(`${PREPROCESS_URL}/preprocess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: imageBase64,
      options: { deskew: true, red: true, blue: false, layout: true, ...options }
    }),
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`预处理返回 ${res.status}`);
  const data = await res.json();
  if (data.status !== 'ok') throw new Error(data.error || '预处理失败');
  return data;
}

/**
 * 将 PaddleOCR 文本块按 Y 坐标分组为题目块
 *
 * 策略：相邻 Y 坐标差 < 阈值 → 同一题组
 *       遇到新题号（数字开头 + 位置靠左）→ 新题开始
 */
function groupTextBlocks(layoutBlocks) {
  if (!layoutBlocks || layoutBlocks.length === 0) return [];

  // 按 Y 坐标排序
  const sorted = [...layoutBlocks].sort((a, b) => a.y - b.y || a.x - b.x);

  const groups = [];
  let currentGroup = null;
  const Y_GAP = 25; // Y 间距阈值（像素）

  for (const block of sorted) {
    if (block.confidence < 0.3) continue; // 跳过低置信度

    const text = block.text.trim();
    if (!text) continue;

    // 检测是否是新题开始：数字开头 + 靠左（x < 200）
    const isNewQuestion = /^\d+[\.\、\s]/.test(text) && block.x < 200;

    if (isNewQuestion || !currentGroup) {
      if (currentGroup && currentGroup.texts.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = {
        y: block.y,
        yEnd: block.y + block.height,
        texts: [text],
        blocks: [block],
        questionNumber: parseInt(text.match(/^(\d+)/)?.[1]) || null
      };
    } else if (Math.abs(block.y - currentGroup.yEnd) < Y_GAP * 2) {
      // 同一题目区域：连续文本
      currentGroup.texts.push(text);
      currentGroup.blocks.push(block);
      currentGroup.yEnd = Math.max(currentGroup.yEnd, block.y + block.height);
    } else {
      // 距离太远 → 新题目
      if (currentGroup.texts.length > 0) groups.push(currentGroup);
      currentGroup = {
        y: block.y,
        yEnd: block.y + block.height,
        texts: [text],
        blocks: [block],
        questionNumber: parseInt(text.match(/^(\d+)/)?.[1]) || null
      };
    }
  }
  if (currentGroup && currentGroup.texts.length > 0) groups.push(currentGroup);

  return groups;
}

/**
 * 从题目文本块中提取结构化信息
 */
function parseQuestionBlock(group) {
  const fullText = group.texts.join(' ');
  const blocks = group.blocks;

  // 尝试识别题型
  let questionType = '未知';
  if (/[A-D]\s*[\.\、]/.test(fullText)) questionType = '选择题';
  else if (/填空|___|（）/.test(fullText)) questionType = '填空题';
  else if (/判断|正确.*错误|对.*错/.test(fullText)) questionType = '判断题';
  else if (/解答|证明|计算|求解/.test(fullText)) questionType = '解答题';
  else if (/阅读|理解|passage/i.test(fullText)) questionType = '阅读理解';
  else if (/实验|图示|图\d/.test(fullText)) questionType = '实验题';

  // 提取选项（选择题）
  const options = [];
  const optionPattern = /([A-D])\s*[\.\、\s]\s*([^A-D\n]+?)(?=\s*[A-D]\s*[\.\、\s]|$)/g;
  let m;
  while ((m = optionPattern.exec(fullText)) !== null) {
    options.push(`${m[1]}. ${m[2].trim()}`);
  }

  // 提取题目文本（第一个文本块通常是题目）
  const questionText = group.texts[0] || fullText;

  return {
    questionNumber: group.questionNumber,
    questionType,
    questionText,
    options,
    rawText: fullText,
    y: group.y,
    yEnd: group.yEnd,
    blocks
  };
}

/**
 * 分析红笔像素区域（从红笔分离图检测哪些 Y 区域有红笔标记）
 * 注意：这个函数在 Node.js 中无法直接处理图像像素
 * 改用预处理返回的 red_marks 图像数据 + layout 坐标匹配
 *
 * 替代方案：通过 PaddleOCR 布局分析中红笔区域的文本内容来判断
 * 或者通过 VL 标记读取来获取红笔标记位置
 */
function analyzeRedInkRegions(layoutBlocks, redMarksPresent) {
  // 简化版本：如果有 red_marks 图像不为空，标记为存在红笔
  // 精确的红笔→题目匹配由 VL mark-reader 完成
  return { hasRedInk: redMarksPresent };
}

/**
 * 主入口：提取一页试卷的结构化信息
 *
 * @param {string} imageBase64 - 试卷图片 base64
 * @param {number} pageIndex - 页码索引
 * @returns {Object} { pageIndex, questions, redMarksBase64, correctedBase64, layoutRaw }
 */
export async function extractPage(imageBase64, pageIndex) {
  const result = await callPreprocess(imageBase64);

  const layoutBlocks = result.result.layout || [];
  const redMarksBase64 = result.result.red_marks || null;
  const correctedBase64 = result.result.corrected || imageBase64;
  const hasRedInk = !!(redMarksBase64 && redMarksBase64.length > 200);

  // 诊断日志
  const imgSize = result.image_size || {};
  if (layoutBlocks.length === 0) {
    console.warn(`[ocr-extractor] 页${pageIndex}: PaddleOCR 零文本 | 尺寸:${imgSize.width}x${imgSize.height} | red:${hasRedInk} | layoutCount:${result.result.layout_count || 0}`);
  }

  // 分组题目
  const groups = groupTextBlocks(layoutBlocks);
  const questions = groups.map(parseQuestionBlock);

  return {
    pageIndex,
    questions,
    redMarksBase64,
    correctedBase64,
    hasRedInk,
    layoutRaw: layoutBlocks,
    imageSize: result.image_size
  };
}

/**
 * 将多页红笔分离图垂直拼接为一张长图
 * （暂时用 base64 列表表示，实际拼接在调用 VL 前完成）
 */
export function collectRedMarkImages(pageResults) {
  return pageResults
    .filter(p => p.hasRedInk)
    .map(p => p.redMarksBase64);
}

export { callPreprocess, groupTextBlocks, parseQuestionBlock, analyzeRedInkRegions };
