/**
 * gaozhong.online - 两步对话式试卷分析 v3
 *
 * 版本：v3 (2026-05-04)
 * 改进：单次 API 调用，对话内两步链式推理
 *   Step 1 (assistant 引导)：精准错题定位 — 红笔铁律 + 笔迹分离
 *   Step 2：深度归因 — errorType + diagnosis + knowledgeGaps + remedy
 * 核心原则：蓝/黑=学生，红笔=教师权威，红笔字母=正确答案
 */

export const PAPER_ANALYZER_VERSION = 'v3';

/**
 * Step 1: 精准错题定位 Prompt
 * 只做一件事：根据红笔标记找出所有 studentAnswer ≠ correctAnswer 的题
 */
const STEP1_PROMPT = `你是试卷批改专家。你面前有两张图：
- 图1（原图）：印刷题号/题干/选项 + 蓝色/黑色手写（学生答案） + 红色笔迹（教师批改）
- 图2（红笔分离图）：只有红色笔迹，更清晰

═══════════════════════════════════════
【核心铁律 — 必须严格遵守】
═══════════════════════════════════════

铁律1: 蓝色/黑色笔迹 = 学生的原始答案
铁律2: 红色笔迹 = 教师的批改（权威正确答案）
铁律3: 学生原答 ≠ 红笔答案 → 错题，必须输出
铁律4: 红笔打 ✓ 且无重写 → 对题，跳过不输出
铁律5: 红笔写的字母 = 教师给的正确答案，不是学生答案

═══════════════════════════════════════
【红笔判定流程 — 逐题按此决策】
═══════════════════════════════════════

1. 先找学生的蓝色/黑色手写答案（通常在题号旁或括号内）
2. 再看红笔标记：
   - 红笔划叉/划掉 + 旁写新字母 → 被划=学生原选，旁写=正确答案
   - 红笔并列写"A B"或"A→B" → 左侧=学生，右侧=正确答案
   - 红笔在选项旁打 ✓ → 对题，不输出
   - 红笔写汉字（如"主谓一致""求婚"）→ 是知识点标签，不影响答案判定
   - 红笔圈出某选项 → 那个选项是正确答案
3. 判定：studentAnswer ≠ correctAnswer 就输出，否则跳过

═══════════════════════════════════════
【输出格式】只输出错题元数据，不分析：
═══════════════════════════════════════

直接输出 JSON 数组（不要其他文字，不要 markdown 包裹）：

[{
  "questionNumber": 24,
  "questionText": "完整题干文本",
  "options": {"A": "选项A", "B": "选项B", "C": "选项C", "D": "选项D"},
  "studentAnswer": "C",
  "correctAnswer": "A",
  "markType": "parallel",
  "evidence": "红笔并列书写A C，左侧为学生原选"
}]

字段说明：
- questionText: 完整题干，不要缩写
- options: 四选项完整文本，用{"A":"...","B":"...","C":"...","D":"..."}
- studentAnswer: 单个字母，学生蓝/黑色笔迹写的
- correctAnswer: 单个字母，红笔写的正确答案
- markType: "rewrite"/"parallel"/"circle"/"annotation"
- evidence: 一句话描述红笔判定依据

⚠️ 只输出 studentAnswer ≠ correctAnswer 的题
⚠️ 听力题/无题干题，questionText 可为空，照常输出
⚠️ 直接输出 JSON 数组，不要任何解释性文字`;

/**
 * Step 2: 深度归因 Prompt
 * 基于 Step 1 的错题列表，补充完整分析
 */
const STEP2_PROMPT = `现在对这些错题逐一进行深度归因分析。为每道错题补充以下字段，直接输出完整的 JSON 数组：

补充字段：
- errorType: 从以下选择最精准的 1-2 个标签：
  语法类：时态语态/主谓一致/从句引导词/非谓语动词/虚拟语气/倒装省略/强调句型
  词汇类：近形词辨析/近义词辨析/固定搭配/熟词生义/介词副词
  语篇类：逻辑关系/指代/上下文线索/长难句拆解
- diagnosis: 2-3句话分析学生错误原因，用"你可能是因为……"开头
- knowledgeGaps: ["具体薄弱知识点1", "具体薄弱知识点2"]，不要笼统
- remedy: 具体可执行的复习建议

输出已有的元数据 + 上述补充字段，打包为完整 JSON 数组。`;

/** Step 2 的第二段，构造为同一个 user message 的继续 */
const STEP2_CONTINUE = `现在请对以上错题进行深度归因，输出完整 JSON：
{ "wrongQuestions": [每道题含 questionNumber, questionText, options, studentAnswer, correctAnswer, markType, evidence, errorType, diagnosis, knowledgeGaps, remedy] }`;

/**
 * 构建消息数组
 */
export function buildAnalyzerMessages(subject) {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: STEP1_PROMPT },
        { type: 'text', text: '【图 1：试卷原图】' },
        { type: 'text', text: '【图 2：红笔分离图（只有红色批改标记）】' }
      ]
    },
    {
      role: 'assistant',
      content: '好的，我严格按照"红笔=教师正确答案，蓝黑笔=学生原答案"的铁律，逐一检查每道题的红笔标记。只输出学生答案与教师正确答案不一致的错题。'
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: STEP2_CONTINUE }
      ]
    }
  ];
}

/**
 * 后处理：硬过滤 studentAnswer == correctAnswer 的题
 * + 补全缺失的 analysis 字段
 */
export function postFilter(wrongQuestions) {
  return wrongQuestions
    .filter(q => {
      const sa = (q.studentAnswer || '').trim().toUpperCase();
      const ca = (q.correctAnswer || '').trim().toUpperCase();
      // 硬过滤：学生答案=正确答案的绝对不算错题
      if (sa && ca && sa === ca) return false;
      // 学生未作答也不纳入
      if (!sa) return false;
      return true;
    })
    .map(q => ({
      ...q,
      errorType: q.errorType || [],
      diagnosis: q.diagnosis || '',
      knowledgeGaps: q.knowledgeGaps || [],
      remedy: q.remedy || ''
    }));
}
