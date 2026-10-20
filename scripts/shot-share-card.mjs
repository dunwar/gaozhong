// 分享卡截图验收: puppeteer 打开测试页, 等卡片 canvas 生成, 截图
import fs from 'node:fs';
const { default: puppeteer } = await import('puppeteer-core');

const exe = process.env.PUPPETEER_EXECUTABLE_PATH || '/app/data/browsers/chrome-linux64/chrome';
const browser = await puppeteer.launch({
  executablePath: exe,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 500, height: 1100 });
page.on('console', m => { const t = m.text(); if (/error/i.test(t)) console.log('PAGE-ERR:', t.slice(0, 200)); });
await page.goto('http://localhost:5174/test-share.html', { waitUntil: 'networkidle2', timeout: 30000 });
// 等卡片 img 出现(canvas toDataURL 完成)
await page.waitForSelector('.pshare-image', { timeout: 15000 });
await new Promise(r => setTimeout(r, 800));
const el = await page.$('.pshare-modal');
await el.screenshot({ path: '/tmp/paper-share-card.png' });
console.log('✅ 截图完成 /tmp/paper-share-card.png', fs.statSync('/tmp/paper-share-card.png').size, 'bytes');
await browser.close();
