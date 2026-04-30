#!/usr/bin/env node
/**
 * gaozhong.online - AI 作文批改 API 服务
 * 
 * 架构：直连大模型 API
 * 模型分工：
 *   - 图片识别/OCR: 阿里云百炼 qwen-vl-plus
 *   - 作文批改: DeepSeek v4 pro
 * 
 * Prompt 管理：prompts/ 目录下独立文件，方便迭代优化
 * 环境变量：
 *   DASHSCOPE_API_KEY - 百炼 API Key（OCR 用）
 *   DEEPSEEK_API_KEY  - DeepSeek API Key（批改用）
 *   MODEL_OCR         - OCR 模型（默认 qwen-vl-plus）
 *   MODEL_GRADING     - 批改模型（默认 deepseek-v4-pro）
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 导入 Prompt 模板
import { GRADING_PROMPT, PROMPT_VERSION } from './prompts/grading-v5.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

// 加载环境变量
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf-8')
      .split('\n')
      .filter(line => line.trim() && !line.trim().startsWith('#'))
      .forEach(line => {
        // 移除行内注释
        const cleanLine = line.split('#')[0].trim();
        if (!cleanLine) return;
        const eqIdx = cleanLine.indexOf('=');
        if (eqIdx === -1) return;
        const key = cleanLine.substring(0, eqIdx).trim();
        const val = cleanLine.substring(eqIdx + 1).trim();
        if (val && !process.env[key]) process.env[key] = val;
      });
  }
}
loadEnv();

const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const MODEL_OCR = process.env.MODEL_OCR || 'qwen-vl-plus';
const MODEL_GRADING = process.env.MODEL_GRADING || 'deepseek-v4-pro';

// 验证 Key
if (!DEEPSEEK_KEY) {
  console.error('❌ 错误: DEEPSEEK_API_KEY 未设置，请创建 .env 文件');
  process.exit(1);
}

// 日志
function log(level, msg, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }));
}

// ========== Prompt 模板处理 ==========

function renderPrompt(template, topic = '', text = '') {
  return template
    .replace(/\{作文题目材料\}/g, topic || '(无)')
    .replace(/\{作文内容\}/g, text);
}

// 解析 Markdown 格式的批改结果
function parseMarkdownResult(content) {
  const result = {
    totalScore: 0,
    grade: '',
    essayType: '',
    wordCount: 0,
    dimensions: {},
    rawScore: 0,
    adjustments: { plus: [], minus: [] },
    adjustedScore: 0,
    strengths: [],
    weaknesses: [],
    suggestions: [],
    overallComment: '',
    gradingReason: '',
    revisions: [],
    oneSentenceSummary: '',
    fullCommentary: content,
    // 新增：保留原始 Markdown 供前端展示
    rawMarkdown: content
  };

  try {
    // ===== 1. 提取最终评分（多种格式兼容） =====
    // 格式 1: "## 最终评分：46分 / 70分 （三类卷中上段）"
    // 格式 2: "最终得分：46分"
    // 格式 3: "**最终得分：46分**"
    const scorePatterns = [
      /最终评分[：:]\s*(\d+)\s*分\s*\/\s*70\s*分/,
      /最终得分[：:]\s*(\d+)\s*分/,
      /\*\*最终得分[：:]\s*(\d+)\s*分\*\*/,
      /最终[：:]\s*(\d+)\s*分/
    ];
    for (const pattern of scorePatterns) {
      const scoreMatch = content.match(pattern);
      if (scoreMatch) {
        result.totalScore = parseInt(scoreMatch[1]);
        break;
      }
    }

    // ===== 2. 提取档位 =====
    const gradePatterns = [
      /（([^）]+)类卷[^）]*）/,
      /\*\*（([^）]+)类卷[^）]*）\*\*/,
      /档位[：:]\s*([^，\n]+)/,
      /评为[：:]\s*([^，\n]+)/
    ];
    for (const pattern of gradePatterns) {
      const gradeMatch = content.match(pattern);
      if (gradeMatch) {
        result.grade = gradeMatch[1].trim() + '类卷';
        break;
      }
    }

    // ===== 3. 提取字数 =====
    const wordCountPatterns = [
      /字数[：:]\s*(\d+)/,
      /(\d+)\s*字[，,。]/,
      /全文[：:]\s*(\d+)\s*字/
    ];
    for (const pattern of wordCountPatterns) {
      const wordCountMatch = content.match(pattern);
      if (wordCountMatch) {
        result.wordCount = parseInt(wordCountMatch[1]);
        break;
      }
    }

    // ===== 4. 提取一句话总结 =====
    const summaryPatterns = [
      /一句话总结[\s\n]*([\s\S]*?)(?=\n\n|$)/,
      /一句话概括[\s\n]*([\s\S]*?)(?=\n\n|$)/,
      /总结[：:][\s\n]*([\s\S]*?)(?=\n\n|$)/
    ];
    for (const pattern of summaryPatterns) {
      const summaryMatch = content.match(pattern);
      if (summaryMatch) {
        result.oneSentenceSummary = summaryMatch[1].trim().replace(/[""]/g, '').substring(0, 200);
        break;
      }
    }

    // ===== 5. 提取定档理由 =====
    const reasonPatterns = [
      /定档理由[\s\n]*([\s\S]*?)(?=\n---|\n###|\n##|$)/,
      /总体评价[\s\n]*([\s\S]*?)(?=\n---|\n###|\n##|$)/,
      /总体印象[\s\n]*([\s\S]*?)(?=\n---|\n###|\n##|$)/
    ];
    for (const pattern of reasonPatterns) {
      const reasonMatch = content.match(pattern);
      if (reasonMatch) {
        result.gradingReason = reasonMatch[1].trim().substring(0, 500);
        break;
      }
    }

    // ===== 6. 提取五维得分（v5: 审题立意/思辨深度/结构布局/语言表达/素材运用） =====
    const dimFullNames = { '审题立意': 20, '思辨深度': 30, '结构布局': 20, '语言表达': 15, '素材运用': 15 };
    const dimKeys = ['审题立意', '思辨深度', '结构布局', '语言表达', '素材运用'];
    
    for (const dimKey of dimKeys) {
      const dimRegex = new RegExp(`####\\s*${dimKey}[（(](\\d+)/(\\d+)分?[）)]`, 'g');
      const dimMatch = dimRegex.exec(content);
      if (dimMatch) {
        const score = parseInt(dimMatch[1]);
        const full = parseInt(dimMatch[2]) || dimFullNames[dimKey] || 20;
        
        // 提取评价内容（到下一个####标题或结束）
        const sectionStart = content.indexOf(dimMatch[0]);
        const remaining = content.slice(sectionStart + dimMatch[0].length);
        const nextHeading = remaining.match(/\n####\s/);
        const sectionEnd = nextHeading ? sectionStart + dimMatch[0].length + nextHeading.index : content.length;
        
        let evalText = content.slice(sectionStart + dimMatch[0].length, sectionEnd)
          .replace(/^[-#\s*]+/gm, '')
          .replace(/\n{2,}/g, '\n')
          .trim()
          .substring(0, 400);
        
        // 提取扣分原因
        const deductionMatch = evalText.match(/扣分原因[：:]\s*([^\n]+)/);
        const deductionReason = deductionMatch ? deductionMatch[1].trim() : '';
        
        // 提取亮点和不足
        const strengths = [];
        const strengthMatches = evalText.matchAll(/[•·\-\*]\s*(?:\[如为亮点\]\s*)?原文引用[：:]\s*["""]([^""\n]+)["""]\s*——\s*([^\n]+)/g);
        for (const sm of strengthMatches) {
          strengths.push(`${sm[1]} —— ${sm[2]}`);
        }
        
        result.dimensions[dimKey] = {
          score,
          full,
          evaluation: evalText || '暂无评价',
          deductionReason: deductionReason,
          strengths: strengths.length > 0 ? strengths : undefined
        };
      }
    }

    // ===== 7. 提取加减分项 =====
    // 加分项 - 兼容 **加分项：** 和 加分项：
    const plusSection = content.match(/\*\*加分项[：:]?\*\*\s*([\s\S]*?)(?=\*\*扣分项|\*\*分数计算|扣分项|分数计算|$)/);
    if (plusSection) {
      const plusItems = plusSection[1].match(/[•·\-\*]\s*([^\n]+)/g);
      if (plusItems) {
        plusItems.forEach(item => {
          const cleanItem = item.replace(/[•·\-\*]\s*/, '').trim();
          const pointsMatch = cleanItem.match(/[（(]([+\-]?\d+)分?[）)]/);
          result.adjustments.plus.push({
            reason: cleanItem.replace(/[（(][^）)]*[）)]/g, '').trim(),
            points: pointsMatch ? parseInt(pointsMatch[1]) : 0
          });
        });
      }
    }

    // 扣分项
    const minusSection = content.match(/\*\*扣分项[：:]?\*\*\s*([\s\S]*?)(?=\*\*分数计算|分数计算|具体修改|$)/);
    if (minusSection) {
      const minusItems = minusSection[1].match(/[•·\-\*]\s*([^\n]+)/g);
      if (minusItems) {
        minusItems.forEach(item => {
          const cleanItem = item.replace(/[•·\-\*]\s*/, '').trim();
          const pointsMatch = cleanItem.match(/[（(]([+\-]?\d+)分?[）)]/);
          result.adjustments.minus.push({
            reason: cleanItem.replace(/[（(][^）)]*[）)]/g, '').trim(),
            points: pointsMatch ? parseInt(pointsMatch[1]) : 0
          });
        });
      }
    }

    // ===== 8. 提取分数计算过程 =====
    const calcPatterns = [
      /维度得分之和[：:]\s*(\d+)/,
      /各维度得分之和[：:]\s*(\d+)/,
      /维度总分[：:]\s*(\d+)/
    ];
    for (const pattern of calcPatterns) {
      const calcMatch = content.match(pattern);
      if (calcMatch) {
        result.rawScore = parseInt(calcMatch[1]);
        break;
      }
    }
    
    const adjPatterns = [
      /调整后\d+分制[：:]\s*(\d+)/,
      /调整后总分[：:]\s*(\d+)/,
      /加减后[：:]\s*(\d+)/
    ];
    for (const pattern of adjPatterns) {
      const adjMatch = content.match(pattern);
      if (adjMatch) {
        result.adjustedScore = parseInt(adjMatch[1]);
        break;
      }
    }

    // ===== 9. 提取具体修改建议 =====
    // v6 格式: **修改1：[问题类别]**\n原文：...\n问题：...\n修改建议：...\n修改理由：...
    const revisionPatterns = [
      // 格式 1: "**修改1：[类别]**\n原文：...\n问题：...\n修改建议：...\n修改理由：..."
      /\*\*修改\s*\d+[：:]([^*]*)\*\*\s*\n\s*原文[：:]\s*["""]?([^""\n]*)["""]?\s*\n\s*问题[：:]\s*([^\n]*)\s*\n\s*修改建议[：:]\s*["""]?([^""\n]*)["""]?\s*\n\s*修改理由[：:]\s*([^\n]*)/,
      // 格式 2: "修改1：[类别]\n原文：...\n问题：...\n修改建议：...\n修改理由：..."
      /修改\s*\d+[：:]\s*([^\n]+)\s*\n\s*原文[：:]\s*["""]?([^""\n]*)["""]?\s*\n\s*问题[：:]\s*([^\n]*)\s*\n\s*修改建议[：:]\s*["""]?([^""\n]*)["""]?\s*\n\s*修改理由[：:]\s*([^\n]*)/
    ];
    for (const pattern of revisionPatterns) {
      let revMatch;
      const regex = new RegExp(pattern.source, 'g');
      while ((revMatch = regex.exec(content)) !== null) {
        result.revisions.push({
          category: revMatch[1].trim(),
          location: '',
          original: revMatch[2] ? revMatch[2].trim() : '',
          suggested: revMatch[4] ? revMatch[4].trim() : '',
          reason: revMatch[5] ? revMatch[5].trim() : ''
        });
      }
      if (result.revisions.length > 0) break;
    }

    // ===== 10. 提取亮点和不足 =====
    const strengthsPatterns = [
      /[•·\-\*]\s*\[如为亮点\]\s*原文引用[：:]\s*["""]([^""\n]+)["""]\s*——\s*([^\n]+)/,
      /[•·\-\*]\s*(?:亮点|优点)[：:]\s*([^\n]+)/,
      /亮点[：:]\s*([^\n]+)/
    ];
    for (const pattern of strengthsPatterns) {
      let strMatch;
      const regex = new RegExp(pattern.source, 'g');
      while ((strMatch = regex.exec(content)) !== null) {
        result.strengths.push((strMatch[2] || strMatch[1]).trim());
      }
      if (result.strengths.length > 0) break;
    }

    const weaknessesPatterns = [
      /[•·\-\*]\s*\[如为问题\]\s*原文引用[：:]\s*["""]([^""\n]+)["""]\s*——\s*([^\n]+)/,
      /[•·\-\*]\s*(?:问题|不足)[：:]\s*([^\n]+)/,
      /不足[：:]\s*([^\n]+)/
    ];
    for (const pattern of weaknessesPatterns) {
      let weakMatch;
      const regex = new RegExp(pattern.source, 'g');
      while ((weakMatch = regex.exec(content)) !== null) {
        result.weaknesses.push((weakMatch[2] || weakMatch[1]).trim());
      }
      if (result.weaknesses.length > 0) break;
    }

    // 如果还是没有，从全文提取
    if (result.strengths.length === 0) {
      const allStrengths = content.match(/[•·\-\*]\s*([^•·\n]*(?:亮点|新颖|深刻|恰当|准确)[^•·\n]*)/g);
      if (allStrengths) {
        result.strengths = allStrengths.map(s => s.replace(/[•·\-\*]\s*/, '').trim()).slice(0, 5);
      }
    }
    if (result.weaknesses.length === 0) {
      const allWeaknesses = content.match(/[•·\-\*]\s*([^•·\n]*(?:问题|不足|偏差|混乱|语病|错误)[^•·\n]*)/g);
      if (allWeaknesses) {
        result.weaknesses = allWeaknesses.map(w => w.replace(/[•·\-\*]\s*/, '').trim()).slice(0, 5);
      }
    }

    // ===== 11. 提取建议 =====
    const suggestionPatterns = [
      /\*\*对该学生的建议[：:]\*\*\s*\n([\s\S]*?)(?=\n###|\n---|$)/,
      /对该学生的建议[：:]\s*([\s\S]*?)(?=\n###|\n---|$)/,
      /具体建议[：:][\s\S]*?(\d+\.\s*[^\n]+)/g
    ];
    for (const pattern of suggestionPatterns) {
      const match = content.match(pattern);
      if (match) {
        const block = match[1] || match[0];
        const items = block.match(/\d+\.\s*([^\n]+)/g);
        if (items) {
          result.suggestions = items.map(s => s.replace(/^\d+\.\s*/, '').trim());
          break;
        }
      }
    }

    // 如果还是没提取到建议，从升格路径提取
    if (result.suggestions.length === 0) {
      const upgradeMatch = content.match(/升格路径[\s\S]*?进入[^，\n]+需要[：:]\s*([^\n]+)/);
      if (upgradeMatch) {
        result.suggestions = [upgradeMatch[1].trim()];
      }
    }

    // ===== 12. 提取升格路径 =====
    const upgrade2 = content.match(/进入二类卷需要[：:]\s*([^\n]+)/);
    const upgrade1 = content.match(/进入一类卷需要[：:]\s*([^\n]+)/);
    if (upgrade2 || upgrade1) {
      result.upgradePath = {
        toClass2: upgrade2 ? upgrade2[1].trim() : '',
        toClass1: upgrade1 ? upgrade1[1].trim() : ''
      };
    }

  } catch (err) {
    console.log('解析 Markdown 结果时出错:', err.message);
  }

  // 如果没有解析出分数，返回原始内容
  if (result.totalScore === 0 && result.grade === '') {
    result.grade = '解析中';
    result.essayType = '未知';
  }

  return result;
}

// Vision Prompt 已不再需要，图片批改改为两步：OCR + DeepSeek 批改
// 保留此函数以兼容旧代码
function createVisionPrompt(topic = '') {
  return '请仔细识别图片中的作文文字，尽量完整还原原文。只返回识别出的文字内容。';
}

// ========== API 请求封装 ==========

// 通用 API 请求
function apiRequest({ hostname, path, apiKey, body, timeout = 120000 }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(data)
      },
      timeout
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.substring(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`解析失败: ${e.message}`)); }
      });
    });
    req.on('error', e => reject(new Error(`请求失败: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.write(data);
    req.end();
  });
}

// 百炼 API 请求（用于 OCR）
function dashscopeRequest(body) {
  return apiRequest({
    hostname: 'dashscope.aliyuncs.com',
    path: '/compatible-mode/v1/chat/completions',
    apiKey: DASHSCOPE_KEY,
    body
  });
}

// DeepSeek API 请求（用于批改）
function deepseekRequest(body) {
  return apiRequest({
    hostname: 'api.deepseek.com',
    path: '/v1/chat/completions',
    apiKey: DEEPSEEK_KEY,
    body
  });
}

// ========== 业务逻辑 ==========

async function gradeText(text, topic) {
  const prompt = renderPrompt(GRADING_PROMPT, topic, text);
  log('info', '文本批改', { provider: 'DeepSeek', model: MODEL_GRADING, promptVersion: PROMPT_VERSION, textLen: text.length });
  
  const result = await deepseekRequest({
    model: MODEL_GRADING,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,  // 降低温度以获得更稳定的输出
    max_tokens: 6000   // 增加token以容纳详细评语
  });

  return parseResult(result);
}

async function gradeImage(imageUrl, topic) {
  log('info', '图片批改', { provider: 'DashScope', model: MODEL_OCR, promptVersion: PROMPT_VERSION });
  
  // 第一步：OCR 识别文字
  const ocrResult = await dashscopeRequest({
    model: MODEL_OCR,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '请仔细识别图片中的作文文字，尽量完整还原原文。只返回识别出的文字内容，不要其他分析。' },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    }],
    temperature: 0.3,
    max_tokens: 4000
  });

  const recognizedText = ocrResult.choices?.[0]?.message?.content || '';
  if (!recognizedText) {
    throw new Error('OCR 识别失败，未能提取文字');
  }

  log('info', 'OCR 识别完成', { textLen: recognizedText.length });

  // 第二步：使用 DeepSeek 进行批改
  return await gradeText(recognizedText, topic);
}

function parseResult(result) {
  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 返回为空');

  // v5 Prompt 返回的是 Markdown 格式，直接解析
  if (PROMPT_VERSION === 'v5') {
    const parsed = parseMarkdownResult(content);
    if (parsed.totalScore > 0) {
      return parsed;
    }
    // 如果解析失败，返回原始内容
    return {
      totalScore: 0,
      grade: '解析中',
      essayType: '未知',
      fullCommentary: content,
      parseError: '自动解析失败，请查看完整评语'
    };
  }

  // 旧版本（v3及以下）返回 JSON 格式
  // 清理 markdown 代码块
  let cleaned = content
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();

  // 尝试解析
  try { return JSON.parse(cleaned); } catch {}

  // 提取第一个 JSON 对象
  try {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch {}

  // 尝试修复常见 JSON 问题（尾部逗号）
  try {
    let fixed = cleaned.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    return JSON.parse(fixed);
  } catch {}

  throw new Error('AI 返回格式错误，无法解析 JSON');
}

// ========== 路由 ==========

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(new Error('JSON 格式错误')); } });
    req.on('error', reject);
  });
}

function json(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

  // GET /health
  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, {
      status: 'ok',
      service: 'gaozhong-ai-api',
      providers: {
        ocr: { name: 'DashScope', model: MODEL_OCR },
        grading: { name: 'DeepSeek', model: MODEL_GRADING }
      },
      prompt: { version: PROMPT_VERSION, file: 'prompts/grading-v5.js' }
    });
  }

  // POST /analyze 或 /api/analyze
  if (req.method === 'POST' && (req.url === '/analyze' || req.url === '/api/analyze')) {
    try {
      const body = await parseBody(req);
      log('info', '收到请求', { hasFile: !!body.file, hasText: !!body.text, url: req.url });

      if (!body.file && !body.text) {
        return json(res, 400, { error: '请提供 text（文本）或 file（图片base64）' });
      }

      const topic = body.topic || '';
      let result;

      if (body.file && body.file.startsWith('data:image')) {
        result = await gradeImage(body.file, topic);
      } else if (body.text) {
        result = await gradeText(body.text, topic);
      } else {
        return json(res, 400, { error: '不支持的文件格式' });
      }

      log('info', '批改完成', { score: result.totalScore, grade: result.grade, type: result.essayType });
      return json(res, 200, { success: true, result });

    } catch (err) {
      log('error', '批改失败', { error: err.message });
      return json(res, 500, { error: err.message });
    }
  }

  json(res, 404, { error: 'Not Found', endpoints: ['/health', '/analyze'] });
});

server.listen(PORT, () => {
  console.log(`🚀 gaozhong.online AI API 已启动`);
  console.log(`📍 端口: ${PORT}`);
  console.log(`🔍 健康检查: http://localhost:${PORT}/health`);
  console.log(`📝 批改接口: POST /analyze`);
  console.log(`🤖 OCR: ${MODEL_OCR} (DashScope) | 批改: ${MODEL_GRADING} (DeepSeek) | Prompt: ${PROMPT_VERSION}`);
});
