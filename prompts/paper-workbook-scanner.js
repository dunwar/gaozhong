/**
 * gaozhong.online - 错题整理扫描器 v1
 *
 * 版本：v1.0 (2026-05-11)
 * 
 * 定位变更：
 *   - 旧名「错题诊断」→ 新名「错题整理」
 *   - 不做批改（学校/学生自己做），只做「阅读已有批改 → 判定对错 → 整理错题」
 *
 * 架构：
 *   - 阶段1：双图单次 VL → 红笔标记 + 题目区域识别
 *   - 阶段2：逐题裁剪双图判错（引用判定规则引擎）
 *   - 阶段3：DeepSeek 深度分析（不变）
 *
 * 逻辑文件引用：
 *   - subject-logic/error-identification-logic.md  — 错题判定规则引擎（决策树）
 *   - subject-logic/english-shanghai-gaokao.md       — 英语科目题型+批改约定
 */

export const PAPER_WORKBOOK_VERSION = 'v1.0';

// ═══════════════════════════════════════
// 内嵌判定规则摘要（同步自 error-identification-logic.md）
// ═══════════════════════════════════════

const ERROR_LOGIC_RULES = `
## 批改标记 → 对错判定（按优先级）

1. 红笔 ✗ 打叉 → ❌ 错题
2. 红笔划掉/覆盖学生原答案 → ❌ 错题
3. 红笔写了正确答案字母（非学生笔迹）且不同于学生原选 → ❌ 错题
4. 红笔扣分标记（如 "-2"）→ ❌ 错题
5. 红笔 ✓ 打勾 → ✅ 对
6. 红笔只圈出/下划线/写注释（无✗无更正）→ ✅ 对（标记重点，非判错）
7. 此题无任何红笔标记 → ✅ 对

⚠️ 核心原则：
- 红笔写正确答案 ≠ 红笔打✗：如果红笔只是写了选项字母但没打✗，
  要对比学生原选——不同则错，相同则对
- 不确定红笔意图 → 按"做对"处理（宁可漏判不要误判）
- 红色印刷不是批改，忽略
`.trim();

const ENGLISH_HINTS = `
## 英语批改常见模式

### 选择题
模式1 — 题号列批改：21.✓ (对) | 22.✗C (错，正确答案C)
模式2 — 正确答案标注：红笔写C ≠ 学生选B → 错

### 默写/听写（易漏题！）
- 每行 = 序号 + 学生手写答案（单词/短语）
- 红笔直接改正错误单词（划掉+上写正确拼写）→ ❌ 错题
- 红笔 ✓ → ✅ 对
- ⚠️ 题目之间行间距小，确保每行独立判定

### 通用规则
- 同一题周围出现两个不同颜色的字母 → 红色的是正确答案
- 红色印刷 ≠ 批改
`.trim();

// ═══════════════════════════════════════
// Prompt 1: 阶段1 — 红笔标记检测 + 题目区域识别
// ═══════════════════════════════════════

