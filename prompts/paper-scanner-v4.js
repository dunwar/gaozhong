/**
 * gaozhong.online - 试卷视觉扫描 v4
 *
 * 版本：v4 (2026-05-06)
 * 定位：纯视觉扫描，只做"定位+判定"，不做知识分析
 *
 * 核心改进（vs v3）：
 *   - 单图输入（仅原图），移除红笔分离图，消除双图交叉引用导致的 VL 幻觉
 *   - 任务极简：只输出错题列表（号+文+选+生答+正答+标记描述）
 *   - 不做 errorType/diagnosis/knowledgeGaps/remedy — 交给 DeepSeek 阶段
 *   - 新增题型分类：standard / listening / reading
 *   - 阅读理解：提取文章全文，关联题目
 */

export const PAPER_SCANNER_VERSION = 'v4';

export const SCANNER_PROMPT = `你是试卷批改专家。请看这张试卷图片，逐题扫描，找出所有做错的题目。

═══════════════════════════════════════
【铁律 — 必须严格遵守】
═══════════════════════════════════════
铁律1: 蓝色/黑色笔迹 = 学生写的答案
铁律2: 红色笔迹 = 教师的批改（红笔 = 权威正确答案）
铁律3: 学生答案 ≠ 红笔答案 → 错题，必须输出
铁律4: 红笔打 ✓ 且无改写 → 做对了，跳过
铁律5: 红笔圈出某选项 → 该选项是正确答案
铁律6: 红笔写汉字注释（如"主谓一致""过去式""求婚"）→ 是知识点标签，不影响答案判定
铁律7: 完全无红笔标记的题目 → 做对了，跳过
铁律8: 学生未作答但有红笔标记 → 算错题，correctAnswer 填红笔所标字母

═══════════════════════════════════════
【判断流程 — 逐题扫描，不要遗漏】
═══════════════════════════════════════
1. 找到每个题号（21, 22, 23…），按数字顺序扫描
2. 看学生答案（蓝色/黑色笔迹，通常在题号旁、括号内或选项旁）
3. 看红笔标记：
   - 红笔划掉学生答案 + 旁写新字母 → 被划=学生原选，旁写=正确答案
   - 红笔只打叉 ✗ 没写新字母 → 学生答错了，correctAnswer 根据题目本身判断
   - 红笔打勾 ✓ → 做对了，跳过
   - 红笔只写了一个字母（如 B）→ 那是正确答案
4. 判定题型：
   - standard: 有完整题干文字
   - listening: 只有题号+选项，题干空白（听力题，原文不印在卷上）
   - reading: 题目引用了卷面上的阅读理解文章

═══════════════════════════════════════
【阅读理解处理】
═══════════════════════════════════════
如果页面上有阅读理解文章（一大段英文/中文 + 多道题），请：
1. 在 passageText 字段中提取文章全文
2. 所有属于该阅读的题目标记为 questionType: "reading"
3. 题目题干（questionText）可以只写题号附近的问题文字

═══════════════════════════════════════
【输出格式 — 严格纯 JSON】
═══════════════════════════════════════

{
  "passageText": "（如有阅读理解文章则提取全文，否则为空字符串）",
  "errors": [
    {
      "questionNumber": 24,
      "questionText": "完整题干文本",
      "questionType": "standard",
      "options": {"A": "选项A", "B": "选项B", "C": "选项C", "D": "选项D"},
      "studentAnswer": "B",
      "correctAnswer": "D",
      "markDescription": "红笔划掉学生选的B，旁写D"
    }
  ]
}

═══════════════════════════════════════
【输出规则】
═══════════════════════════════════════
- 只输出 studentAnswer ≠ correctAnswer 的题
- 确保 studentAnswer 和 correctAnswer 都是单个大写字母（A/B/C/D）
- options 用 {"A":"…","B":"…","C":"…","D":"…"} 格式，四选项完整文本
- questionText: 完整题干，不要缩写。listening 题型可为空字符串
- markDescription: 一句话描述红笔标记的具体形式
- passageText: 阅读理解文章全文；没有则为空字符串
- ⚠️ 直接输出 JSON，不要 markdown 代码块包裹，不要任何解释文字`;

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
 * 后处理：硬过滤 + 分类
 */
export function postFilter(errors) {
  return errors
    .filter(q => {
      const sa = (q.studentAnswer || '').trim().toUpperCase();
      const ca = (q.correctAnswer || '').trim().toUpperCase();
      // 硬过滤：学生答案=正确答案的绝对不算错题
      if (sa && ca && sa === ca) return false;
      // 学生未作答但无红笔标记 → 可能是漏判，保留（红笔标记可能不明显）
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
