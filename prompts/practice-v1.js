/**
 * gaozhong.online - 同类题练习生成 Prompt 模板
 *
 * 版本: v1 (2026-10-31)
 * 用途: 从错题生成同类变式题（单题3道: 易/平/难；组卷每题1道）
 * 来源: 改编自 wrong-notebook (MIT) 的 DEFAULT_SIMILAR_TEMPLATE — 12变式技法+难度阶梯保留,
 *       输出改为 JSON 数组(复用本站 JSON 修复状态机), 增加上海高中英语约束
 *
 * 模板变量:
 *   {count}          生成题数
 *   {difficultySpec} 难度要求说明 (单题模式: 1易1平1难 / 组卷模式: 与原题持平)
 *   {subject}        学科
 *   {questionText}   原题题干 (含选项)
 *   {passageHint}    阅读理解原文片段提示 (可空)
 *   {wrongAnswer}    学生错误答案 (可空, 供针对性设陷阱)
 *   {knowledgePoints} 知识点列表 (可空)
 *
 * 迭代历史:
 *   v1 - 初始版本 (F1 同类题练习生成)
 */

export const PRACTICE_PROMPT_V1 = `你是一位资深的上海高中{subject}命题专家。你的任务：**根据下面的原题，举一反三生成 {count} 道高质量变式题**，帮助学生巩固错题涉及的知识点。

【原题】
{questionText}
{passageHint}
【学生当时的错误答案】{wrongAnswer}
【考查知识点】{knowledgePoints}

【命题要求】
1. **考点一致**：每道变式题必须考查与原题相同的核心知识点（{knowledgePoints}），改变的是情境、数据或角度
2. **变式技法**（灵活选用）：条件替换 / 情境迁移 / 问题转化 / 数据重构 / 角色反转 / 难度阶梯 / 陷阱设计 / 逆向思维 / 生活应用
3. **难度控制**：{difficultySpec}
4. **针对薄弱点**：学生当初答错了（{wrongAnswer}），至少 1 道变式题要在同类易错点上设置考察
5. **语言规则**：英语题的题干、选项、答案必须全英文；解析必须用简体中文（帮助学生理解）
6. **自足完整**：每道题独立成立、答案唯一可验证、无知识性错误；选择题必须带 A/B/C/D 选项
7. **禁止**：照抄原题只改数字的"伪变式"；超出上海高中{subject}课程标准的内容

【输出格式】
只输出一个 JSON 数组，不要任何其他文字、不要 markdown 代码块：
[
  {
    "difficulty": "easy|medium|hard",
    "knowledgePoint": "本题考查的知识点（中文，一个词组）",
    "questionText": "新题目完整文本（含选项，如有）",
    "answerText": "正确答案（选择题给字母+简短理由，填空题给答案本身）",
    "analysis": "简体中文解析，3-5步，讲清解题路径"
  }
]`;

/** 渲染练习生成 prompt */
export function renderPracticePrompt({ subject, questionText, passageText = '', wrongAnswer = '', knowledgePoints = [], count = 3, difficultySpec = '' }) {
  const passageHint = passageText
    ? `\n【原文片段（仅供理解语境，变式题不要照抄原文，可改写情境）】\n${passageText.slice(0, 300)}\n`
    : '\n';
  return PRACTICE_PROMPT_V1
    .replace(/\{subject\}/g, subject || '英语')
    .replace(/\{count\}/g, String(count))
    .replace(/\{questionText\}/g, (questionText || '').trim() || '（题干缺失）')
    .replace(/\{passageHint\}/g, passageHint)
    .replace(/\{wrongAnswer\}/g, (wrongAnswer || '').trim() || '未记录')
    .replace(/\{knowledgePoints\}/g, knowledgePoints?.length ? knowledgePoints.join('、') : '（按原题自行判断）')
    .replace(/\{difficultySpec\}/g, difficultySpec || '每道题难度与原题持平');
}

/** 单题模式：3 道变式（1易 1平 1难） */
export const DIFFICULTY_SPEC_SINGLE = '恰好 3 道：第 1 道比原题略易（简化数据、更直接），第 2 道与原题难度相当，第 3 道比原题略难（多一步推理或综合两个考点）';

/** 组卷模式：每题 1 道，难度持平 */
export const DIFFICULTY_SPEC_PAPER = '与原题难度相当';
