const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:8799/register', { waitUntil: 'networkidle' });
  await page.screenshot({ path: 'register-page-polished.png', fullPage: true });
  await browser.close();
})();
