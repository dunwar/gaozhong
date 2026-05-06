/**
 * gaozhong.online - 试卷视觉扫描 v4.1
 *
 * 版本：v4.1 (2026-05-06)
 * 改进：
 *   - 强化误判防护：红笔注释 ≠ 批改标记，不确定时宁可跳过
 *   - 增加过度判定自检：超过 15 题提示复查
 */

export const PAPER_SCANNER_VERSION = 'v4.1';

export const SCANNER_PROMPT = `你是试卷批改专家。请看这张试卷图片，逐题扫描学生做错的题目。

═══════════════════════════════════════
【铁律 — 必须严格遵守】
═══════════════════════════════════════
铁律1: 蓝色/黑色笔迹 = 学生写的答案
铁律2: 红色笔迹 = 教师批改
铁律3: 只有当红笔明确"改写了学生答案"时才算错题
铁律4: 红笔打 ✓ → 做对了，跳过
铁律5: 红笔只圈出某选项 → 圈出的选项 是正确答案（如果学生选了被圈的选项 → 做对了；如果学生选了其他 → 做错了）
铁律6: 红笔写汉字注释（如"主谓一致""过去式""affirmative"）→ 是知识点标签，不是答案，不影响判定

═══════════════════════════════════════
【⚠️ 误判防护 — 这些情况不算错题】
═══════════════════════════════════════
❌ 红笔仅下划线/波浪线 → 只是标记重点，不是批改
❌ 红笔仅圈出题干关键词 → 只是标记重点
❌ 红笔在旁边写小字注释（汉字/英文）但没有改写选项字母 → 这是教学笔记
❌ 红笔在选项旁打点/画线但没有写新字母 → 不确定意图，跳过
❌ 印刷体（非手写）的红色文字 → 可能是试卷原题，不是批改

═══════════════════════════════════════
【判定流程 — 逐题扫描】
═══════════════════════════════════════
第1步：找到题号，确定学生手写答案（蓝/黑色笔迹）
第2步：看红笔做了什么：
  ▸ 红笔划掉或打叉 + 在旁边写了新字母（如 B→划掉写C）→ 错题！原选=被划的，正答=新写的
  ▸ 红笔明确打叉 ✗ 且没写新字母 → 错题！但 correctAnswer 需根据题目本身判断
  ▸ 红笔只打勾 ✓ → 做对了，跳过
  ▸ 红笔只写了注释（汉字/单词），没有改写字母 → 不是错题，跳过
  ▸ 红笔只是划线/圈词，没有改写答案 → 跳过
第3步：判定 studentAnswer 和 correctAnswer
第4步：如果对红笔意图不确定 → 跳过，不要输出

═══════════════════════════════════════
【质量自检】
═══════════════════════════════════════
正常一页试卷的错题通常在 3-10 道之间。
如果你的输出超过 15 道错题，请回头逐题重新检查：
- 这道题的红笔真的改变了学生答案吗？
- 还是只是标记重点/注释知识点？
- 学生选的是蓝色/黑色笔迹，红笔写的是正确答案吗？

═══════════════════════════════════════
【题型分类】
═══════════════════════════════════════
- standard: 有完整题干文字
- listening: 只有题号+选项，题干空白（听力题）
- reading: 题目引用了卷面上的阅读理解文章

═══════════════════════════════════════
【阅读理解处理】
═══════════════════════════════════════
如果页面上有阅读理解文章（一大段文字 + 多道题）：
1. 在 passageText 字段中提取文章全文
2. 所有属于该阅读的题目标记为 questionType: "reading"

═══════════════════════════════════════
【输出格式 — 严格纯 JSON】
═══════════════════════════════════════

{
  "passageText": "（阅读理解文章全文，没有则为空字符串）",
  "errors": [
    {
      "questionNumber": 24,
      "questionText": "完整题干文本",
      "questionType": "standard",
      "options": {"A": "选项A", "B": "选项B", "C": "选项C", "D": "选项D"},
      "studentAnswer": "B",
      "correctAnswer": "D",
      "markDescription": "红笔划掉B，旁写D"
    }
  ]
}

═══════════════════════════════════════
【输出规则】
═══════════════════════════════════════
- 只输出有明确红笔改写证据的错题
- studentAnswer 和 correctAnswer 必须是单个大写字母（A/B/C/D）
- options 用 {"A":"完整选项A","B":"完整选项B","C":"完整选项C","D":"完整选项D"}
- questionText: 完整题干。listening 题型可为空字符串
- ⚠️ 不确定的题 → 跳过，宁可漏判不要误判
- ⚠️ 直接输出 JSON，不要 markdown 包裹，不要任何解释`;

/**
 * 构建扫描消息（单图，单次调用）
 */
export function buildScannerMessages({ subject, imageBase64 }) {
  const subjectHint = subject && subject !== '自动' ? `\n\n当前学科：${subject}` : '';
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: SCANNER_PROMPT + subjectHint },
        { type: 'image_url', image_url: { url: imageBase64, detail: 'high' } }
      ]
    }
  ];
}

/**
 * 后处理：硬过滤 + 异常检测
 * @returns {{ errors: [], warning: string|null }}
 */
export function postFilter(errors, pageIndex) {
  const rawCount = errors.length;

  const filtered = errors
    .filter(q => {
      const sa = (q.studentAnswer || '').trim().toUpperCase();
      const ca = (q.correctAnswer || '').trim().toUpperCase();
      // 硬过滤：学生答案=正确答案的绝对不算错题
      if (sa && ca && sa === ca) return false;
      // 学生未作答但无红笔标记 → 过滤掉
      if (!sa && !ca) return false;
      return true;
    })
    .map(q => ({
      questionNumber: q.questionNumber,
      questionText: q.questionText || '',
      questionType: q.questionType || 'standard',
      options: q.options || {},
      studentAnswer: (q.studentAnswer || '').trim().toUpperCase(),
      correctAnswer: (q.correctAnswer || '').trim().toUpperCase(),
      markDescription: q.markDescription || ''
    }));

  // 异常检测：单页超过 15 题可能误判
  let warning = null;
  if (filtered.length > 15) {
    warning = `第${pageIndex || '?'}页识别到 ${filtered.length} 道错题（原始 ${rawCount}），超过正常范围，可能存在误判，请人工复核`;
  }

  return { errors: filtered, warning };
}

/**
 * 按题型分类错题
 * @returns {{ standard: [], listening: [], reading: [] }}
 */
export function classifyErrors(errors) {
  const standard = [];
  const listening = [];
  const reading = [];
  for (const q of errors) {
    switch (q.questionType) {
      case 'listening': listening.push(q); break;
      case 'reading': reading.push(q); break;
      default: standard.push(q);
    }
  }
  return { standard, listening, reading };
}
