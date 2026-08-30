/**
 * gaozhong.online — Scanner v4.6
 *
 * v4.7 变更: TextIn 用整页不切分 + parse_mode=auto + DPI 216
 *   - TextIn 有内置版面分析，切分会破坏其双栏处理能力
 *   - 新管线: TextIn(整页) → 成功则用，失败 → VL(切分半页)
 *   - parse_mode: scan→auto, DPI: 200→216
 *
 * v4.6 变更: TextIn OCR 改用原图 (修复)
 *   - de-red 预处理损害 TextIn 识别率
 *
 * v4.5 变更: Phase 0.5 页面准备 (旋转+分页+排序)
 *   - 新增 /prepare-pages 端点：自动旋转横拍照片 + 双页水平分割
 *   - 手机拍两页 → 自动拆分为独立页面，按 R→L 排序
 *
 * v4.4 变更: TextIn OCR 集成
 *   - 新增 TextIn xParse OCR 作为主引擎 (99.7%印刷体识别率)
 *   - 11阶段题目解析 + 连续性推断 (97.9%检测率)
 *   - 失败自动回退: TextIn → VL (智谱/Kimi) → Tencent
 *   - 红笔分类和质心匹配保持不变 (VL 完成)
 *
 * v4.2 变更: 去红处理 + OCR 输入优化
 *   - 新增 /de-red 预处理：OCR 前擦除红笔墨水（cv2.inpaint）
 *   - OCR 输入从原图变为去红图（避免红线穿字导致识别错误）
 *   - 预处理阶段并行运行 de-red（不增加端到端延迟）
 *
 * Architecture:
 *   Phase 1:  Split ORIGINAL pages (for VL fallback)
 *   Phase 2:  De-red + red centroids (VL only)
 *   Phase 3:  TextIn on FULL pages (parse_mode=auto, DPI=216)
 *             TextIn has built-in layout analysis — never pre-split
 *   Fallback: VL OCR on split halves (TextIn failed pages only)
 *   Red:      Preprocess v8.0 /red-regions → red centroid map
 *   Classify: VL → classify red mark types (✗/✓/letter/etc.)
 *   Fallback: Tencent Cloud OCR → text blocks + rule engine
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { execFile, spawn, execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SCANNER_VERSION = 'v4.7';
const PREPROCESS_URL = process.env.PREPROCESS_URL || 'http://localhost:5002';
const VL_CONCURRENCY = 2;  // Low to avoid Zhipu rate limit
const PREPROCESS_CONCURRENCY = 4;
const VL_RETRIES = 3;          // per-page retries before giving up
const VL_RETRY_BACKOFF_MS = 2000;  // base backoff between retries

// 智谱 VL 配置
const ZHIPU_KEY = process.env.ZHIPU_API_KEY || '';
const ZHIPU_BASE_URL = process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/coding/paas/v4';
const MODEL_ZHIPU_VL = process.env.MODEL_ZHIPU_VL || 'glm-4.6v-flash';
const USE_ZHIPU_VL = !!ZHIPU_KEY;  // Use Zhipu VL (endpoint fixed to /api/paas/v4)

// TextIn OCR 配置 (v4.4) — 优于 VL 的专用 OCR 引擎
// 注意: 运行时求值，不在模块加载时（此时 .env 可能未加载）
const textinEnabled = () => !!(process.env.TEXTIN_APP_ID && process.env.TEXTIN_SECRET_CODE);
const TEXTIN_TIMEOUT_MS = 300_000;  // TextIn API + LLM parser 超时

// ═══════════════════════════════════════
// Concurrency limiter
// ═══════════════════════════════════════

class ConcurrencyGate {
  constructor(limit, minDelayMs = 0) {
    this.limit = limit;
    this.running = 0;
    this.queue = [];
    this.minDelayMs = minDelayMs;
    this.lastStart = 0;
  }
  
  async run(fn) {
    while (this.running >= this.limit) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    // Enforce minimum delay between starts
    if (this.minDelayMs > 0 && this.lastStart > 0) {
      const elapsed = Date.now() - this.lastStart;
      if (elapsed < this.minDelayMs) {
        await new Promise(r => setTimeout(r, this.minDelayMs - elapsed));
      }
    }
    this.running++;
    this.lastStart = Date.now();
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════

function imgToBase64(filePath) {
  // /preprocess 返回的 corrected/red_highlighted 已是 data URL，直接透传
  if (typeof filePath === 'string' && filePath.startsWith('data:')) return filePath;
  const buf = readFileSync(filePath);
  return `data:image/${filePath.endsWith('.png') ? 'png' : 'jpeg'};base64,${buf.toString('base64')}`;
}

function runPython(script, args = []) {
  const scriptPath = join(__dirname, 'scripts', script);
  return new Promise((resolve, reject) => {
    execFile('python3', [scriptPath, ...args], {
      encoding: 'utf-8', timeout: 900_000, maxBuffer: 20 * 1024 * 1024
    }, (error, stdout) => {
      const output = (stdout || '').trim();
      // Try parsing stdout as JSON even on non-zero exit (python script returns error JSON)
      if (output) {
        try {
          const parsed = JSON.parse(output);
          // If it's a valid status response, use it regardless of exit code
          if (parsed.status) return resolve(parsed);
        } catch (_) { /* fall through to error handling */ }
      }
      if (error) {
        if (error.killed) return reject(new Error(`Python ${script} timed out (5min)`));
        const detail = output ? `: ${output.slice(0, 200)}` : '';
        return reject(new Error(`Python ${script} failed${detail}`));
      }
      if (!output) return reject(new Error(`Python ${script} returned empty output`));
    });
  });
}

async function httpGetJson(hostname, port, path, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path, method: 'GET', timeout }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function httpPostJson(hostname, port, path, body, timeout = 300_000) {
  const postData = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname, port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(postData); req.end();
  });
}

// ═══════════════════════════════════════
// OCR Engines
// ═══════════════════════════════════════

/**
 * 调用智谱 VL 模型（图片+文字多模态）
 */
