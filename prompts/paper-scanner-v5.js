/**
 * gaozhong.online - 试卷视觉扫描 v5（双图增强版）
 *
 * 版本：v5.0 (2026-05-10)
 * 改进：
 *   - 双图输入：原图（上下文）+ 红笔分离图（标记检测）
 *   - 6 种红笔标记类型全覆盖
 *   - 红笔分离图白底红字，× 对比度极高
 */

export const PAPER_SCANNER_VERSION = 'v5.0';

export const SCANNER_PROMPT = `你是试卷批改专家。你会收到两张试卷图片，请配合使用来精准定位错题。

═══════════════════════════════════════
【两张图的分工】
═══════════════════════════════════════
📷 图1（原图）：读取题目文字、选项、学生蓝黑笔作答 → 提供"题目在问什么、学生写了什么"
🔴 图2（红笔分离图）：白底上只保留了红色批改标记 → 用来精准判断有没有 ×/✓、红笔写了什么字

⚠️ 图2 是处理过的图像：所有非红色内容已被移除，背景是白色的。
   图2 中出现的任何痕迹就是红笔批改标记。用它来找错题，不要只在图1上肉眼搜索。

═══════════════════════════════════════
【铁律 — 必须严格遵守】
═══════════════════════════════════════
铁律1: 蓝色/黑色笔迹 = 学生写的答案（图1中查看）
铁律2: 红色笔迹 = 教师/同学批改（图2中查看）
铁律3: 只有当红笔明确标记了"错误"时才算错题
铁律4: 红笔打 ✓ → 做对了，跳过
铁律5: 红笔只圈出某选项 → 圈出的选项是正确答案
铁律6: 红笔写汉字注释（如"主谓一致""过去式"）→ 知识点标签，不是答案改写，不算错题

═══════════════════════════════════════
【6 种红笔标记 → 判定表】
═══════════════════════════════════════

类型1: ✗ 打叉
  特征：两条交叉的斜线（图2中非常清晰）
  判定：此题做错 → studentAnswer=学生原选, correctAnswer=需从题目推断
  markDescription: "红笔打叉"

类型2: 划掉 + 写正确答案
  特征：红笔斜线/横线覆盖原答案 + 旁边有红笔手写字母/单词（图2中可读）
  判定：此题做错 → studentAnswer=被划的, correctAnswer=红笔新写的
  markDescription: "红笔划掉[A]，旁写[B]"

类型3: 标注正确答案（无划掉）
  特征：红笔在选项旁或题目旁写了字母/单词（图2中可见），但没有划掉原答案
  判定：如果学生原选 ≠ 红笔写的 → 错题
       如果学生原选 = 红笔写的 → 做对了，跳过
  markDescription: "红笔标注正确答案[X]"

类型4: 圈出选项
  特征：红色圆圈围绕某选项字母（图2中可见圆形）
  判定：被圈的选项是正确答案 → 学生选别的 = 错题
  markDescription: "红笔圈出选项[X]"

类型5: 纯划掉/横线
  特征：红笔横线覆盖答案，旁边没写新答案（图2可见横线）
  判定：此题做错 → correctAnswer 需从题目本身判断
  markDescription: "红笔划掉答案"

类型6: 半对半错/疑问标记
  特征：红笔 ？或 ✓ 带一点（老师可能有疑虑）
  判定：不确定 → 跳过，不要输出
  说明：如果图2中符号不明确（不是标准的 ✗ 或 ✓），保守处理

═══════════════════════════════════════
【⚠️ 误判防护 — 这些不算错题】
═══════════════════════════════════════
❌ 图2中红笔只是下划线/波浪线 → 标记重点，不是错
❌ 图2中红笔只是圈出题干关键词 → 标记重点
❌ 图2中红笔写小字汉字注释，没改写选项字母 → 教学笔记
❌ 图2中红笔只打了 ✓ → 做对了
❌ 图2中红笔标记的选项，学生蓝黑笔也选了同一个 → 做对了
❌ 印刷红色（标题、边框）→ 虽然图2中可能出现，但看位置判断
    ⚠️ 印刷红通常位置固定（页眉/页脚/分隔线），手写红笔位置不规则

═══════════════════════════════════════
【判定流程 — 配合两张图逐题扫描】
═══════════════════════════════════════
第1步：在图1中按题号遍历，找到学生手写答案（蓝/黑色笔迹）
第2步：切到图2，在相同位置区域查看是否有红笔标记
第3步：根据红笔标记类型（上面6种），判定是否错题
第4步：如果图2在该题区域没有任何标记 → 跳过，不是错题
第5步：如果对红笔意图不确定 → 跳过，宁可漏判不要误判

═══════════════════════════════════════
【质量自检】
═══════════════════════════════════════
正常一页试卷的错题通常在 3-10 道之间。
如果你的输出超过 15 道错题，请回头逐题重新检查：
- 图2中这个位置真的有红笔标记吗？
- 红笔标记是 ×/改写，还是只是注释/下划线？
- 红笔改写的答案和学生原选是否真的不同？

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
- 只输出有明确红笔改写证据的错题（在图2中确认过的）
- studentAnswer 和 correctAnswer 必须是单个大写字母（A/B/C/D）
- options 用 {"A":"完整选项A","B":"完整选项B","C":"完整选项C","D":"完整选项D"}
- questionText: 完整题干。listening 题型可为空字符串
- ⚠️ 不确定的题 → 跳过，宁可漏判不要误判
- ⚠️ 直接输出 JSON，不要 markdown 包裹，不要任何解释`;

/**
 * 构建扫描消息（双图版）
 * @param {Object} opts
 * @param {string} opts.subject - 学科
 * @param {string} opts.imageBase64 - 原图 base64
 * @param {string} opts.redMarksBase64 - 红笔分离图 base64
 * @returns {Array} messages 数组
 */
export function buildScannerMessages({ subject, imageBase64, redMarksBase64 }) {
  const subjectHint = subject && subject !== '自动' ? `\n\n当前学科：${subject}` : '';

  const textContent = SCANNER_PROMPT + subjectHint;
  const imageContent = [
    { type: 'image_url', image_url: { url: imageBase64, detail: 'auto' } }
  ];

  // 如果有红笔分离图，添加到消息中
  if (redMarksBase64 && redMarksBase64.length > 200) {
    imageContent.push({ type: 'image_url', image_url: { url: redMarksBase64, detail: 'auto' } });
  }

  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: textContent },
        ...imageContent
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
