/**
 * gaozhong.online - 智能合并器
 *
 * 输入：
 *   - PaddleOCR 提取的题目文本块（含题号、题目、选项）
 *   - VL 读取的批改标记列表（含题号、标记类型、正确答案）
 *
 * 输出：
 *   - 精确的错题列表（含完整题目信息、学生作答、正确答案）
 *   - 全量题目列表（含对错状态）
 *
 * 合并策略：
 *   1. 按题号匹配 OCR 文本块 ↔ VL 标记
 *   2. VL 标记中的 ✗/×/-N → isCorrect=false
 *   3. VL 标记中的 ✓/√ → isCorrect=true
 *   4. VL 标记中的 correctAnswer → 覆盖 OCR 中的答案
 *   5. 没有 VL 标记的题目 → isCorrect=true（无红笔=正确）
 */

/**
 * 合并 OCR 题目数据与 VL 标记数据
 *
 * @param {Array} pages - extractPage 输出的页面数组 [{pageIndex, questions}]
 * @param {Array} marks - VL 输出的标记数组 [{questionNumber, mark, correctAnswer, extraInfo}]
 * @returns {Object} { allQuestions, wrongQuestions, correctCount, wrongCount, unansweredCount }
 */
export function mergeResults(pages, marks) {
  // 展平所有页面的题目
  const allQuestions = [];
  for (const page of pages) {
    for (const q of page.questions) {
      allQuestions.push({ ...q, pageIndex: page.pageIndex, isCorrect: true, isUnanswered: false });
    }
  }

  // 建立题号 → 标记映射
  const markMap = new Map();
  for (const m of marks) {
    markMap.set(m.questionNumber, m);
  }

  // 应用标记
  for (const q of allQuestions) {
    if (!q.questionNumber) continue;

    const mark = markMap.get(q.questionNumber);
    if (!mark) {
      // 无标记 → 正确
      q.isCorrect = true;
      q.gradingMark = '无标记';
      q.hasRedInk = false;
      q.redInkContent = '';
      q.confidence = 'medium';
      continue;
    }

    // 有标记 → 按标记类型判断
    const markType = mark.mark || '';
    const isWrongMark = /[✗×xX]/.test(markType) || markType === 'REWRITE' || /^-\d/.test(markType);
    const isCorrectMark = /[✓√]/.test(markType);
    const isCircle = /[○⭕]/.test(markType);

    q.gradingMark = markType;
    q.hasRedInk = true;
    q.redInkContent = [markType, mark.correctAnswer, mark.extraInfo].filter(Boolean).join(' ');
    q.confidence = 'high';

    if (isWrongMark || isCircle) {
      q.isCorrect = false;
      q.isUnanswered = false;
      if (mark.correctAnswer) {
        q.correctAnswer = mark.correctAnswer;
        // 如果 OCR 选项中有匹配项，规范化
        if (q.options?.length > 0) {
          const matched = q.options.find(o => o.startsWith(mark.correctAnswer + '.'));
          if (matched) q.correctAnswer = matched;
        }
      }
    } else if (isCorrectMark) {
      q.isCorrect = true;
    } else {
      // 有其他标记但不明确 → 保守判错
      q.isCorrect = false;
      q.confidence = 'low';
    }

    // 提取学生作答（从 OCR 文本块中推断）
    if (!q.studentAnswer && q.blocks?.length > 1) {
      // 选项后的文本可能是学生选择
      for (const b of q.blocks.slice(1)) {
        const t = b.text.trim();
        if (/^[A-D]$/.test(t)) {
          q.studentAnswer = t;
          break;
        }
      }
    }
  }

  // 分类
  const wrongQuestions = allQuestions.filter(q => !q.isCorrect);
  const answeredQuestions = allQuestions.filter(q => q.studentAnswer && q.studentAnswer !== '');
  const unanswered = allQuestions.filter(q => q.isUnanswered || (!q.studentAnswer && !q.isCorrect));

  return {
    allQuestions,
    wrongQuestions,
    correctCount: allQuestions.length - wrongQuestions.length,
    wrongCount: wrongQuestions.length,
    unansweredCount: unanswered.length,
    answeredCount: answeredQuestions.length
  };
}

/**
 * 为 DeepSeek 分析准备错题数据
 * 按 paper-analysis-v4 期望的格式
 */
export function prepareErrorList(wrongQuestions) {
  return wrongQuestions.map(q => ({
    questionNumber: q.questionNumber,
    questionType: q.questionType || '未知题型',
    questionText: q.questionText || q.rawText || '',
    options: q.options || [],
    studentAnswer: q.studentAnswer || '',
    correctAnswer: q.correctAnswer || '',
    gradingMark: q.gradingMark || '',
    redInkContent: q.redInkContent || '',
    confidence: q.confidence || 'high'
  }));
}