async function zhipuVLRequest({ messages, model, max_tokens = 4096, temperature = 0.05, thinking = 'disabled' }) {
  const useModel = model || MODEL_ZHIPU_VL;
  // thinking=disabled: 分类/OCR提取不需要推理链，直接出结果更快更省
  const body = JSON.stringify({ model: useModel, messages, max_tokens, temperature, thinking: { type: thinking } });
  // v5.1: VL 端点可走编程套餐 coding 端点（ZHIPU_VL_CODING=1）——实测响应格式与标准端点
  // 一致（choices[0].message.content），且编程套餐包含 glm-4.6v 标准版而标准端点无余额
  let vlBaseUrl = ZHIPU_BASE_URL || '';
  if (process.env.ZHIPU_VL_CODING === '1') {
    vlBaseUrl = vlBaseUrl.replace('/api/paas/v4', '/api/coding/paas/v4');
  } else {
    vlBaseUrl = vlBaseUrl.replace('/api/coding/paas/v4', '/api/paas/v4');
  }
  const url = new URL(vlBaseUrl + '/chat/completions');

  return new Promise((resolve, reject) => {
    // 外部 API 是 https — 用 http 模块会收到 301 重定向页导致解析失败
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ZHIPU_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 180_000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.error) {
            // Rate limit — use special error type for retry logic
            if (result.error.code === '429' || (result.error.message || '').includes('速率限制') || (result.error.message || '').includes('rate')) {
              reject(new Error('ZhipuVLRateLimit'));
              return;
            }
            reject(new Error(`Zhipu API error: ${result.error.message || JSON.stringify(result.error)}`));
            return;
          }
          resolve(result);
        } catch (e) {
          reject(new Error(`Zhipu parse error: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Zhipu VL timeout')); });
    req.write(body);
    req.end();
  });
}

async function detectPreflight() {
  const u = new URL(PREPROCESS_URL);
  const port = parseInt(u.port) || 5002;
  
  // Check health, retry up to 5 times with increasing wait
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const data = await httpGetJson(u.hostname, port, '/health', 8000);
      if (data.status === 'ok') return true;
    } catch (_) {}
    const waitMs = (attempt + 1) * 2000;
    console.log(`[scanner] Preprocess v8.0 not ready, retry ${attempt + 1}/5 in ${waitMs / 1000}s...`);
    await new Promise(r => setTimeout(r, waitMs));
  }
  throw new Error(`预处理服务 v8.0 不可用 (port ${port})，请稍后重试`);
}

// Fix escaped newlines and common JSON formatting issues from VL output
function fixNewlinesInJSON(str) {
  return str
    .replace(/\\n/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract content from VL response (handles both content and reasoning_content)
function extractContent(result) {
  const msg = result.choices?.[0]?.message;
  return (msg?.content || '') || (msg?.reasoning_content || '') || '';
}

async function extractQuestionsVL(pagePath, apiKey, subPage = null, pageIndex = 0, totalPages = 0) {
  // v4.3: Layout detection → inject bbox hints into VL prompt
  // Run layout detection in parallel with base64 encoding
  const [layoutResult, imageB64Prep] = await Promise.all([
    detectLayout(pagePath),
    Promise.resolve().then(() => { /* will load below */ return null; })
  ]);

  // Build layout hint text
  let layoutHint = '';
  if (layoutResult && layoutResult.blocks?.length > 0) {
    const imgW = layoutResult.image_size?.width || 0;
    const imgH = layoutResult.image_size?.height || 0;
    const blocks = layoutResult.blocks;
    const isDualColumn = imgW > 0 && blocks.filter(b => b.x1 > imgW * 0.45 && b.x2 > imgW * 0.5).length > 3;

    layoutHint = `
══════════════════════════════════
【AI 版面分析结果（已确认，可信）】
══════════════════════════════════
页面尺寸: ${imgW}×${imgH}
检测到 ${blocks.length} 个文本块，排版: ${isDualColumn ? '双栏（先左后右）' : '单栏'}
${isDualColumn ? '- 左栏 x: 0~' + Math.round(imgW * 0.48) + ', 右栏 x: ' + Math.round(imgW * 0.45) + '~' + imgW : ''}

文本块列表（按阅读顺序）：
`;
    for (const b of blocks) {
      layoutHint += `  [${b.label}] (${b.x1},${b.y1})-(${b.x2},${b.y2}) ${b.w}×${b.h} 置信${b.score.toFixed(2)}\n`;
    }
    layoutHint += `
⚠️ 以上位置信息由 AI 版面检测引擎确认，请基于这些坐标确定：
- 页面是${isDualColumn ? '双栏' : '单栏'}排版
- 每道题的 bbox 应准确覆盖题号+题干+选项的矩形范围
- 禁止将不同栏的文字混一行！左右栏 y 坐标可能重叠但内容完全不同，必须严格按栏读取
`;
  }

  // v4.1: 尝试智谱 VL OCR（如果配置了 key），fallback 到 Python Kimi
  if (USE_ZHIPU_VL) {
    console.log(`[scanner] Trying Zhipu VL OCR... (layout: ${layoutResult ? layoutResult.blocks?.length + ' blocks' : 'none'})`);
    const imageB64 = imgToBase64(pagePath);
    const zhipuMessages = [
          { role: 'system', content: '你是一位高中老师。你仔细看试卷图片，逐题提取题目结构。最终只输出JSON，不加任何解释。重要：不要输出推理过程（reasoning），直接在content中输出完整JSON。' },
          { role: 'user', content: [
            { type: 'text', text: `请识别这张试卷页面上的所有题目，逐题提取信息。

${pageIndex > 0 ? `⚠️ 这是试卷的第 ${pageIndex} 页（共 ${totalPages} 页）。题号应该是试卷上的原始编号，不要从1开始重新编号！` : ''}

${layoutHint}
══════════════════════════════════
【版面分析 — 先判断结构】
══════════════════════════════════
第1步：观察页面整体排版
${subPage ? `- 这张图已经是${subPage === 'left' ? '左' : '右'}半部分（已切图），直接按单栏从上到下读取` : '- 是单栏还是双栏？'}
- 双栏的话，先读完左栏（从上到下），再读右栏（从上到下）
- 如果页面中间有竖线/空白分隔 → 双栏，左右独立读
- ⚠️ 严禁将左右两栏的文字混在一起当成一行！

第2步：识别页面区域类型
- 阅读理解区域：一大段连续文字 + 后面跟 3-5 道题
- 选择题区域：题号 + 题干 + A/B/C/D 选项
- 完形填空区域：一段含 ___(题号) 的短文
- Section 标题、Directions 说明 → 跳过

══════════════════════════════════
【题目识别规则】
══════════════════════════════════
1. 题号 = 试卷上印刷的数字编号（如 21. 22. 44. 等），必须照抄原始题号
2. ⚠️ 绝对不要自己编造题号！如果页面上某道题没有印刷题号，设 questionNumber 为 0
3. ⚠️ 如果页面是完形填空/语法填空的续页，题号可能是 (1)(2)(3) 这样的括号数字
4. 一道题 = 题号 + 题干 + 选项（如有）
5. 听力题题干空白 → questionText 填 "(听力题)"
6. 同一题号的 A/B/C/D 是同一道题的选项，不要拆开
7. 每道题的 bbox 从左到右覆盖该题的所有选项
8. 翻译题和写作题也要识别，即使没有选项
9. ⚠️ 严禁遗漏任何有题号的题目！如果页面有20道题就输出20道

══════════════════════════════════
【阅读理解 — 特殊处理 ⚠️ 极重要】
══════════════════════════════════
如果页面有阅读理解文章：

规则A：先在 passages 数组里提取文章全文
- 一篇文章 = 一个 passage，含完整文本
- 文章可能跨多段，全部合并
- passageText 逐字抄写，不要省略、不要"此处省略N字"

规则B：每道阅读题的 passageRef 指向对应文章编号
- 第1道阅读题 → passageRef: 0
- 第2-5道同一文章的题 → passageRef: 0（同一篇文章）
- 第6道（下一篇阅读的第1题）→ passageRef: 1

规则C：阅读题的 questionType 设为 "reading"

══════════════════════════════════
【题型分类】
══════════════════════════════════
choice    — 选择题（有 A/B/C/D）
cloze     — 完形填空（短文 + 编号空格）
reading   — 阅读理解（文章 + 题目）
grammar   — 语法填空（单句或短文含 ___ 标记）
fill_blank — 填空题
translation — 翻译题
dictation — 默写/听写
listening  — 听力题（有选项无题干文字）

══════════════════════════════════
【输出JSON格式 — 严格格式】
══════════════════════════════════
{"passages":[{"text":"阅读理解文章全文..."}],"questions":[
  {"questionNumber":21,"questionType":"reading","passageRef":0,"questionText":"题干","options":{"A":"...","B":"...","C":"...","D":"..."},"passageText":"","bbox":{"x":0,"y":0,"w":0,"h":0}},
  {"questionNumber":22,"questionType":"reading","passageRef":0,"questionText":"题干","options":{"A":"...","B":"...","C":"...","D":"..."},"passageText":"","bbox":{"x":0,"y":0,"w":0,"h":0}}
]}

⚠️ 质量要求：
- bbox 覆盖题号+题干+选项的矩形范围，每道题的 bbox 必须不同
- ⚠️ 禁止所有题目使用相同的 bbox 值！必须根据图片中每道题的实际位置逐一计算
- 逐题输出，不要遗漏页面上任何一道有题号的题
- 双栏试卷大约每栏 10-15 道题，总共 20-30 道
- 直接输出JSON，不要markdown代码块。` },
            { type: 'image_url', image_url: { url: imageB64, detail: 'high' } }
          ]}
        ];
    try {
      const result = await zhipuVLRequest({
        messages: zhipuMessages,
        max_tokens: 16000,
        temperature: 0.05
      });
      
      const content = extractContent(result);
      // Parse JSON — with control character cleanup
      const cleaned = content.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/g, '')
        // Remove control characters (0x00-0x1F except \t \n \r)
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        // Tier 2: find outermost { }
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
          try { parsed = JSON.parse(match[0]); } catch {
            // Tier 3: try truncation repair — progressively remove trailing chars
            const s = match[0];
            for (let end = s.length; end > s.length - 2000 && end > 10; end--) {
              try { parsed = JSON.parse(s.substring(0, end)); break; } catch {}
            }
          }
        }
        if (!parsed) {
          // Tier 4: try adding closing brackets
          const braceMatch = cleaned.match(/\{[\s\S]*/);
          if (braceMatch) {
            const base = braceMatch[0];
            for (const suffix of ['"}]}', '"}]}}', '}]}', '}]', ']}', '}']) {
              try { parsed = JSON.parse(base + suffix); break; } catch {}
            }
          }
        }
        if (!parsed) throw new Error('Failed to extract JSON from response (' + content.length + ' chars): ' + content.substring(0, 200));
      }
      
      const questions = parsed.questions || [];
      const passages = parsed.passages || [];
      
      // v4.2: Inject passage text into reading questions via passageRef
      if (passages.length > 0) {
        for (const q of questions) {
          if (q.questionType === 'reading' && q.passageRef != null && passages[q.passageRef]) {
            q.passageText = q.passageText || passages[q.passageRef].text;
          }
        }
      }
      
      if (questions.length === 0) throw new Error('Zhipu VL returned 0 questions');
      
      console.log(`[scanner] Zhipu VL OCR: ${questions.length} questions`);
      return { status: 'ok', totalQuestions: questions.length, questions, engine: 'zhipu-vl' };
    } catch (e) {
      // v4.3: Rate limit → wait and retry instead of immediate fallback
      if (e.message === 'ZhipuVLRateLimit') {
        // Exponential backoff: try 30s, 60s
        for (let attempt = 0; attempt < 2; attempt++) {
          const wait = 30000 * (attempt + 1);
          console.log(`[scanner] Zhipu VL rate limited, waiting ${wait/1000}s before retry ${attempt+1}/2...`);
          await new Promise(r => setTimeout(r, wait));
          try {
            const retryResult = await zhipuVLRequest({ messages: zhipuMessages, model: MODEL_ZHIPU_VL, max_tokens: 16000, temperature: 0.05 });
            const retryContent = extractContent(retryResult);
            const retryCleaned = fixNewlinesInJSON(retryContent.trim().replace(/^[`]{3}(?:json)?\s*/i, '').replace(/\s*[`]{3}$/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''));
            let retryParsed;
            try { retryParsed = JSON.parse(retryCleaned); } catch { const m = retryCleaned.match(/\{[\s\S]*\}/); if (m) try { retryParsed = JSON.parse(m[0]); } catch {} }
            if (retryParsed?.questions?.length > 0) {
              console.log(`[scanner] Zhipu VL retry success (attempt ${attempt+1}): ${retryParsed.questions.length} questions`);
              return { status: 'ok', totalQuestions: retryParsed.questions.length, questions: retryParsed.questions, passages: retryParsed.passages || [], engine: 'zhipu-vl-retry' };
            }
          } catch (e2) {
            console.log(`[scanner] Zhipu VL retry ${attempt+1} failed: ${e2.message}`);
          }
        }
      }
      console.log(`[scanner] Zhipu VL OCR failed (${e.message}), falling back to Kimi...`);
    }
  }
  
  // Fallback: Kimi k2.6 via Python (use KIMI_API_KEY env, not the passed apiKey which may be Zhipu's)
  const kimiKey = process.env.KIMI_API_KEY || apiKey;
  const result = await runPython('ocr-page.py', [pagePath, '--api-key', kimiKey]);
  if (result.status !== 'ok') throw new Error(`VL OCR failed: ${result.error}`);
  
  // v4.2: Inject passage text from passages array into reading questions
  const kimiPassages = result.passages || [];
  if (kimiPassages.length > 0) {
    for (const q of (result.questions || [])) {
      if (q.questionType === 'reading' && q.passageRef != null && kimiPassages[q.passageRef]) {
        q.passageText = q.passageText || kimiPassages[q.passageRef].text;
      }
    }
  }

  // v4.3.2: Post-process — validate & fix bbox, detect cross-column contamination
  if (result.questions?.length > 0 && layoutResult?.blocks?.length > 0) {
    postProcessQuestions(result.questions, layoutResult);
  }

  return result;
}

async function detectRedCentroids(imageBase64) {
  const u = new URL(PREPROCESS_URL);
  const data = await httpPostJson(u.hostname, parseInt(u.port) || 5002, '/red-regions', {
    image: imageBase64,
    options: { deskew: true, enhance: true }
  });
  if (data.status !== 'ok') throw new Error(`Red regions failed: ${data.error}`);
  return data.result;
}

/**
 * Layout detection via PaddleOCR LayoutDetection (PP-DocLayout_plus-L)
 * Returns array of { label, score, x1, y1, x2, y2, w, h } sorted by reading order.
 * Takes ~4s on CPU; returns null on failure (non-fatal).
 */
async function detectLayout(pagePath) {
  try {
    const u = new URL(PREPROCESS_URL);
    const data = await httpPostJson(u.hostname, parseInt(u.port) || 5002, '/layout-detect', {
      file_path: pagePath,
      options: { min_score: 0.4 }
    }, 30_000);  // 30s timeout (includes first-time model load)
    if (data.status !== 'ok') {
      console.log(`[scanner] Layout detect failed: ${data.error}`);
      return null;
    }
    return data.result;  // { blocks, total, label_counts, image_size, predict_ms }
  } catch (e) {
    console.log(`[scanner] Layout detect error: ${e.message}`);
    return null;
  }
}

async function detectPreprocess(imageBase64) {
  const u = new URL(PREPROCESS_URL);
  const data = await httpPostJson(u.hostname, parseInt(u.port) || 5002, '/preprocess', {
    image: imageBase64,
    options: { deskew: true }
  });
  if (data.status !== 'ok') throw new Error(`Preprocess failed: ${data.error}`);
  return data.result;
}

/**
 * v4.2: De-red — erase red ink from original image before OCR.
 * Calls preprocess /de-red endpoint → inpainting fills red areas with background.
 * Returns { cleanBase64, redSignal }.
 */
async function deRedImage(imageBase64) {
  const u = new URL(PREPROCESS_URL);
  const data = await httpPostJson(u.hostname, parseInt(u.port) || 5002, '/de-red', {
    image: imageBase64,
    options: { deskew: true }
  });
  if (data.status !== 'ok') throw new Error(`De-red failed: ${data.error}`);
  return { cleanBase64: data.result.clean_image, redSignal: data.result.red_signal };
}

// ═══════════════════════════════════════
// TextIn OCR (v4.4) — 通过 preprocess-server 代理调用 TextIn API
// 替换 VL OCR 作为主引擎，提供 99.7% 印刷体识别率 + 11阶段题目解析
// 失败时调用方自动回退到 extractQuestionsVL
// ═══════════════════════════════════════

async function extractQuestionsTextIn(pagePath, options = {}) {
  const imageB64 = imgToBase64(pagePath);
  const u = new URL(PREPROCESS_URL);
  const host = u.hostname;
  const port = parseInt(u.port) || 5002;

  const data = await httpPostJson(host, port, '/textin/ocr', {
    image: imageB64,
    options: {
      subject: options.subject || '自动',
      erase_handwriting: false
    }
  }, TEXTIN_TIMEOUT_MS);

  if (data.status !== 'ok') {
    throw new Error(`TextIn OCR failed: ${data.error}`);
  }

  const result = data.result;
  if (!result.questions || result.questions.length === 0) {
    throw new Error('TextIn returned 0 questions');
  }

  return {
    status: 'ok',
    totalQuestions: result.questions.length,
    questions: result.questions,
    passages: result.passages || [],
    engine: result.engine || 'textin-pdf_to_markdown-v2',
    imageSize: result.image_size || null,
    detailCount: result.detail_count || 0,
    handwrittenRegions: result.handwritten_regions || []
  };
}

// v4.7: Merged TextIn OCR + LLM parse — all pages in one call
// ═══════════════════════════════════════════════════════════════════
// v5.0 识别主力: TextIn v3 智能抽取 + 五层本地完善（preprocess /exam/extract）
// 离线验收: 高一下 94/95 (98.9%) / 澜大 29/29 / 零幻觉
// ═══════════════════════════════════════════════════════════════════
async function extractQuestionsExamAPI(pagePaths, options = {}) {
  const u = new URL(PREPROCESS_URL);
  const imagesB64 = pagePaths.map(p => imgToBase64(p));
  const data = await httpPostJson(u.hostname, parseInt(u.port) || 5002, '/exam/extract', {
    images: imagesB64,
    options: { subject: options.subject || '自动' }
  }, 900_000);  // 15min（v3 每页 ~20s + OCR + refine）
  if (data.status !== 'ok') {
    throw new Error(`Exam extract failed: ${data.error}`);
  }
  const result = data.result;
  if (!result.questions || result.questions.length === 0) {
    throw new Error('Exam extract returned 0 questions');
  }
  return {
    status: 'ok',
    totalQuestions: result.questions.length,
    questions: result.questions,
    passages: result.passages || [],
    engine: result.engine || 'textin-v3-exam',
    imageSize: result.image_size || null,
    detailCount: result.detail_count || 0,
    handwrittenRegions: result.handwritten_regions || [],
    pageStatus: result.page_status || [],
    pageItemCounts: result.page_item_counts || [],
    qnCorrections: result.qn_corrections || []
  };
}

async function extractQuestionsTextInMerged(pagePaths, options = {}) {
  const u = new URL(PREPROCESS_URL);
  const host = u.hostname;
  const port = parseInt(u.port) || 5002;

  const imagesB64 = pagePaths.map(p => imgToBase64(p));

  const data = await httpPostJson(host, port, '/textin/ocr-merged', {
    images: imagesB64,
    options: {
      subject: options.subject || '自动',
    }
  }, 600_000);  // 10min timeout for full exam

  if (data.status !== 'ok') {
    throw new Error(`TextIn merged failed: ${data.error}`);
  }

  const result = data.result;
  if (!result.questions || result.questions.length === 0) {
    throw new Error('TextIn merged returned 0 questions');
  }

  return {
    status: 'ok',
    totalQuestions: result.questions.length,
    questions: result.questions,
    passages: result.passages || [],
    engine: result.engine || 'textin-llm-merged',
    imageSize: result.image_size || null,
    detailCount: result.detail_count || 0,
    handwrittenRegions: result.handwritten_regions || [],
    // v5.0 ①: 页级解析状态（llm_parser 透传），供 VL 兜底触发与用户提示
    pageStatus: result.page_status || [],
    pageItemCounts: result.page_item_counts || [],
    qnCorrections: result.qn_corrections || []
  };
}

async function extractQuestionsTencent(pagePath, tencentSecret) {
  const result = await runPython('ocr-tencent.py', [
    pagePath,
    '--secret-id', tencentSecret.secretId,
    '--secret-key', tencentSecret.secretKey,
    '--region', tencentSecret.region || 'ap-guangzhou',
    '--high-precision'
  ]);
  if (result.status !== 'ok') throw new Error(`Tencent OCR failed: ${result.error}`);
  return result;
}

// ═══════════════════════════════════════
// v3.4: VL Red Mark Classification
// ═══════════════════════════════════════

/**
 * Send the red-highlighted image (white bg + red marks only) to VL
 * to classify each red mark's type.
 * 
 * v4.1: 支持 Zhipu VL（优先）和 Kimi VL（fallback）
 * 
 * @returns {{ classifiedMarks: [], errorQuestionNumbers: Set<number> }}
 */
async function classifyRedMarksVL(redHighlightedPath, questions, apiKey) {
  if (!redHighlightedPath) {
    console.log('[scanner] No red-highlighted image, skipping VL classification');
    return { classifiedMarks: [], errorQuestionNumbers: new Set() };
  }
  
  const imageB64 = imgToBase64(redHighlightedPath);
  
  const prompt = `请分析这张红笔标记提取图（白底上只保留红色标记）。

【你的任务】
找出图中所有的红色标记，逐一判断它们的类型。

【标记类型 — 精准定义】

1. "cross" — ✗ 打叉：两条交叉的斜线（X形状），不是字母X
2. "check" — ✓ 打勾：一条从左上到右下的短斜线 + 一个小弯钩
3. "correct_answer" — 红笔写的字母/单词/数字：英文大写字母(A/B/C/D)、英文单词、阿拉伯数字
4. "underline" — 下划线/波浪线：水平线，位于文字下方
5. "circle" — 红色圆圈/椭圆：围绕某内容的圈
6. "annotation" — 红笔手写汉字注释（如"主谓一致""过去式"）
7. "strikethrough" — 横线/斜线划掉文字
8. "score_deduction" — 红笔扣分标记（如 "-2", "-0.5"）

【判定规则 — 错题判据】
只有两种标记代表"做错"：
- ✗ cross — 教师明确标记做错 → 错题 ✅
- correct_answer（红笔字母/单词）— 教师标注正确答案，学生原选 ≠ 此字母 → 错题 ✅

其余所有标记（✓ check、underline、circle、annotation、strikethrough）均不代表做错，忽略。

【输出格式】纯JSON：
{
  "marks": [
    {"type": "cross", "content": "", "position": "题号22旁边"},
    {"type": "correct_answer", "content": "C", "position": "题号23旁边"},
    {"type": "check", "content": "", "position": "题号21旁边"}
  ]
}

直接输出JSON。`;

  const userContent = [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: imageB64, detail: 'high' } }
  ];

  // Helper to parse VL response
  function parseClassifyResponse(content) {
    let marks = [];
    const cleaned = content.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/g, '');
    
    try {
      marks = JSON.parse(cleaned).marks || [];
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try { marks = JSON.parse(match[0]).marks || []; } catch {}
      }
    }
    
    const errorTypes = new Set(['cross', 'correct_answer']);
    return marks.map(m => ({
      ...m,
      isError: errorTypes.has(m.type)
    }));
  }

  // 尝试智谱 VL（优先）— v4.9: 429 限流退避重试（30s/60s），限流通道不再直接降级
  if (USE_ZHIPU_VL) {
    for (let attempt = 0; attempt < 3; attempt++) {
      console.log(`[scanner] Classifying red marks via Zhipu VL${attempt > 0 ? ` (retry ${attempt})` : ''}...`);
      try {
        const result = await zhipuVLRequest({
          messages: [
            { role: 'system', content: '你精准识别红笔批改标记。只输出JSON。' },
            { role: 'user', content: userContent }
          ],
          model: MODEL_ZHIPU_VL,
          max_tokens: 4096,
          temperature: 0.05
        });

        const content = extractContent(result);
        const classifiedMarks = parseClassifyResponse(content);
        const errorMarks = classifiedMarks.filter(m => m.isError).length;
        console.log(`[scanner] Zhipu VL classified ${classifiedMarks.length} marks: ${errorMarks} errors`);
        return { classifiedMarks, errorQuestionNumbers: new Set() };
      } catch (e) {
        if (e.message === 'ZhipuVLRateLimit' && attempt < 2) {
          const wait = 30000 * (attempt + 1);
          console.log(`[scanner] Classify rate-limited, waiting ${wait / 1000}s before retry ${attempt + 1}/2...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        console.log(`[scanner] Zhipu VL failed (${e.message}), falling back to Kimi...`);
        break;
      }
    }
  }

  // Fallback: Kimi k2.6 (DashScope)
  console.log('[scanner] Classifying red marks via Kimi VL...');
  const body = JSON.stringify({
    model: 'kimi-k2.6',
    messages: [
      { role: 'system', content: '你精准识别红笔批改标记。只输出JSON。' },
      { role: 'user', content: userContent }
    ],
    temperature: 0.05,
    max_tokens: 4000
  });
  
  return new Promise((resolve, reject) => {
    // Kimi 通道走阿里云 DashScope compatible-mode（KIMI_API_KEY 是 DashScope key，非 moonshot key）
    const url = new URL('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 120_000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          const content = extractContent(result);
          const classifiedMarks = parseClassifyResponse(content);
          
          const totalMarks = classifiedMarks.length;
          const errorMarks = classifiedMarks.filter(m => m.isError).length;
          const nonErrorMarks = totalMarks - errorMarks;
          
          console.log(`[scanner] Kimi VL classified ${totalMarks} marks: ${errorMarks} errors, ${nonErrorMarks} non-errors`);
          
          resolve({ classifiedMarks, errorQuestionNumbers: new Set() });
        } catch (e) {
          console.log(`[scanner] VL mark classification failed: ${e.message}. Falling back to centroid-based judgment.`);
          resolve({ classifiedMarks: [], errorQuestionNumbers: new Set(), fallback: true });
        }
      });
    });
    
    req.on('error', (e) => {
      console.log(`[scanner] VL classification request failed: ${e.message}, using centroid fallback`);
      resolve({ classifiedMarks: [], errorQuestionNumbers: new Set(), fallback: true });
    });
    req.on('timeout', () => {
      req.destroy();
      console.log('[scanner] VL classification timed out, using centroid fallback');
      resolve({ classifiedMarks: [], errorQuestionNumbers: new Set(), fallback: true });
    });
    req.write(body);
    req.end();
  });
}