export const DETECT_RED_MARKS_AND_QUESTIONS_PROMPT = `你是高中试卷分析专家。你会收到同一页试卷的两张图片，请完成两个任务。

═══════════════════════════════════════
【图片说明】
═══════════════════════════════════════
📷 图1（原图）：完整的试卷原图，包含题目文字、选项、学生蓝黑笔作答
🔴 图2（红笔突出图）：白底上只保留红色批改标记，非红色内容已淡化至极

═══════════════════════════════════════
【任务A — 红笔标记检测】（使用图2）
═══════════════════════════════════════
在图2中找出所有红色批改标记，逐一输出坐标和类型。

标记类型枚举：
- "cross"              — ✗ 打叉（两条交叉斜线）
- "check"              — ✓ 打勾
- "correct_answer"     — 红笔手写的答案字母/单词/数字，写在原答案旁边或题号旁
- "underline"          — 下划线/波浪线（标记重点）
- "strikethrough"      — 横线/斜线划掉文字
- "circle"             — 红色圆圈围绕某选项/内容
- "annotation"         — 红笔手写汉字注释（非答案改写）
- "score_deduction"    — 红笔扣分标记（如 "-2", "-0.5"）

content字段：对 correct_answer/annotation/score_deduction 类型，写出红笔文字内容；其他类型为空字符串

⚠️ 要求：
- 图2中出现的一切痕迹都是红笔（非红内容已淡化）
- 全面扫描，不遗漏微小记号和单独的字母
- 如果图2中没有任何红笔标记，输出空数组 []
- 字母识别要精确：区分大写/小写、是否带括号

═══════════════════════════════════════
【任务B — 题目区域识别】（使用图1）
═══════════════════════════════════════
在图1中识别每一道题目的语义边界。

题目类型枚举：
- "choice"         — 选择题（A/B/C/D 选项）
- "fill_blank"     — 填空题（横线/空格填写）
- "reading"        — 阅读理解（含文章段落+选择题）
- "dictation"      — 默写/听写/词组练习（序号+手写答案，无选项无题干）
- "translation"    — 翻译题
- "writing"        — 写作/作文

⚠️ 【密集布局检测 — 极易漏题，请特别注意】
某些题型（默写/填空）采用紧凑排列：多行每行 = 序号 + 手写答案，行间距小。
- 扫描全图找出所有题号/序号（1,2,3... 或 21,22,23...）
- 每个序号 = 一道独立题目 → 一个独立 bbox
- 不要因为"看起来几道题连在一起"就合并成一个 bbox
- 不要因为"没有选项区域"就跳过这道题
- 两栏/三栏布局 → 逐栏逐行识别

⚠️ 边界要求：
- bbox 要合理：上含题号/序号，涵盖答案区+批改区
- 密集布局中相邻题目的 bbox 可以紧挨，但必须各自独立
- 如果一道题边界内有另一道题的批改，宁可扩大本道题的 bbox
- 阅读理解：包含文章段落引述区域

═══════════════════════════════════════
【输出格式 — 严格纯 JSON】
═══════════════════════════════════════

{
  "redMarks": [
    {"markId": 1, "type": "correct_answer", "bbox": {"x": 220, "y": 480, "w": 25, "h": 25}, "content": "C"},
    {"markId": 2, "type": "cross", "bbox": {"x": 200, "y": 520, "w": 35, "h": 35}, "content": ""}
  ],
  "questions": [
    {"questionNumber": 21, "bbox": {"x": 40, "y": 410, "w": 550, "h": 130}, "questionType": "choice"}
  ]
}

输出规则：
- 直接输出 JSON，不要 markdown 代码块
- redMarks 按 markId 升序
- questions 按题号升序
- 所有坐标为整数像素值`;

// ═══════════════════════════════════════
// Prompt 2: 阶段2 — 逐题裁剪双图判错
// ═══════════════════════════════════════

export const JUDGE_PER_QUESTION_PROMPT = `你是高中错题整理助手。你的唯一任务是：读取教师已完成的批改标记，判断这道题学生「做错了」还是「做对了」。

═══════════════════════════════════════
【你的角色】
═══════════════════════════════════════
你**不做批改**。教师/同学已经完成了批改（红笔标记）。
你的工作是「阅读」已有的红笔标记，还原教师的批改结论。
就像学生在翻阅自己的批改后试卷。

═══════════════════════════════════════
【两张图的分工】
═══════════════════════════════════════
📷 图1（原图裁剪）：该题的题干、选项、学生蓝黑笔作答
🔴 图2（红笔图裁剪）：同一区域的红笔批改标记，非红内容已淡化

铁律：
- 蓝色/黑色笔迹 = 学生的答案（在图1中）
- 红色笔迹 = 教师的批改（在图2中）
- 红色印刷文字/边框不是批改，忽略

═══════════════════════════════════════
【红笔标记 → 判定表（先识别标记类型，再对照此表判定）】
═══════════════════════════════════════

标记                     | 教师意图       | 判定
✗ 打叉 (cross)           | 此题做错       | ❌ isError=true
划掉+写新答案             | 原答错误，给正确解 | ❌ isError=true, studentAnswer=被划, correctAnswer=红笔新写
只写正确答案无划掉         | 标注正确答案    | 对比：红笔≠学生选→❌  红笔=学生选→✅
圈出选项 (circle)         | 被圈=正确答案   | 学生选别的→❌错题
纯划掉无新答案             | 此题做错       | ❌ isError=true
纯注释/划线/圈关键词       | 标记重点       | ✅ isError=false
✓ 打勾 (check)            | 做对          | ✅ isError=false
扣分标记 (-2/-0.5)        | 扣分=错        | ❌ isError=true
此区域无任何红笔标记       | —             | ✅ isError=false

═══════════════════════════════════════
【判定规则优先级 — 按顺序走，命中即停止】
═══════════════════════════════════════

${ERROR_LOGIC_RULES}

═══════════════════════════════════════
【关键判定流程】
═══════════════════════════════════════
第1步：在图2中找到该题区域的所有红笔标记
第2步：按优先级判断每个标记的意图
第3步：如果图2该题区域没有任何红笔标记 → isError=false
第4步：如果对红笔意图不确定 → isError=false（保守处理）

═══════════════════════════════════════
【输出格式 — 严格纯 JSON】
═══════════════════════════════════════

如果做错（isError=true）：
{
  "questionNumber": 21,
  "isError": true,
  "studentAnswer": "B",
  "correctAnswer": "D",
  "teacherIntent": "红笔在题号旁写D，学生选了B → 错",
  "redMarkTypes": ["correct_answer"],
  "errorType": "语法/词汇/逻辑/概念/未知",
  "confidence": "high"
}

如果做对（isError=false）：
{
  "questionNumber": 21,
  "isError": false,
  "reason": "红笔打勾/无红笔标记/红笔答案等于学生答案"
}

输出规则：
- 直接输出单个 JSON 对象，不要数组
- 不要 markdown 代码块
- 必须是纯 JSON`;

