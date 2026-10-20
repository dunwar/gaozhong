import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 900 });
await page.goto('https://www.gaozhong.online/articles/shanghai-gaokao-zuowen-2000-2026/', { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 1500));
// 验证 SPA 水合后内容仍在 + 表格渲染
const checks = await page.evaluate(() => ({
  title: document.title,
  tableRows: document.querySelectorAll('table tr').length,
  essayLinks: document.querySelectorAll('a[href*="/articles/gaokao-"]').length,
  h2Count: document.querySelectorAll('.article-body h2').length,
  hasCTA: !!document.querySelector('a[href="/upload"]'),
}));
console.log('汇总页:', JSON.stringify(checks));
// 点击第一篇范文链接 → SPA 内部跳转
await page.click('a[href="/articles/gaokao-2012-lingguangyixian"]');
await new Promise(r => setTimeout(r, 2000));
const essay = await page.evaluate(() => ({
  url: location.pathname,
  title: document.title.slice(0, 40),
  hasEssayText: document.body.innerText.includes('采菊东篱下'),
  hasNote: !!document.querySelector('.essay-note'),
}));
console.log('点击跳转后:', JSON.stringify(essay));
await page.screenshot({ path: '/home/node/.openclaw/workspace/output/essay-page-mobile.png' });
await browser.close();
console.log('E2E-OK');