// ═══════════════════════════════════════
// v3.4: Updated centroid matching with VL classification
// ═══════════════════════════════════════

/**
 * Check if a point falls within an expanded bbox.
 * @param {{x:number,y:number}} centroid 
 * @param {{x:number,y:number,w:number,h:number}} bbox
 * @param {number} marginPct - expansion margin (0.1 = 10%)
 */
function centroidInBbox(centroid, bbox, marginPct = 0.1) {
  const mxW = bbox.w * marginPct;
  const mxH = bbox.h * marginPct;
  const x1 = bbox.x - mxW;
  const y1 = bbox.y - mxH;
  const x2 = bbox.x + bbox.w + mxW;
  const y2 = bbox.y + bbox.h + mxH;
  return centroid.x >= x1 && centroid.x <= x2 && centroid.y >= y1 && centroid.y <= y2;
}

/**
 * For each question, count centroids and apply VL classification results.
 * Per error-identification-logic v3.0:
 *   - isError = VL classified as "cross" OR "correct_answer" (letter/word)
 *   - ✓, underline, circle, annotation are NOT errors
 * Falls back to centroid-count threshold if VL classification unavailable.
 */
// ═══════════════════════════════════════════════════════════════════
// v5.2 语义比对判错（路线图 2b）: 学生答案 vs 红笔正确字母
//   两者都有时是最高优先级证据，直接覆盖几何/VL 判定:
//   不相等 → 错题 | 相等 → 对题（推翻质心/VL 误判）
//   证据不全（缺任一）→ 返回 null 交回几何/VL 兜底
// ═══════════════════════════════════════════════════════════════════
function semanticJudge(q) {
  const sa = String(q.studentAnswer || '').trim().toUpperCase();
  const ca = String(q.correctAnswer || q.redAnswer || '').trim().toUpperCase();
  if (!sa || !ca) return null;
  // 取首个选项字母（学生可能写 "B." / "b" / 多字母粘连）
  const first = s => (s.match(/[A-Z]/) || [''])[0];
  const a = first(sa), b = first(ca);
  if (!a || !b || a < 'A' || a > 'F' || b < 'A' || b > 'F') return null;
  // v5.3: 证据自洽检查 — 红笔字母与读取到的正确答案首字母不一致 → 读数噪声，弃权
  // （实测Q27: stu=C corr=B red=D 三字母互异，GT实为对题）
  const ra = first(String(q.redAnswer || '').trim().toUpperCase());
  if (ra && ra >= 'A' && ra <= 'F' && ra !== b) return null;
  return a !== b;
}

