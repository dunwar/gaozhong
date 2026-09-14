#!/usr/bin/env node
// SPA 预渲染: 构建后运行, 用 headless 浏览器把公开页面渲染成静态 HTML 写回 dist/
// 路由清单自动取自 dist/sitemap.xml(新增文章页只需更新 sitemap)
// 用法: npm run build && node scripts/prerender.mjs
// 浏览器: 优先环境变量 PUPPETEER_EXECUTABLE_PATH / CHROME_PATH, 否则探测常见 Chrome/Edge 路径
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const PORT = 4173;

// ---------- 1. 从 sitemap 提取要预渲染的路径 ----------
const sitemapFile = path.join(DIST, 'sitemap.xml');
if (!fs.existsSync(sitemapFile)) {
  console.error('❌ dist/sitemap.xml 不存在, 无法确定预渲染路由'); process.exit(1);
}
const locs = [...fs.readFileSync(sitemapFile, 'utf-8').matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
const routes = locs.map(u => new URL(u).pathname).filter(p => p !== '/robots.txt');
if (routes.length === 0) { console.error('❌ sitemap 无 URL'); process.exit(1); }
console.log(`预渲染路由(${routes.length}): ${routes.join(', ')}`);

// ---------- 2. 静态服务 dist(带 SPA fallback) ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.join(DIST, p);
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  }
  // SPA fallback → index.html(未预渲染的路由仍走客户端渲染)
  res.writeHead(200, { 'Content-Type': 'text/html' });
  fs.createReadStream(path.join(DIST, 'index.html')).pipe(res);
});
await new Promise(r => server.listen(PORT, r));
console.log(`静态服务: http://localhost:${PORT}`);

// ---------- 3. headless 浏览器逐页快照 ----------
let browser = null;
try {
  const { default: puppeteer } = await import('puppeteer-core');
  const exe = findChrome();
  if (!exe) throw new Error('未找到 Chrome/Chromium(可用 PUPPETEER_EXECUTABLE_PATH 指定)');
  browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  for (const route of routes) {
    const page = await browser.newPage();
    await page.goto(`http://localhost:${PORT}${route}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1200)); // 字体/图片余量
    const html = await page.content();
    const out = route === '/' ? path.join(DIST, 'index.html') : path.join(DIST, route, 'index.html');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html);
    const title = await page.title();
    console.log(`✅ ${route} → ${path.relative(DIST, out)} (${(html.length / 1024).toFixed(0)}KB, title: ${title.slice(0, 40)})`);
    await page.close();
  }
  console.log('🎉 预渲染完成');
} catch (err) {
  console.error(`⚠️ 预渲染失败: ${err.message}`);
  console.error('   dist 保持未预渲染状态(部署仍可用, 但 SEO 降级为空壳)');
  server.close();
  process.exit(2);
} finally {
  if (browser) await browser.close();
  server.close();
}

function findChrome() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe` : null,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}
