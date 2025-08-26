// Run: npm run apply
// Env vars required:
// INDEED_EMAIL, INDEED_PASSWORD, KEYWORDS, LOCATION, N8N_WEBHOOK_URL (optional)
import { chromium } from 'playwright';
import fetch from 'node-fetch';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const env = (k, d="") => process.env[k] ?? d;

const EMAIL = env('INDEED_EMAIL');
const PASSWORD = env('INDEED_PASSWORD');
const KEYWORDS = env('KEYWORDS', 'AI Engineer');
const LOCATION = env('LOCATION', 'Remote');
const MAX_APPS = parseInt(env('MAX_APPS', '5'), 10);
const N8N_WEBHOOK_URL = env('N8N_WEBHOOK_URL', ''); // optional: post results back to n8n

if (!EMAIL || !PASSWORD) {
  console.error("Missing INDEED_EMAIL or INDEED_PASSWORD env vars.");
  process.exit(1);
}

function indeedSearchUrl(key, loc) {
  const q = encodeURIComponent(key);
  const l = encodeURIComponent(loc);
  return `https://www.indeed.com/jobs?q=${q}&l=${l}&fromage=1&sort=date`;
}

async function safeClick(page, selectorOrText) {
  try {
    const el = await page.locator(selectorOrText);
    if (await el.first().isVisible()) {
      await el.first().click({ timeout: 4000 });
      return true;
    }
  } catch {}
  return false;
}

async function run() {
  // ✅ FIXED: use Playwright's bundled Chromium (no system Chrome path)
  const browser = await chromium.launch({ headless: true });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const applied = [];
  const skipped = [];

  try {
    // 1) Login
    await page.goto('https://secure.indeed.com/auth', { waitUntil: 'domcontentloaded' });
    await page.fill('input[type="email"], input[name="__email"]', EMAIL);
    await page.fill('input[type="password"], input[name="__password"]', PASSWORD);
    await safeClick(page, 'button[type="submit"], button:has-text("Sign in"), button:has-text("Continue")');
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});

    // 2) Search
    const url = indeedSearchUrl(KEYWORDS, LOCATION);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('a[data-jk], a.tapItem', { timeout: 15000 });

    // ... rest of your code unchanged ...
  } finally {
    await ctx.close();
    await browser.close();
  }

  const summary = { keywords: KEYWORDS, location: LOCATION, applied, skipped, totalTried: applied.length + skipped.length };
  console.log(JSON.stringify(summary, null, 2));

  if (N8N_WEBHOOK_URL) {
    try {
      await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(summary)
      });
    } catch (e) { console.error('Failed to post to n8n webhook:', e.message); }
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