function applySemanticOverride(q) {
  const semantic = semanticJudge(q);
  if (semantic === null) return false;
  if (semantic !== q.isError) {
    q._semanticOverride = true;  // 语义推翻了几何/VL 判定（复核界面可标注）
  }
  q.isError = semantic;
  q.errorSource = semantic ? 'semantic_mismatch' : 'semantic_match';
  return true;
}

function matchCentroidsToQuestions(questions, regions, pageStats, vlClassifiedMarks = null, textinHWRegions = null) {
  const MIN_RED_ENERGY = Math.max(pageStats.median * 3, 100);
  const results = [];
  
  // Track which region indices have been assigned to prevent one red mark
  // from counting against two adjacent questions
  const assignedRegions = new Set();
  
  for (const q of questions) {
    if (!q.bbox || q.bbox.w == null) {
      results.push({ ...q, centroidCount: 0, redEnergy: 0, matchedRegions: [], markTypes: [], redAnswer: '', isError: false, errorSource: null });
      continue;
    }
    
    const matched = [];
    let redEnergy = 0;
    
    for (let ri = 0; ri < (regions || []).length; ri++) {
      if (assignedRegions.has(ri)) continue; // Already belongs to another question
      const reg = regions[ri];
      if (!reg.centroid) continue;
      
      // Stricter match: centroid must be within bbox with NO margin expansion
      // This prevents boundary-adjacent marks from counting for both neighbor questions
      if (centroidInBbox(reg.centroid, q.bbox, 0)) {
        matched.push(reg);
        assignedRegions.add(ri);
        redEnergy += reg.area || 0;
      }
    }
    
    const centroidCount = matched.length;
    
    // v4.5: TextIn handwritten region cross-validation
    // Red centroid + TextIn handwritten region overlap = strong correction signal
    let textinOverlapCount = 0;
    if (textinHWRegions && textinHWRegions.length > 0 && matched.length > 0) {
      for (const reg of matched) {
        if (!reg.centroid) continue;
        for (const hw of textinHWRegions) {
          if (!hw.bbox || !hw.bbox.w) continue;
          if (centroidInBbox(reg.centroid, hw.bbox, 0.15)) {
            textinOverlapCount++;
            break;
          }
        }
      }
    }

    // Use VL classification when available, fall back to centroid threshold
    let isError = false;
    let errorSource = null;
    let markTypes = [];
    let redAnswer = '';

    if (vlClassifiedMarks && vlClassifiedMarks.length > 0) {
      // Look for VL-classified marks that match this question
      const qMarks = vlClassifiedMarks.filter(m => {
        // 按 position 文本中出现的整数题号精确匹配
        // （includes 子串匹配会让 Q1 偷走 "题号11旁边" 的标记）
        if (m.position) {
          const nums = m.position.match(/\d+/g);
          if (nums && nums.some(n => parseInt(n, 10) === q.questionNumber)) {
            return true;
          }
        }
        return false;
      });

      // v4.9: 红笔正确答案字母（type=correct_answer 的 content）
      const redMark = qMarks.find(m => m.type === 'correct_answer' && m.content);
      if (redMark) redAnswer = String(redMark.content).trim().toUpperCase();
      
      if (qMarks.length > 0) {
        markTypes = qMarks.map(m => m.type);
        isError = qMarks.some(m => m.isError);
        errorSource = isError ? 'vl_classified' : 'vl_classified_non_error';
      } else if (centroidCount > 0) {
        // Has red ink but VL didn't match → use centroid threshold
        // v4.5: TextIn overlap lowers the bar (1 centroid + textin overlap = likely error)
        const baseThreshold = textinOverlapCount >= 1 ? 1 : 3;
        const energyThreshold = textinOverlapCount >= 1 ? MIN_RED_ENERGY : MIN_RED_ENERGY * 2;
        isError = centroidCount >= baseThreshold || redEnergy >= energyThreshold;
        errorSource = isError ? (textinOverlapCount >= 1 ? 'centroid_textin_overlap' : 'centroid_fallback') : null;
      }
    } else {
      // No VL classification available → fall back to centroid threshold
      // v4.5: TextIn overlap provides additional evidence
      if (textinOverlapCount >= 1 && centroidCount >= 1) {
        isError = true;
        errorSource = 'textin_overlap';
      } else {
        isError = centroidCount >= 2 || redEnergy >= MIN_RED_ENERGY;
        errorSource = isError ? 'red_centroids' : null;
      }
    }

    // v5.2 ①: 语义比对优先 — 学生答案与红笔字母都有时直接定对错
    // （消灭"红笔在旁边但题没错"型 FP — 高一下过杀的根因之一）
    const semantic = semanticJudge({ studentAnswer: q.studentAnswer, correctAnswer: redAnswer || q.correctAnswer });
    if (semantic !== null) {
      isError = semantic;
      errorSource = semantic ? 'semantic_mismatch' : 'semantic_match';
    }

    // v5.2 ③: 听力保守规则 — 听力区红笔多为批改痕迹（划线/勾）而非答案键，
    // 几何/质心证据不判错；仅语义比对或 VL 明确判错标记可以判
    const qType = String(q.questionType || '').toLowerCase();
    if (qType === 'listening' && errorSource && !errorSource.startsWith('semantic') && errorSource !== 'vl_classified') {
      isError = false;
      errorSource = 'listening_conservative';
    }

    // v4.9: 展开 ...q 保留全部原始字段（passageText/passageRef/section/_cropSrc 等，
    // 此前显式字段清单会丢弃 passageText 导致阅读理解文章断流）
    results.push({
      ...q,
      hasRed: centroidCount > 0,
      centroidCount,
      redEnergy,
      isError,
      errorSource,
      markTypes,
      redAnswer,
      studentAnswer: q.studentAnswer || '',
      correctAnswer: q.correctAnswer || redAnswer || '',
      matchedRegions: matched.map(r => ({ cx: r.centroid.x, cy: r.centroid.y, area: r.area }))
    });
  }
  
  return results;
}

// ═══════════════════════════════════════
// v4.9: 裁剪图答案读取 — 补齐 studentAnswer/correctAnswer
// （correctAnswer 的零成本来源是 vlMarks 红笔字母；studentAnswer 需读裁剪图）
// ═══════════════════════════════════════
async function readCropAnswers(cropPath, variant = false) {
  const imageB64 = imgToBase64(cropPath);
  const prompt = variant
    ? `Look at this cropped exam question image carefully.
Printed text and options are in black ink. The teacher's red-pen marking is visible: a red letter usually means the CORRECT answer written by the teacher; ✗/✓ are judgment marks. The STUDENT's own handwriting (pencil/blue/black pen) is separate from red pen — look near the options (circled), beside the question number, inside ( ), or on the ____ blank.
Output ONLY JSON:
{"studentAnswer": "<student's own letter/word, EMPTY string if no student handwriting visible>", "correctAnswer": "<red-pen correct answer, EMPTY if none>"}`
    : `这是一道高中试卷题目的裁剪图，包含：
- 印刷体题目和选项（黑字）
- 老师的红笔批改：题号旁的红笔字母通常是老师标注的正确答案；✗/勾是判定标记
- 学生的作答：蓝笔/黑笔/铅笔写的字母或单词，常见位置——选项旁圈选、题号旁、括号( )内、空格____上

请分别读出：
1. studentAnswer — 学生自己的作答（铅笔/蓝笔/黑笔笔迹）。⚠️ 红笔字母是老师的，不要当成学生答案；确实看不到学生笔迹就填 ""
2. correctAnswer — 红笔标注的正确答案字母/内容（没有填 ""）

只输出JSON：{"studentAnswer":"","correctAnswer":""}`;

  const result = await zhipuVLRequest({
    model: MODEL_ZHIPU_VL,
    messages: [
      { role: 'system', content: '只输出JSON，无其他文字。' },
      { role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageB64, detail: 'high' } }
      ]}
    ],
    temperature: variant ? 0.3 : 0.1,
    max_tokens: 200
  });

  const content = (result.choices?.[0]?.message?.content || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/g, '');
  let parsed = {};
  try { parsed = JSON.parse(content); }
  catch { const m = content.match(/\{[\s\S]*\}/); if (m) { try { parsed = JSON.parse(m[0]); } catch {} } }
  return {
    studentAnswer: (parsed.studentAnswer || '').trim().toUpperCase().slice(0, 40),
    correctAnswer: (parsed.correctAnswer || '').trim().toUpperCase().slice(0, 40)
  };
}

// ═══════════════════════════════════════
// Single page scan
// ═══════════════════════════════════════

export async function scanPage(pagePath, { apiKey, outputDir, pageIndex = 1, markingMethod = 'red_pen', tencentSecret = null, subject = '自动' }) {
  const imageB64 = imgToBase64(pagePath);
  
  // v4.1: 尝试智谱 DirectJudge（端到端双图判错），如果成功则跳过质心匹配
  if (USE_ZHIPU_VL) {
    try {
      // 先并行获取预处理图（红笔突出图）
      const ppImageResult = await detectPreprocess(imageB64);
      const redHighlightedPath = ppImageResult.red_highlighted;
      
      if (redHighlightedPath) {
        console.log(`[scanner] Page ${pageIndex}: Trying Zhipu DirectJudge...`);
        const djResult = await directJudgeDualImage(pagePath, redHighlightedPath, subject);
        
        if (djResult.errors.length > 0 || true) {  // 即使 0 errors 也算成功
          // DirectJudge 成功，直接返回结果
          const errors = djResult.errors.map(e => ({ ...e, pageIndex }));
          console.log(`[scanner] Page ${pageIndex}: DirectJudge found ${errors.length} errors`);
          
          return {
            pageIndex,
            version: SCANNER_VERSION + '-direct-judge',
            engine: 'zhipu-vl-direct-judge',
            totalQuestions: errors.length,  // DirectJudge 只报告错题，总数未知
            totalErrors: errors.length,
            redSignal: 0,
            pageStats: {},
            totalRegions: 0,
            vlMarkCount: 0,
            classificationFallback: false,
            questions: errors,  // questions 和 errors 相同
            errors,
            correctedImage: ppImageResult.corrected,
            redHighlightedImage: redHighlightedPath,
            imageSize: null,
            directJudgeMode: true
          };
        }
      }
    } catch (djErr) {
      console.log(`[scanner] Page ${pageIndex}: DirectJudge failed (${djErr.message}), falling back to pipeline...`);
    }
  }
  
  // Fallback: 原有流水线（OCR + 质心 + VL 分类）
  const [ocrResult, redCentroidResult, ppImageResult] = await Promise.all([
    (async () => {
      try {
        return { ok: true, data: await extractQuestionsVL(pagePath, apiKey), engine: 'vl' };
      } catch (vlErr) {
        console.log(`[scanner] Page ${pageIndex}: VL OCR failed (${vlErr.message}), trying Tencent...`);
        if (tencentSecret) {
          try {
            return { ok: true, data: await extractQuestionsTencent(pagePath, tencentSecret), engine: 'tencent' };
          } catch (tcErr) {
            throw new Error(`Both VL and Tencent OCR failed for page ${pageIndex}: ${tcErr.message}`);
          }
        }
        throw vlErr;
      }
    })(),
    detectRedCentroids(imageB64),
    detectPreprocess(imageB64)
  ]);
  
  if (!ocrResult.ok) throw new Error(`OCR failed for page ${pageIndex}`);
  
  const vlQuestions = ocrResult.data.questions || [];
  const regions = redCentroidResult.regions || [];
  const pageStats = redCentroidResult.page_stats || { median: 0, mean: 0, p75: 0 };
  const redHighlightedPath = ppImageResult.red_highlighted;
  
  console.log(`[scanner] Page ${pageIndex}: ${vlQuestions.length} questions, ${regions.length} red regions (median area=${pageStats.median})`);
  
  // v3.4: VL classify red marks on this page
  let vlMarks = [];
  let classificationFallback = false;
  if (redHighlightedPath && regions.length > 0) {
    try {
      const classifyResult = await classifyRedMarksVL(redHighlightedPath, vlQuestions, apiKey);
      vlMarks = classifyResult.classifiedMarks || [];
      classificationFallback = classifyResult.fallback || false;
    } catch (e) {
      console.log(`[scanner] Page ${pageIndex}: VL classification error (${e.message}), using centroid fallback`);
    }
  }
  
  // Match centroids to questions, now with VL classification
  const questions = matchCentroidsToQuestions(
    vlQuestions.map(q => ({ ...q, pageIndex })), 
    regions, 
    pageStats,
    vlMarks
  );
  
  const errors = questions.filter(q => q.isError);
  
  return {
    pageIndex,
    version: SCANNER_VERSION,
    engine: 'vl-ocr + preprocess-v8.0-centroids + vl-mark-classify',
    totalQuestions: questions.length,
    totalErrors: errors.length,
    redSignal: redCentroidResult.red_signal,
    pageStats,
    totalRegions: regions.length,
    vlMarkCount: vlMarks.length,
    classificationFallback,
    questions,
    errors,
    correctedImage: ppImageResult.corrected,
    redHighlightedImage: redHighlightedPath,
    imageSize: ocrResult.data.imageSize || null
  };
}