// ═══════════════════════════════════════
// Prompt 3: 阶段1 fallback — 整图直接判错
// ═══════════════════════════════════════

export const FULL_PAGE_JUDGE_PROMPT = `你是高中错题整理助手。请在这整页试卷中找出学生做错的题目。

═══════════════════════════════════════
【你的角色】
═══════════════════════════════════════
你**不做批改**。教师已完成批改（红笔标记）。你只需「阅读」标记找出错题。

═══════════════════════════════════════
【图片】
═══════════════════════════════════════
📷 图1（原图）：完整试卷内容 + 学生蓝黑笔作答
🔴 图2（红笔图）：同一页的红笔批改标记，非红内容已淡化

铁律：
- 蓝/黑笔迹 = 学生答案
- 红笔迹 = 教师批改
- 红色印刷 ≠ 批改

═══════════════════════════════════════
【红笔标记 → 判定表】
═══════════════════════════════════════
✗打叉→❌错 | 划掉+新答案→❌错 | 写正确答案(无划掉)→对比判断 | 圈选项→被圈=正确答案 | 纯划掉→❌错 | 注释/划线→✅对 | ✓打勾→✅对 | 扣分→❌错

═══════════════════════════════════════
【判定规则 — 按优先级】
═══════════════════════════════════════

${ERROR_LOGIC_RULES}

═══════════════════════════════════════
【输出格式 — 严格纯 JSON 数组】
═══════════════════════════════════════

[
  {
    "questionNumber": 21,
    "isError": true,
    "studentAnswer": "B",
    "correctAnswer": "D",
    "teacherIntent": "红笔在题号旁写D",
    "errorType": "未知",
    "questionText": "题干文本（如有）",
    "questionType": "choice",
    "options": {"A":"...","B":"...","C":"...","D":"..."},
    "confidence": "high"
  }
]

没有错题输出空数组 []。
直接输出 JSON，不要 markdown 包裹。`;

// ═══════════════════════════════════════
// 构建器函数
// ═══════════════════════════════════════

/**
 * 加载科目逻辑文件（从文件系统读取 markdown）
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSubjectHints(subject) {
  const subjectFiles = {
    '英语': '../subject-logic/english-shanghai-gaokao.md',
    '语文': null,
    '数学': null,
  };
  
  const relPath = subjectFiles[subject];
  if (!relPath) return '';
  
  try {
    const fullPath = join(__dirname, relPath);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, 'utf-8');
      // 提取【判错本适用】和【批改约定】相关节
      return content;
    }
  } catch (e) { /* ignore */ }
  return '';
}

/**
 * 构建阶段1消息（合并红笔检测+题目区域识别）
 */
export function buildDetectRedMarksAndQuestions({ subject, originalBase64, redHighlightedBase64 }) {
  let extraHints = '';
  if (subject === '英语') extraHints = '\n' + ENGLISH_HINTS;
  
  // 加载科目逻辑
  const subjectLogic = loadSubjectHints(subject);
  if (subjectLogic) extraHints += '\n\n=== 科目批改约定（参考）===\n' + subjectLogic;
  
  const images = [];
  if (originalBase64?.length > 200) {
    images.push({ type: 'image_url', image_url: { url: originalBase64, detail: 'auto' } });
  }
  if (redHighlightedBase64?.length > 200) {
    images.push({ type: 'image_url', image_url: { url: redHighlightedBase64, detail: 'auto' } });
  }
  return [{
    role: 'user',
    content: [
      { type: 'text', text: DETECT_RED_MARKS_AND_QUESTIONS_PROMPT + extraHints },
      ...images
    ]
  }];
}

