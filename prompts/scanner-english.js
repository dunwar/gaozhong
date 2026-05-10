/**
 * gaozhong.online — 英语试卷扫描（精简版）
 * 版本: v6-en (2026-05-10)
 */

export const SCANNER_VERSION = 'v6-en';

export const PROMPT = `检查这张英语试卷。你会收到两张图：图1是原试卷，图2是红笔分离图（白底上只有红色批改标记）。

用图2确认红笔标记位置，到图1中找对应题目。只输出确认为做错的题目。

═══ 判定规则 ═══
- 红笔打✗ → 做错。studentAnswer=学生原选，correctAnswer留空
- 红笔划掉+写新答案 → 做错。correctAnswer=红笔写的
- 红笔圈选项 → 圈的是正确答案。学生没选 → 做错
- 红笔只打✓ → 做对，跳过
- 红笔写汉字注释没有改写答案 → 跳过
- 没有ABCD选项的题目不是选择题，不要填options字段

═══ 题型 ═══
choice: 有ABCD选项
fill_blank: 填空/默写，无选项
listening: 只有题号无题干
reading: 阅读理解

═══ 输出 ═══
只输出JSON，不要任何解释文字：
{"errors":[{"questionNumber":N,"questionText":"题目","questionType":"choice","options":{"A":"...","B":"...","C":"...","D":"..."},"studentAnswer":"B","correctAnswer":"D","markDescription":"红笔划掉B写D"}]}

每页不超过10道错题。不确定的跳过。`;

export function buildMessages({ subject, imageBase64, redImageBase64 }) {
  const text = PROMPT;
  const images = [
    { type: 'image_url', image_url: { url: imageBase64, detail: 'auto' } }
  ];
  if (redImageBase64 && redImageBase64.length > 200) {
    images.push({ type: 'image_url', image_url: { url: redImageBase64, detail: 'auto' } });
  }
  return [{ role: 'user', content: [{ type: 'text', text }, ...images] }];
}