// ═══════════════════════════════════════


/**
 * v4.3: Calls preprocess /split-columns endpoint → splits dual-column page into left/right halves.
 * @param {string} imagePath - path to the page image
 * @returns {{ isDual: boolean, midline: number, leftPath: string|null, rightPath: string|null }}
 */
async function splitColumns(imagePath) {
  const u = new URL(PREPROCESS_URL);
  const b64 = imgToBase64(imagePath);
  try {
    const data = await httpPostJson(u.hostname, parseInt(u.port) || 5002, '/split-columns', {
      image: b64,
      options: {}  // auto-detect mode
    }, 30_000);
    
    if (data.status !== 'ok') return { isDual: false, midline: 0, leftPath: null, rightPath: null };
    const r = data.result;
    if (!r.is_dual_column) return { isDual: false, midline: r.midline_x, leftPath: null, rightPath: null };
    
    // Save left/right images to temp files
    const leftPath = join(tmpdir(), `gaozhong-split-left-${Date.now()}.jpg`);
    const rightPath = join(tmpdir(), `gaozhong-split-right-${Date.now()}.jpg`);
    
    for (const [side, path] of [['left_image', leftPath], ['right_image', rightPath]]) {
      const imgB64 = r[side];
      if (imgB64 && imgB64.includes(',')) {
        writeFileSync(path, Buffer.from(imgB64.split(',')[1], 'base64'));
      } else {
        return { isDual: false, midline: r.midline_x, leftPath: null, rightPath: null };
      }
    }
    
    console.log(`[scanner] Split dual-column page at midline=${r.midline_x}: left=${r.left_size?.width}x${r.left_size?.height}, right=${r.right_size?.width}x${r.right_size?.height}`);
    return { isDual: true, midline: r.midline_x, leftPath, rightPath };
  } catch (e) {
    console.log(`[scanner] split-columns failed: ${e.message}`);
    return { isDual: false, midline: 0, leftPath: null, rightPath: null };
  }
}

// MULTI-PAGE PARALLEL SCAN (v3.3)
// ═══════════════════════════════════════