/**
 * 构建阶段2消息（逐题裁剪双图判错）
 */
export function buildJudgePerQuestion({ originalCrop, redCrop, questionNumber, subject }) {
  let subjectHint = '';
  if (subject === '英语') subjectHint = '\n' + ENGLISH_HINTS;
  
  const images = [];
  if (originalCrop?.length > 200) {
    images.push({ type: 'image_url', image_url: { url: originalCrop, detail: 'auto' } });
  }
  if (redCrop?.length > 200) {
    images.push({ type: 'image_url', image_url: { url: redCrop, detail: 'auto' } });
  }
  return [{
    role: 'user',
    content: [
      { type: 'text', text: JUDGE_PER_QUESTION_PROMPT + subjectHint + `\n\n题号：${questionNumber}` },
      ...images
    ]
  }];
}

/**
 * 构建整图 fallback 消息
 */
export function buildFullPageJudge({ subject, originalBase64, redHighlightedBase64 }) {
  let extraHints = '';
  if (subject === '英语') extraHints = '\n' + ENGLISH_HINTS;
  
  const subjectLogic = loadSubjectHints(subject);
  if (subjectLogic) extraHints += '\n\n=== 科目批改约定 ===\n' + subjectLogic;
  
  const images = [];
  if (originalBase64?.length > 200) {
    images.push({ type: 'image_url', image_url: { url: originalBase64, detail: 'auto' } });
  }
  if (redHighlightedBase64?.length > 200) {
    images.push({ type: 'image_url', image_url: { url: redHighlightedBase64, detail: 'auto' } });
  }
  return [{
    role: 'user',
    content: [
      { type: 'text', text: FULL_PAGE_JUDGE_PROMPT + extraHints },
      ...images
    ]
  }];
}

// ═══════════════════════════════════════
// 后处理工具函数（同 v8，不变）
// ═══════════════════════════════════════

export function associateRedMarksToQuestions(redMarks, questions) {
  const map = new Map();
  for (const q of questions) {
    map.set(q.questionNumber, []);
    const qBox = q.bbox;
    for (const rm of redMarks) {
      const rmCenterX = rm.bbox.x + rm.bbox.w / 2;
      const rmCenterY = rm.bbox.y + rm.bbox.h / 2;
      const expandX = qBox.w * 0.1;
      const expandY = qBox.h * 0.1;
      if (
        rmCenterX >= qBox.x - expandX &&
        rmCenterX <= qBox.x + qBox.w + expandX &&
        rmCenterY >= qBox.y - expandY &&
        rmCenterY <= qBox.y + qBox.h + expandY
      ) {
        map.get(q.questionNumber).push(rm);
      }
    }
  }
  return map;
}

export function validateStage1Result(parsed, imageWidth, imageHeight) {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, reason: '解析结果不是对象' };
  }
  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    return { valid: false, reason: '未识别到题目区域' };
  }
  for (const q of parsed.questions) {
    const b = q.bbox;
    if (!b || typeof b.x !== 'number' || typeof b.y !== 'number' ||
        typeof b.w !== 'number' || typeof b.h !== 'number') {
      return { valid: false, reason: `第${q.questionNumber || '?'}题 bbox 格式错误` };
    }
    b.x = Math.max(0, b.x);
    b.y = Math.max(0, b.y);
    b.w = Math.min(b.w, imageWidth - b.x);
    b.h = Math.min(b.h, imageHeight - b.y);
    if (b.w < 30 || b.h < 30) {
      return { valid: false, reason: `第${q.questionNumber || '?'}题 bbox 尺寸过小(${b.w}x${b.h})` };
    }
    if (b.w > imageWidth * 1.5 || b.h > imageHeight * 1.5) {
      return { valid: false, reason: `第${q.questionNumber || '?'}题 bbox 尺寸异常(${b.w}x${b.h})` };
    }
  }
  if (!Array.isArray(parsed.redMarks)) {
    return { valid: false, reason: 'redMarks 不是数组' };
  }
  for (const rm of parsed.redMarks) {
    if (rm.bbox) {
      rm.bbox.x = Math.max(0, rm.bbox.x);
      rm.bbox.y = Math.max(0, rm.bbox.y);
      rm.bbox.w = Math.min(rm.bbox.w, imageWidth - rm.bbox.x);
      rm.bbox.h = Math.min(rm.bbox.h, imageHeight - rm.bbox.y);
    }
  }
  return { valid: true, reason: 'ok' };
}
