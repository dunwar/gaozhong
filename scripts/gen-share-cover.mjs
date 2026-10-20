#!/usr/bin/env node
// 一次性工具: 生成微信分享封面 share-cover.png (500×500)
// 用 Chrome headless 截图渲染, 保证中文字体正常
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'public', 'share-cover.png');

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:500px; height:500px; overflow:hidden;
         background:linear-gradient(150deg,#14532d 0%,#16a34a 60%,#22c55e 100%);
         font-family:"WenQuanYi Micro Hei","Noto Sans CJK SC",sans-serif;
         color:#fff; display:flex; flex-direction:column; justify-content:space-between; padding:48px 44px; }
  .brand { font-size:44px; font-weight:900; letter-spacing:4px; }
  .brand-sub { font-size:17px; opacity:.75; margin-top:8px; letter-spacing:2px; }
  .mid { display:flex; flex-direction:column; gap:18px; }
  .line { display:flex; align-items:center; gap:12px; font-size:24px; font-weight:700; }
  .dot { width:10px; height:10px; border-radius:50%; background:#fde047; flex-shrink:0; }
  .hl { color:#fde047; }
  .foot { font-size:20px; opacity:.9; letter-spacing:1px; border-top:1px solid rgba(255,255,255,.35); padding-top:22px; }
  .foot b { font-size:24px; letter-spacing:0; }
</style></head>
<body>
  <div>
    <div class="brand">高中在线</div>
    <div class="brand-sub">AI 驱动的高中学业诊断平台</div>
  </div>
  <div class="mid">
    <div class="line"><span class="dot"></span><span>上海高考作文 <span class="hl">70分制</span> 逐句精批</span></div>
    <div class="line"><span class="dot"></span><span>五维评分 + 升格示范</span></div>
    <div class="line"><span class="dot"></span><span>试卷拍照 <span class="hl">一键生成订正纸</span></span></div>
  </div>
  <div class="foot">免下载 · 注册送5点 · <b>gaozhong.online</b></div>
</body></html>`;

const tmp = '/tmp/share-cover.html';
fs.writeFileSync(tmp, html);

const { execFileSync } = await import('node:child_process');
const exe = process.env.PUPPETEER_EXECUTABLE_PATH || '/app/data/browsers/chrome-linux64/chrome';
if (!fs.existsSync(exe)) { console.error('Chrome 不存在:', exe); process.exit(1); }
const env = { ...process.env, LD_LIBRARY_PATH: '/app/data/browsers/deps/usr/lib/x86_64-linux-gnu:/app/data/browsers/deps/lib/x86_64-linux-gnu' };
execFileSync(exe, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--window-size=500,500', '--force-device-scale-factor=1',
  `--screenshot=${OUT}`, `file://${tmp}`,
], { env, stdio: 'inherit' });
console.log('✅ 生成:', OUT, fs.statSync(OUT).size, 'bytes');