export async function scanPages(pagePaths, { apiKey, outputDir, markingMethod = 'red_pen', tencentSecret = null, subject = '自动', dualColumn = true }) {
  const totalStart = Date.now();
  const useTextIn = textinEnabled();
  console.log(`[scanner v4.6] Scanning ${pagePaths.length} pages (TextIn=${useTextIn}, VL=${VL_CONCURRENCY}, PP=${PREPROCESS_CONCURRENCY})`);
  
  // Preflight: check preprocess v8.0 is alive, restart if dead
  try { await detectPreflight(); } catch (e) {
    throw new Error(`预处理服务不可用 (port 5002): ${e.message}`);
  }
  
  // ═══ v4.5: Phase 0.5 — 页面准备 (旋转+分页+排序) ═══
  const prepareTempFiles = [];
  {
    console.log(`[scanner] Phase 0.5: preparing pages from ${pagePaths.length} photos...`);
    const allB64 = pagePaths.map(pp => imgToBase64(pp));
    const u = new URL(PREPROCESS_URL);
    const host = u.hostname;
    const port = parseInt(u.port) || 5002;

    const prepData = await httpPostJson(host, port, '/prepare-pages', { images: allB64 }, 60_000);
    if (prepData.status !== 'ok') throw new Error(`prepare-pages failed: ${prepData.error}`);

    const newPagePaths = [];
    for (const p of prepData.pages) {
      const b64Data = p.image.includes(',') ? p.image.split(',')[1] : p.image;
      const tmpPath = join(tmpdir(), `gaozhong-page-${p.index}-${Date.now()}.jpg`);
      writeFileSync(tmpPath, Buffer.from(b64Data, 'base64'));
      prepareTempFiles.push(tmpPath);
      newPagePaths.push(tmpPath);
    }

    const { photos, pages, cropped, split, rotated } = prepData.stats || {};
    console.log(`[scanner] Prepared: ${photos} photos → ${pages} pages (${cropped} cropped, ${split} split, ${rotated} rotated)`);

    pagePaths = newPagePaths;  // 替换为准备好的独立页面序列
  }

  // ═══════════════════════════════════════
  // Phase 1: Dual-column split on ORIGINAL images (before de-red)
  // TextIn will use original split halves; VL will get de-red versions later
  // ═══════════════════════════════════════
  const splitTempFiles = [];
  const pageSplitMap = []; // pageSplitMap[pageIndex] = { isDual, leftPath, rightPath, midline }

  if (dualColumn) {
    console.log(`[scanner] Dual-column mode: splitting ${pagePaths.length} original pages...`);
    const splitGate = new ConcurrencyGate(PREPROCESS_CONCURRENCY);
    const splitJobs = pagePaths.map((imgPath, i) =>
      splitGate.run(async () => {
        const result = await splitColumns(imgPath);
        return { index: i, ...result };
      })
    );
    const splitResults = await Promise.all(splitJobs);

    for (const sr of splitResults) {
      pageSplitMap[sr.index] = sr;
      if (sr.isDual) {
        if (sr.leftPath) splitTempFiles.push(sr.leftPath);
        if (sr.rightPath) splitTempFiles.push(sr.rightPath);
      }
    }

    const dualCount = splitResults.filter(r => r.isDual).length;
    console.log(`[scanner] Dual-column split: ${dualCount}/${splitResults.length} pages → ${dualCount * 2} halves`);
  } else {
    for (let i = 0; i < pagePaths.length; i++) {
      pageSplitMap[i] = { isDual: false, leftPath: null, rightPath: null, midline: 0 };
    }
  }

  // ═══════════════════════════════════════
  // Phase 2: Preprocess + de-red + red centroids
  // For split pages: run de-red on each split half (for VL)
  // For non-split pages: run de-red on full page
  // ═══════════════════════════════════════
  const ppGate = new ConcurrencyGate(PREPROCESS_CONCURRENCY);
  const preprocessJobs = pagePaths.map((pp, i) =>
    ppGate.run(async () => {
      const b64 = imgToBase64(pp);
      const [centroids, images, deRed] = await Promise.all([
        detectRedCentroids(b64),
        detectPreprocess(b64),
        deRedImage(b64).catch(e => {
          console.log(`[scanner] Page ${i + 1}: de-red failed (${e.message}), will use original`);
          return null;
        })
      ]);
      return { index: i, centroids, images, deRed };
    })
  );

  const ppResults = await Promise.all(preprocessJobs);
  const ppTime = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`[scanner] All prep done in ${ppTime}s`);

  // Build de-red image paths for VL OCR
  // For split pages: de-red each half separately
  const deRedTempFiles = [];
  const deRedPaths = []; // deRedPaths[pageIndex] = { full, left, right }

  for (let i = 0; i < pagePaths.length; i++) {
    const deRed = ppResults.find(r => r.index === i)?.deRed;
    const entry = { full: null, left: null, right: null };

    const saveB64 = (b64Str) => {
      if (!b64Str) return null;
      const tmpPath = join(tmpdir(), `gaozhong-dered-${i}-${Date.now()}.jpg`);
      const data = b64Str.includes(',') ? b64Str.split(',')[1] : b64Str;
      writeFileSync(tmpPath, Buffer.from(data, 'base64'));
      deRedTempFiles.push(tmpPath);
      return tmpPath;
    };

    if (deRed && deRed.cleanBase64) {
      const fullDeRed = saveB64(deRed.cleanBase64);
      const split = pageSplitMap[i];
      if (split && split.isDual) {
        // Create de-red copies for each split half (for VL)
        // Since de-red was on full page, we need to split the de-red result
        // Fallback: use the full de-red path for each half; VL will still work
        entry.left = fullDeRed;
        entry.right = fullDeRed;
      } else {
        entry.full = fullDeRed;
      }
    }
    deRedPaths.push(entry);
  }

  // ═══════════════════════════════════════
  // Phase 3: OCR — TextIn first (full page), VL fallback (split if dual)
  // TextIn has built-in layout analysis — send FULL pages, never pre-split
  // VL benefits from split halves (smaller images, focused prompt)
  // ═══════════════════════════════════════
  const ocrGate = new ConcurrencyGate(VL_CONCURRENCY);
  const totalPages = pagePaths.length;

  // --- Pass 1: TextIn OCR (per-page) + LLM merged parsing ---
  const textInResults = []; // textInResults[pageIndex] = result or null
  let mergedPageStatus = []; // v5.0 ①: preprocess 透传的页级解析状态
  if (useTextIn) {
    try {
      // v5.0: 识别主力 = exam extract（v3 智能抽取 + 五层完善）；EXAM_API=0 可关闭
      let mergedResult = null;
      if (process.env.EXAM_API !== '0') {
        try {
          console.log(`[scanner] Exam extract (v3 + refine): ${pagePaths.length} pages...`);
          mergedResult = await extractQuestionsExamAPI(pagePaths, { subject });
          console.log(`[scanner] Exam extract: ${mergedResult.totalQuestions} questions total`);
        } catch (examErr) {
          console.log(`[scanner] Exam extract failed (${examErr.message}), falling back to OCR+LLM merged...`);
          mergedResult = null;
        }
      }
      if (!mergedResult) {
        console.log(`[scanner] TextIn merged: OCR ${pagePaths.length} pages + LLM parsing...`);
        mergedResult = await extractQuestionsTextInMerged(pagePaths, { subject });
        console.log(`[scanner] TextIn merged: ${mergedResult.totalQuestions} questions total`);
      }
      mergedPageStatus = mergedResult.pageStatus || [];

      // Split merged result back to per-page for downstream processing
      // v4.8: redistribute questions to their own pages via question.pageIndex
      // (llm_parser 已用 OCR item 实际位置修正 pageIndex，可信)
      const byPage = {};
      for (const q of (mergedResult.questions || [])) {
        const pi = Math.min(Math.max((q.pageIndex || 1) - 1, 0), pagePaths.length - 1);
        // v4.9: 记录裁剪源（bbox 与 prepared 整页同坐标系）
        q._cropSrc = pagePaths[pi];
        (byPage[pi] = byPage[pi] || []).push(q);
      }
      const hwByPage = {};
      for (const hw of (mergedResult.handwrittenRegions || [])) {
        const pi = Math.min(Math.max((hw.pageIndex || 1) - 1, 0), pagePaths.length - 1);
        (hwByPage[pi] = hwByPage[pi] || []).push(hw);
      }
      for (let i = 0; i < pagePaths.length; i++) {
        textInResults[i] = {
          pageIndex: i,
          result: {
            questions: byPage[i] || [],
            passages: mergedResult.passages || [],
            handwrittenRegions: hwByPage[i] || [],
            detailCount: mergedResult.detailCount || 0
          },
          engine: mergedResult.engine || 'textin-llm-merged',
          attempts: 1, success: true
        };
      }
    } catch (err) {
      console.log(`[scanner] TextIn merged failed (${err.message}), falling back to per-page`);
      // Fallback: per-page TextIn + regex
      const textInJobs = pagePaths.map((imgPath, i) =>
        ocrGate.run(async () => {
          try {
            const result = await extractQuestionsTextIn(imgPath, { subject });
            console.log(`[scanner] Page ${i+1}: TextIn ok — ${result.totalQuestions} questions`);
            for (const q of (result.questions || [])) q._cropSrc = imgPath;  // v4.9: 裁剪源
            return { pageIndex: i, result, engine: 'textin', attempts: 1, success: true };
          } catch (err2) {
            console.log(`[scanner] Page ${i+1}: TextIn failed (${err2.message})`);
            return { pageIndex: i, result: null, engine: null, attempts: 0, success: false };
          }
        })
      );
      const tiResults = await Promise.all(textInJobs);
      for (const r of tiResults) {
        textInResults[r.pageIndex] = r.success ? r : null;
      }
    }
  }

  // --- Pass 2: VL fallback for pages with poor TextIn coverage ---
  // v5.0 ①: 三种触发 — (a)页级状态 llm_failed/regex 且 0 题（LLM 批次失败不再整页蒸发）
  //                        (b)低 OCR 覆盖（原逻辑，detailCount < 30 且 0 题）
  const VL_MIN_THRESHOLD = 30;
  const vlJobs = [];
  for (let i = 0; i < pagePaths.length; i++) {
    if (textInResults[i]) {
      const qCount = (textInResults[i].result?.questions || []).length;
      const pStatus = mergedPageStatus[i] || 'ok';
      if (qCount === 0 && (pStatus === 'llm_failed' || pStatus === 'regex')) {
        console.log(`[scanner] Page ${i+1}: pageStatus=${pStatus} 且 0 题 → VL 兜底`);
        textInResults[i] = null;
      } else {
        const detailCount = textInResults[i].result?.detailCount || 0;
        if (detailCount > 0 && detailCount < VL_MIN_THRESHOLD && qCount === 0) {
          console.log(`[scanner] Page ${i+1}: TextIn low coverage (${detailCount} items < ${VL_MIN_THRESHOLD}) and 0 questions, will VL fallback`);
          textInResults[i] = null; // Force VL fallback for this page
        }
      }
    }
    if (textInResults[i]) continue;

    const split = pageSplitMap[i];
    if (split && split.isDual) {
      vlJobs.push({ pageIndex: i, subPage: 'left',  imgPath: split.leftPath,  totalPages });
      vlJobs.push({ pageIndex: i, subPage: 'right', imgPath: split.rightPath, totalPages });
    } else {
      vlJobs.push({ pageIndex: i, subPage: null, imgPath: deRedPaths[i]?.full || pagePaths[i], totalPages });
    }
  }

  const vlGate = new ConcurrencyGate(VL_CONCURRENCY);
  const vlRawResults = vlJobs.length > 0 ? await Promise.all(
    vlJobs.map((job) =>
      vlGate.run(async () => {
        const label = job.subPage
          ? `Page ${job.pageIndex + 1}.${job.subPage}`
          : `Page ${job.pageIndex + 1}`;
        console.log(`[scanner] ${label}: VL fallback OCR...`);
        try {
          const result = await extractQuestionsVL(job.imgPath, apiKey, job.subPage, job.pageIndex, job.totalPages);
          // v4.9: VL 路径 bbox 与输入图（半页/去红图）同坐标系，记录裁剪源
          for (const q of (result.questions || [])) q._cropSrc = job.imgPath;
          return { ...job, result, engine: 'vl', attempts: 1, success: true };
        } catch (vlErr) {
          console.log(`[scanner] ${label}: VL failed (${vlErr.message}), skipped`);
          return { ...job, result: { questions: [], imageSize: null }, engine: 'failed', success: false };
        }
      })
    )
  ) : [];

  // Combine results
  const vlByPage = {};
  for (const r of vlRawResults) {
    if (!vlByPage[r.pageIndex]) vlByPage[r.pageIndex] = [];
    vlByPage[r.pageIndex].push(r);
  }

  const ocrRawResults = [];
  for (let i = 0; i < pagePaths.length; i++) {
    if (textInResults[i]) {
      ocrRawResults.push({ pageIndex: i, subPage: null, ...textInResults[i] });
    } else {
      const vlGroup = vlByPage[i] || [];
      for (const r of vlGroup) {
        ocrRawResults.push(r);
      }
      if (vlGroup.length === 0) {
        console.log(`[scanner] Page ${i+1}: no OCR result, skipped`);
        ocrRawResults.push({ pageIndex: i, subPage: null, result: { questions: [], imageSize: null }, engine: 'failed', success: false, attempts: 0 });
      }
    }
  }
  
  // Merge split sub-page results back into per-page results
  const ocrResults = [];
  const pageGroups = {};
  for (const r of ocrRawResults) {
    const key = r.pageIndex;
    if (!pageGroups[key]) pageGroups[key] = [];
    pageGroups[key].push(r);
  }
  
  for (let i = 0; i < pagePaths.length; i++) {
    const group = pageGroups[i] || [];
    if (group.length === 0) {
      ocrResults.push({ index: i, result: { questions: [], imageSize: null }, engine: 'failed', skipped: true, attempts: 0 });
      continue;
    }
    
    if (group.length === 1) {
      // Single result (no split)
      ocrResults.push({ index: i, ...group[0] });
    } else {
      // Merged split results: concatenate questions from left + right
      const allQuestions = [];
      for (const sub of group) {
        if (sub.result?.questions) {
          allQuestions.push(...sub.result.questions);
        }
      }
      const engines = [...new Set(group.map(g => g.engine))];
      const totalAttempts = group.reduce((s, g) => s + (g.attempts || 1), 0);
      // Merge handwrittenRegions from all sub-results
      const allHWRegions = [];
      for (const sub of group) {
        if (sub.result?.handwrittenRegions) {
          allHWRegions.push(...sub.result.handwrittenRegions);
        }
      }
      console.log(`[scanner] Page ${i + 1}: merged ${group.length} split results → ${allQuestions.length} questions, ${allHWRegions.length} HW regions`);
      ocrResults.push({
        index: i,
        result: { questions: allQuestions, imageSize: null, handwrittenRegions: allHWRegions },
        engine: engines.join('+'),
        attempts: totalAttempts
      });
    }
  }
  
  // v4.9: 临时图清理移至题目裁剪之后（半页/去红/prepare 临时图是裁剪源，此处先保留）
  // Phase 3: VL classify red marks + centroid matching per page
  // 并发可经环境变量调低（限流通道如 glm-4.6v-flash 设为 1）
  const VL_CLASSIFY_CONCURRENCY = parseInt(process.env.VL_CLASSIFY_CONCURRENCY || '2');
  const classifyGate = new ConcurrencyGate(VL_CLASSIFY_CONCURRENCY);
  
  const pageResults = [];
  for (let i = 0; i < pagePaths.length; i++) {
    const pp = ppResults.find(r => r.index === i);
    const ocr = ocrResults.find(r => r.index === i);
    
    const vlQuestions = ocr.result.questions || [];
    const regions = pp.centroids.regions || [];
    const pageStats = pp.centroids.page_stats || { median: 0 };
    const redHighlightedPath = pp.images.red_highlighted;
    // v4.5: TextIn handwritten regions for cross-validation
    const textinHW = ocr.result.handwrittenRegions || null;
    
    // v3.4: VL classify red marks for this page
    let vlMarks = [];
    let classificationFallback = false;
    if (redHighlightedPath && regions.length > 0) {
      try {
        const classifyResult = await classifyGate.run(() => 
          classifyRedMarksVL(redHighlightedPath, vlQuestions, apiKey)
        );
        vlMarks = classifyResult.classifiedMarks || [];
        classificationFallback = classifyResult.fallback || false;
      } catch (e) {
        console.log(`[scanner] Page ${i + 1}: VL classification error (${e.message}), using centroid fallback`);
        classificationFallback = true;
      }
    }
    
    const questions = matchCentroidsToQuestions(
      vlQuestions.map(q => ({ ...q, pageIndex: i + 1 })),
      regions,
      pageStats,
      vlMarks,
      textinHW
    );
    
    // v5.0 ①: 页级状态 — VL 引擎 = 兜底恢复；llm_failed/regex/failed = 低质
    const pageStatus = ocr.engine === 'failed' ? 'failed'
      : String(ocr.engine).includes('vl') ? 'vl_recovered'
      : (mergedPageStatus[i] || 'ok');

    pageResults.push({
      pageIndex: i + 1,
      engine: ocr.engine,
      pageStatus,
      totalQuestions: questions.length,
      totalErrors: questions.filter(q => q.isError).length,
      redSignal: pp.centroids.red_signal,
      pageStats,
      totalRegions: regions.length,
      vlMarkCount: vlMarks.length,
      classificationFallback,
      questions,
      errors: questions.filter(q => q.isError),
      correctedImage: pp.images.corrected,
      redHighlightedImage: redHighlightedPath
    });
  }

  // v5.0 ①: 低质页清单（状态非 ok），供 api-server 提示与前端黄条
  const lowQualityPages = pageResults
    .filter(p => p.pageStatus && p.pageStatus !== 'ok')
    .map(p => p.pageIndex);
  if (lowQualityPages.length > 0) {
    console.log(`[scanner] Low-quality pages: P${lowQualityPages.join(', P')} — 已按状态标记`);
  }
  
  // Post-OCR: cross-page passage merge
  const skipCount = pageResults.filter(p => p.engine === 'failed').length;
  const qCountRaw = pageResults.reduce((s, p) => s + p.questions.length, 0);
  mergeCrossPagePassages(pageResults);
  validateQuestionNumbers(pageResults);
  const qCountFinal = pageResults.reduce((s, p) => s + p.questions.length, 0);

  // ═══ v4.9: 按题裁剪题目图（bbox 与 _cropSrc 同坐标系）═══
  if (outputDir) {
    let cropOk = 0, cropFail = 0;
    for (const pr of pageResults) {
      for (const q of pr.questions) {
        const bb = q.bbox;
        if (!bb || !(bb.w > 5) || !(bb.h > 5) || !q.questionNumber) continue;
        const src = q._cropSrc || pagePaths[pr.pageIndex - 1];
        if (!src || !existsSync(src)) continue;
        const out = join(outputDir, `p${pr.pageIndex}_q${q.questionNumber}.jpg`);
        // v4.9: 外扩 padding — 学生作答常写在 bbox 边缘（题号旁/括号内/空格上）
        const padX = 15, padY = 10;
        const cx = Math.max(0, Math.round(bb.x) - padX);
        const cy = Math.max(0, Math.round(bb.y) - padY);
        const cw = Math.round(bb.w) + padX * 2;
        const ch = Math.round(bb.h) + padY * 2;
        try {
          execFileSync('convert', [
            src,
            '-crop', `${cw}x${ch}+${cx}+${cy}`,
            '+repage', '-resize', '900x>', '-quality', '75',
            out
          ], { timeout: 8000 });
          q._cropFile = out;
          cropOk++;
        } catch (_) {
          // 兜底: 开发机无 ImageMagick 时用 python cv2 裁剪（生产 Docker 有 convert）
          try {
            execFileSync('python', [
              join(__dirname, 'scripts', 'crop_image.py'),
              src,
              String(cx), String(cy), String(cw), String(ch),
              out
            ], { timeout: 8000 });
            q._cropFile = out;
            cropOk++;
          } catch (_2) { cropFail++; }
        }
      }
    }
    console.log(`[scanner] Question crops: ${cropOk} ok, ${cropFail} failed`);
  }

  // ═══ v5.2: 答案读取 — 扩展到所有有红笔字母或判错的题（语义比对证据最大化）═══
  if (USE_ZHIPU_VL) {
    const ansGate = new ConcurrencyGate(parseInt(process.env.ANSWER_READ_CONCURRENCY || '3'));
    const targets = pageResults
      .flatMap(p => p.questions)
      .filter(q => q._cropFile && !(q.studentAnswer && q.correctAnswer)
        && (q.isError || q.redAnswer || q.correctAnswer));
    if (targets.length > 0) {
      let dualAgree = 0, dualReject = 0;
      await Promise.all(targets.map(q => ansGate.run(async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const r = await readCropAnswers(q._cropFile);
            // v5.3 双读一致: 读数噪声是语义误判主因(实测Q27 stu/corr/red三字母互异)
            // 第一读取有学生答案时，换prompt+温度再读一次，首字母不一致→不采信
            if (r.studentAnswer) {
              try {
                const r2 = await readCropAnswers(q._cropFile, true);
                const L = s => (String(s).toUpperCase().match(/[A-Z]/) || [''])[0];
                if (L(r2.studentAnswer) && L(r2.studentAnswer) === L(r.studentAnswer)) {
                  q.studentAnswer = r.studentAnswer;
                  dualAgree++;
                } else {
                  q._answerReadInconsistent = true;  // 弃权，交回保守规则
                  dualReject++;
                }
              } catch (_) {
                q.studentAnswer = r.studentAnswer;  // 第二读失败(限流等)不阻塞
              }
            }
            if (r.correctAnswer) q.correctAnswer = r.correctAnswer;
            return;
          } catch (e) {
            if (e.message === 'ZhipuVLRateLimit' && attempt === 0) {
              await new Promise(r2 => setTimeout(r2, 20000));  // v4.9: 限流退避一次
              continue;
            }
            return; // 单题失败不影响整体
          }
        }
      })));
      const filled = targets.filter(q => q.studentAnswer || q.correctAnswer).length;
      console.log(`[scanner] Answer reading: ${filled}/${targets.length} errors enriched (dual-read: ${dualAgree} agree, ${dualReject} rejected)`);
    }
  }

  // ═══ v5.2 ② + v5.3: 二次语义判定 — 答案补全后比对一次 + 字母风格卷保守化 ═══
  {
    let overridden = 0, judged = 0;
    // v5.3 字母风格检测(强信号, 答案补全后): 红笔/正确答案字母覆盖率≥40%
    // = 教师每题写正确答案字母的批改风格。该风格下:
    // ① "红笔在旁边"≠"这题错了" → 几何/VL证据必然过杀(实测21/34 FP) → 不判错,人工勾选
    // ② 学生答案靠VL读图,存在稳定系统性误读(双读一致仍错,实测Q27 stu/corr/red三字母互异)
    //    → 语义判错降级 semantic_review(确认流黄灯), 不再绿灯自动入错题本
    const firstLetter = s => { const m = String(s || '').toUpperCase().match(/[A-F]/); return m ? m[0] : ''; };
    const allQs = pageResults.flatMap(p => p.questions);
    const withLetter = allQs.filter(q => firstLetter(q.redAnswer || q.correctAnswer)).length;
    const letterStyle = allQs.length > 0 && (withLetter / allQs.length) >= 0.40;
    let conserved = 0, demoted = 0;
    for (const pr of pageResults) {
      for (const q of pr.questions) {
        if (applySemanticOverride(q)) {
          judged++;
          if (q._semanticOverride) overridden++;
        }
        if (letterStyle && q.isError && q.errorSource) {
          if (String(q.errorSource).startsWith('semantic')) {
            q.errorSource = 'semantic_review';
            demoted++;
          } else {
            q.isError = false;
            q.errorSource = 'letter_style_conservative';
            conserved++;
          }
        }
      }
      pr.errors = pr.questions.filter(q => q.isError);
      pr.totalErrors = pr.errors.length;
    }
    if (letterStyle) {
      console.log(`[scanner] Letter-style paper: ${withLetter}/${allQs.length} letter coverage → ${conserved} non-semantic dropped (manual review), ${demoted} semantic demoted to review`);
    }
    if (judged > 0) {
      console.log(`[scanner] Semantic judge: ${judged} 题有完整答案证据, 其中 ${overridden} 题判定被语义推翻`);
    }
  }

  // v4.9: 清理临时图（延后到此 — 裁剪已用完半页/去红/prepare 源图）
  for (const f of [...deRedTempFiles, ...splitTempFiles, ...prepareTempFiles]) {
    try { unlinkSync(f); } catch (_) {}
  }
  
  const totalTime = ((Date.now() - totalStart) / 1000).toFixed(1);
  const allQuestions = pageResults.flatMap(p => p.questions);
  const allErrors = pageResults.flatMap(p => p.errors);
  
  console.log(`[scanner v4.5] Done: ${pageResults.length} pages, ${qCountFinal} questions, ${allErrors.length} errors in ${totalTime}s` +
    (skipCount ? ` (${skipCount} pages skipped)` : ''));
  
  return {
    version: SCANNER_VERSION,
    engine: 'vl-ocr-v4-per-page-parallel + preprocess-v8.0 + vl-mark-classify',
    pages: pageResults.length,
    totalQuestions: qCountFinal,
    totalErrors: allErrors.length,
    totalTime,
    skipCount,
    markingMethod,
    lowQualityPages,
    questions: allQuestions,
    errors: allErrors,
    pageResults
  };
}

