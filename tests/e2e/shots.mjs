// Visual QA helper: screenshots of the given paths at 1440 / 768 / 375 using the offline E2E harness.
// Usage: SHOTS=/dir node tests/e2e/shots.mjs /path1 /path2 ...   (optional: VIEWPORTS=1440,375  FULL=1)
import { startServer, installRoutes, setFlags } from './harness.mjs';
import path from 'node:path';
const { chromium } = await import('playwright').catch(() => import(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs'));
const out = process.env.SHOTS || '/tmp';
const widths = (process.env.VIEWPORTS || '1440,768,375').split(',').map(Number);
const srv = await startServer(); setFlags({ projectHome: true });
const browser = await chromium.launch();
for (const w of widths) {
  const c = await browser.newContext({ viewport: { width: w, height: w < 760 ? 812 : 900 }, isMobile: w < 760, hasTouch: w < 760 });
  await installRoutes(c);
  const page = await c.newPage();
  page.on('pageerror', (e) => console.log('pageerror', w, String(e)));
  for (const p of process.argv.slice(2)) {
    await page.goto('http://localhost:8931' + p); await page.waitForTimeout(Number(process.env.WAIT || 2500));
    const name = (p.replace(/[^a-z0-9]+/gi, '_') || 'root') + '_' + w + '.png';
    await page.screenshot({ path: path.join(out, name), fullPage: Boolean(process.env.FULL) });
    console.log('shot', name);
  }
  await c.close();
}
await browser.close(); srv.close();