// ═══════════════════════════════════════
// v4.1: Zhipu DirectJudge — 端到端双图判错
// ═══════════════════════════════════════

/**
 * 端到端双图判错：原图+红笔图一起发给 VL，一次完成 OCR+判错。
 * 跳过质心匹配环节，减少中间信息丢失。
 * 
 * @param {string} originalPath - 原图文件路径
 * @param {string} redHighlightedPath - 红笔突出图路径
 * @param {string} subject - 科目
 * @returns {Promise<{questions:[], errors:[]}>}
 */
async function directJudgeDualImage(originalPath, redHighlightedPath, subject) {
  const origB64 = imgToBase64(originalPath);
  const redB64 = redHighlightedPath ? imgToBase64(redHighlightedPath) : null;
  
  const subjectHint = subject && subject !== '自动' ? `\n当前学科：${subject}` : '';
  
  const prompt = `你是上海高中英语教研专家。你会收到同一页试卷的两张图片，任务是从中找出学生做错的题目。

═══════════════════════════════════════
【两张图的分工】
═══════════════════════════════════════
📷 图1（原图）：读取题目印刷文字 + 学生蓝/黑色笔迹作答
🔴 图2（红笔提取图）：白底只保留红色批改痕迹，非红色内容已淡化至极

═══════════════════════════════════════
【铁律 — 必须逐字遵守】
═══════════════════════════════════════
铁律1: 蓝色/黑色/铅笔笔迹 = 学生作答 → 只在图1查看
铁律2: 红色笔迹（手写） = 教师/同学批改 → 图2确认
铁律3: 红色印刷（标题、分隔线、题号）≠ 批改 → 忽略
铁律4: 只有红笔明确标记"错误"才算错题
铁律5: 不确定 → 跳过（对题），宁可漏判不要误判
铁律6: 每道题独立判断，不要因为上一题错了就假定这题也错

═══════════════════════════════════════
【工作流程 — 逐题判定】
═══════════════════════════════════════
第1步：在图1中找到每道题号，确定题目区域
第2步：在图1中读出学生写作答（蓝/黑笔迹选的是哪个选项）
第3步：切到图2，在同一题号区域查看是否有红笔标记
第4步：根据标记类型（下表）判定对错
第5步：如果该题在图2中没有任何标记 → ✅ 跳过（不是错题）

═══════════════════════════════════════
【红笔标记 → 判定表】
═══════════════════════════════════════

✗ 打叉（交叉斜线）→ ❌ 错题
  studentAnswer = 学生选的选项字母
  correctAnswer = 从题目选项中推断正确答案
  
红笔划掉学生答案 + 旁写新字母 → ❌ 错题
  studentAnswer = 被划掉的那个字母
  correctAnswer = 红笔新写的字母

红笔写字母但没划掉学生答案 → 对比判断
  红笔字母 ≠ 学生原选 → ❌ 错题
  红笔字母 = 学生原选 → ✅ 跳过

红笔圈出某选项 → 对比判断
  被圈选项 ≠ 学生原选 → ❌ 错题
  被圈选项 = 学生原选 → ✅ 跳过

红笔 ✓ 打勾 → ✅ 跳过（做对了）
红笔下划线/波浪线 → ✅ 跳过（标记重点）
红笔手写汉字注释（如"时态""主谓一致"）→ ✅ 跳过
红笔扣分标记（-2, -0.5）→ ❌ 错题
纯红笔横线划掉（无新答案）→ ❌ 错题
此题区域无任何红笔标记 → ✅ 跳过

═══════════════════════════════════════
【特殊场景处理】
═══════════════════════════════════════
英语试卷布局：
- 双栏排版：先读完左栏所有题，再读右栏
- 题号通常是连续的（21→22→23...），跨栏时跳到右栏顶部继续
- 阅读理解：先看文章，再找该文章的题目

学生答案识别：
- 学生在题号旁写字母（如题号旁写"B"）→ 这是学生的答案
- 学生在选项上打钩/圈选 → 这是学生的答案
- 如果学生没作答（空白）→ studentAnswer 填 ""

红笔 vs 学生笔迹区分：
- 同一题周围如有两个不同颜色的字母标记 → 红色=教师批改，蓝色/黑色=学生
- 如果只有一个颜色的字母，看颜色：蓝/黑→学生，红→教师

═══════════════════════════════════════
【质量自检 — 输出前必须完成】
═══════════════════════════════════════
⚠️ 回想这张试卷：你找到了几道错题？
- 正常一页试卷：3-10 道错题
- 如果你列了超过 15 道 → 重新逐题检查！
- 如果你列了 0 道 → 再仔细看图2，真的没有红笔标记吗？

⚠️ 每道错题的 studentAnswer 和 correctAnswer 都检查一遍：
- studentAnswer 确实是在图1中看到的蓝/黑笔迹吗？
- correctAnswer 确实是从红笔标记推断的吗？
- 两者确实不同吗？

═══════════════════════════════════════
【输出格式 — 严格纯JSON】
═══════════════════════════════════════

{
  "errors": [
    {
      "questionNumber": 21,
      "questionText": "完整题干文字（听力题可为空）",
      "questionType": "choice",
      "options": {"A":"选项A原文","B":"选项B原文","C":"选项C原文","D":"选项D原文"},
      "studentAnswer": "B",
      "correctAnswer": "D",
      "markType": "cross",
      "markDescription": "红笔在题号旁打叉并写D",
      "confidence": "high"
    }
  ]
}

如果你认为没有错题，输出: {"errors":[]}

直接输出JSON，不要markdown代码块。${subjectHint}`;

  const images = [
    { type: 'image_url', image_url: { url: origB64, detail: 'high' } }
  ];
  if (redB64) {
    images.push({ type: 'image_url', image_url: { url: redB64, detail: 'high' } });
  }

  const result = await zhipuVLRequest({
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: prompt }, ...images]
    }],
    max_tokens: 16000,
    temperature: 0.05
  });

  const content = extractContent(result);
  
  // Parse JSON
  const cleaned = content.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/g, '');
  
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error('DirectJudge: 无法解析 JSON');
  }
  
  const errors = (parsed.errors || []).map(e => ({
    questionNumber: e.questionNumber,
    questionText: e.questionText || '',
    questionType: e.questionType || 'choice',
    options: e.options || {},
    studentAnswer: (e.studentAnswer || '').trim().toUpperCase(),
    correctAnswer: (e.correctAnswer || '').trim().toUpperCase(),
    markType: e.markType || '',
    confidence: e.confidence || 'medium',
    isError: true,
    pageIndex: 0,  // caller will set
    errorSource: 'zhipu_direct_judge'
  }));
  
  console.log(`[scanner] DirectJudge: ${errors.length} errors detected`);
  return { errors, raw: parsed };
}

// ═══════════════════════════════════════
// Post-OCR: cross-page passage merge + validation
// ═══════════════════════════════════════

/**
 * Merge reading passages that span consecutive pages.
 * When page N's last reading question has passageText and page N+1's first
 * reading question has "[见前半部分]" / "[见上题]" — link them.
 */
function mergeCrossPagePassages(pageResults) {
  if (pageResults.length < 2) return;
  
  for (let i = 0; i < pageResults.length - 1; i++) {
    const thisPage = pageResults[i];
    const nextPage = pageResults[i + 1];
    if (thisPage.engine === 'failed' || nextPage.engine === 'failed') continue;
    
    // Find the last reading/cloze question on this page with actual passageText
    const thisQs = thisPage.questions;
    const nextQs = nextPage.questions;
    
    if (!thisQs.length || !nextQs.length) continue;
    
    // Look for reading passages that span pages:
    // 1. This page's last reading question has passageText (not "[见上题]")
    // 2. Next page's first reading question references it
    for (let t = thisQs.length - 1; t >= 0; t--) {
      const qThis = thisQs[t];
      const isReading = ['reading', 'cloze'].includes(qThis.questionType);
      if (!isReading) continue;
      
      const passage = qThis.passageText || '';
      if (!passage || passage === '[见上题]' || passage === '[见前半部分]') continue;
      
      // Check next page for a reading/cloze question that references this
      for (let n = 0; n < Math.min(3, nextQs.length); n++) {
        const qNext = nextQs[n];
        const nextPassage = qNext.passageText || '';
        if (nextPassage === '[见上题]' || nextPassage === '[见前半部分]') {
          console.log(`[scanner] Merge: Q${qThis.questionNumber} passage → Q${qNext.questionNumber} on next page`);
          qNext.passageText = passage;
          break;
        }
      }
      break;
    }
  }
}

/**
 * Validate question numbering: detect duplicates, gaps, and out-of-order sequences.
 * Logs warnings but does not modify data.
 */
/**
 * Post-process questions after VL OCR:
 * 1. Assign columns based on layout geometry (no hardcoded thresholds)
 * 2. Detect cross-column text contamination
 * 3. Fix bbox if all identical (VL model fallback pattern)
 */
function postProcessQuestions(questions, layoutResult) {
  const blocks = layoutResult.blocks || [];
  const imgW = layoutResult.image_size?.width || 1;
  const imgH = layoutResult.image_size?.height || 1;
  if (!blocks.length || !questions.length) return;

  // --- Step 1: Determine column structure dynamically ---
  // Cluster text blocks by x-center to find column boundaries
  const textBlocks = blocks.filter(b => b.label === 'text' || b.label === 'paragraph_title' || b.label === 'number');
  const xCenters = textBlocks.map(b => (b.x1 + b.x2) / 2);
  
  // Sort x-centers and find the biggest gap → column separator
  xCenters.sort((a, b) => a - b);
  let maxGap = 0, splitX = imgW / 2;
  for (let i = 1; i < xCenters.length; i++) {
    const gap = xCenters[i] - xCenters[i - 1];
    if (gap > maxGap) { maxGap = gap; splitX = (xCenters[i] + xCenters[i - 1]) / 2; }
  }
  // Only treat as dual-column if the gap is significant (>10% of image width)
  const isDual = maxGap > imgW * 0.1 && xCenters.length > 6;
  
  // --- Step 2: Assign each question to a column ---
  const bbox = (q) => q.bbox || {};
  const qCenterX = (q) => {
    const b = bbox(q);
    return b.x != null ? b.x + (b.w || 0) / 2 : 0;
  };
  
  for (const q of questions) {
    const cx = qCenterX(q);
    q._column = isDual ? (cx < splitX ? 'L' : 'R') : 'L';
  }

  // --- Step 3: Fix identical bbox (VL model template-copying pattern) ---
  const firstBbox = JSON.stringify(bbox(questions[0]));
  const allSame = questions.every(q => JSON.stringify(bbox(q)) === firstBbox);
  
  if (allSame) {
    console.log(`[scanner] All ${questions.length} questions have identical bbox, redistributing via layout blocks...`);
    const sortedBlocks = [...textBlocks].sort((a, b) => {
      const aCol = (a.x1 + a.x2) / 2 < splitX ? 0 : 1;
      const bCol = (b.x1 + b.x2) / 2 < splitX ? 0 : 1;
      if (aCol !== bCol) return aCol - bCol;
      return a.y1 - b.y1;
    });
    
    const questionsPerBlock = Math.max(1, Math.ceil(questions.length / sortedBlocks.length));
    let qi = 0;
    for (let bi = 0; bi < sortedBlocks.length && qi < questions.length; bi++) {
      const blk = sortedBlocks[bi];
      for (let j = 0; j < questionsPerBlock && qi < questions.length; j++, qi++) {
        const subH = Math.round(blk.h / questionsPerBlock);
        questions[qi].bbox = { x: blk.x1, y: blk.y1 + j * subH, w: blk.w, h: subH };
        questions[qi]._column = isDual ? ((blk.x1 + blk.x2) / 2 < splitX ? 'L' : 'R') : 'L';
      }
    }
    console.log(`[scanner] Redistributed ${qi} questions across ${sortedBlocks.length} layout blocks (dual=${isDual})`);
  }

  // --- Step 4: Detect cross-column text contamination ---
  // For each question, check if layout blocks from the OTHER column overlap vertically
  // and if so, whether the question text might contain their content
  if (!isDual) return;
  
  const leftBlocks = textBlocks.filter(b => (b.x1 + b.x2) / 2 < splitX);
  const rightBlocks = textBlocks.filter(b => (b.x1 + b.x2) / 2 >= splitX);
  
  for (const q of questions) {
    const b = bbox(q);
    if (b.y == null || b.h == null) continue;
    
    const qTop = b.y;
    const qBottom = b.y + b.h;
    const qCol = q._column;
    
    // Find blocks from the opposite column that overlap vertically
    const oppositeBlocks = (qCol === 'L' ? rightBlocks : leftBlocks).filter(ob => {
      const obTop = ob.y1;
      const obBottom = ob.y2;
      return obTop < qBottom && obBottom > qTop;
    });
    
    if (oppositeBlocks.length === 0) continue;
    
    // Calculate overlap ratio
    const overlapRatio = oppositeBlocks.reduce((sum, ob) => {
      const overlapTop = Math.max(qTop, ob.y1);
      const overlapBottom = Math.min(qBottom, ob.y2);
      return sum + Math.max(0, overlapBottom - overlapTop);
    }, 0) / Math.max(1, qBottom - qTop);
    
    // Flag if significant overlap (but don't auto-fix text — just log for now)
    if (overlapRatio > 0.3) {
      console.log(`[scanner] ⚠️ Q${q.questionNumber} (${qCol}col) has ${Math.round(overlapRatio * 100)}% vertical overlap with ${oppositeBlocks.length} opposite-column blocks — possible text contamination`);
      q._crossColumnWarning = {
        overlapRatio: Math.round(overlapRatio * 100) / 100,
        oppositeBlockCount: oppositeBlocks.length,
        column: qCol
      };
    }
  }
}

function validateQuestionNumbers(pageResults) {
  const allNumbers = [];
  const seen = new Map(); // number → [{page, idx}]
  
  for (const page of pageResults) {
    if (page.engine === 'failed') continue;
    for (let qi = 0; qi < page.questions.length; qi++) {
      const qn = page.questions[qi].questionNumber;
      allNumbers.push(qn);
      if (!seen.has(qn)) seen.set(qn, []);
      seen.get(qn).push({ page: page.pageIndex, idx: qi });
    }
  }
  
  // Check for duplicates — PER PAGE only (not cross-page)
  // English exams reuse question numbers across sections:
  //   Listening Q1 (P1) ≠ Grammar Q1 (P3) ≠ Reading Q1 (P4)
  // Only dedupe when the same number appears twice on the SAME page
  for (const [qn, locations] of seen) {
    if (locations.length > 1) {
      // Group by page
      const byPage = {};
      for (const loc of locations) {
        if (!byPage[loc.page]) byPage[loc.page] = [];
        byPage[loc.page].push(loc);
      }
      // Only dedupe within same page
      for (const [pageIdx, pageLocs] of Object.entries(byPage)) {
        if (pageLocs.length > 1) {
          console.log(`[scanner] Duplicate Q${qn} on same page P${pageIdx} — keeping first`);
          for (let i = 1; i < pageLocs.length; i++) {
            const p = pageResults.find(pr => pr.pageIndex === pageLocs[i].page);
            if (p) p.questions[pageLocs[i].idx] = null;
          }
        } else if (Object.keys(byPage).length > 1) {
          // Log cross-page same-number (normal for multi-section exams)
          const pages = Object.keys(byPage).map(p => `P${p}`).join(', ');
          console.log(`[scanner] Q${qn} appears on ${pages} — keeping all (different sections)`);
        }
      }
    }
  }
  
  // Clean up nulled duplicates
  for (const page of pageResults) {
    page.questions = page.questions.filter(q => q !== null);
    page.totalQuestions = page.questions.length;
    page.errors = page.errors.filter(q => q !== null);
    page.totalErrors = page.errors.length;
  }
  
  // Check for gaps — WARN level if substantial gaps found
  const sorted = [...new Set(allNumbers)].sort((a, b) => a - b);
  if (sorted.length > 1) {
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] > 1) {
        const missingCount = sorted[i] - sorted[i - 1] - 1;
        const missingNums = [];
        for (let n = sorted[i - 1] + 1; n < sorted[i]; n++) {
          missingNums.push(n);
        }
        gaps.push({ from: sorted[i - 1], to: sorted[i], missingCount, missingNums });
      }
    }
    if (gaps.length) {
      const gapDetails = gaps.map(g => `${g.from}→${g.to} (缺${g.missingCount}题: ${g.missingNums.join(',')})`).join('; ');
      console.log(`[scanner] ⚠️ WARN: 题号断档 — ${gapDetails}`);
      console.log(`[scanner] ⚠️ 共缺失 ${gaps.reduce((s, g) => s + g.missingCount, 0)} 题，可能是标题误判为题目或段落嵌入题号被跳过`);
    }
  }
  
  if (!allNumbers.length) {
    console.log('[scanner] ⚠️ 0 questions extracted from all pages!');
  }
}

export default { SCANNER_VERSION, scanPage, scanPages };
