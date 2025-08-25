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
  // Filters: remote + easily apply if available in your region; we’ll still detect in-page
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
  const browser = await chromium.launch({ headless: true }); // set false to watch
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

    // 3) Collect first N jobs
    const jobLinks = await page.$$eval('a[data-jk], a.tapItem', anchors =>
      anchors.map(a => {
        const href = a.getAttribute('href') || '';
        if (!href) return null;
        const title = a.getAttribute('aria-label') || a.textContent?.trim() || 'Job';
        return { href: href.startsWith('http') ? href : `https://www.indeed.com${href}`, title };
      }).filter(Boolean)
    );

    let count = 0;
    for (const job of jobLinks) {
      if (count >= MAX_APPS) break;

      const jp = await ctx.newPage();
      try {
        await jp.goto(job.href, { waitUntil: 'domcontentloaded' });
        await sleep(1500);

        // Heuristics to detect “Easily apply / Apply now”
        const applyButtonSelectors = [
          'button:has-text("Easily apply")',
          'button:has-text("Apply now")',
          'button[aria-label*="Apply"]',
          'a:has-text("Easily apply")',
          'a:has-text("Apply now")'
        ];

        let canApply = false;
        for (const sel of applyButtonSelectors) {
          if (await jp.locator(sel).first().isVisible().catch(()=>false)) {
            canApply = true; break;
          }
        }

        if (!canApply) {
          skipped.push({ job: job.title, url: job.href, reason: 'No Easy Apply' });
          await jp.close();
          continue;
        }

        // Open apply
        let opened = false;
        for (const sel of applyButtonSelectors) {
          if (await safeClick(jp, sel)) { opened = true; break; }
        }
        if (!opened) {
          skipped.push({ job: job.title, url: job.href, reason: 'Apply button not clickable' });
          await jp.close();
          continue;
        }

        // Wait for modal/form
        await sleep(2000);

        // Fill common fields if present (keep minimal; resume is stored in profile)
        const phoneSel = 'input[type="tel"], input[name*="phone"]';
        if (await jp.locator(phoneSel).first().isVisible().catch(()=>false)) {
          await jp.fill(phoneSel, process.env.PHONE || '9999999999');
        }

        // Next / Submit buttons (varies by posting)
        const nextOrSubmit = [
          'button[type="submit"]',
          'button:has-text("Submit")',
          'button:has-text("Apply")',
          'button:has-text("Continue")',
          'button:has-text("Next")'
        ];

        let progressed = false;
        for (const sel of nextOrSubmit) {
          if (await safeClick(jp, sel)) {
            progressed = true; await sleep(2000);
          }
        }

        // Try submit again if multi-step
        for (const sel of nextOrSubmit) {
          if (await safeClick(jp, sel)) {
            progressed = true; await sleep(2000);
          }
        }

        // Basic success heuristic: URL or confirmation text changes
        const successTextCandidates = ['Application submitted', 'Thanks for applying', 'Your application has been sent'];
        const success = await Promise.any(successTextCandidates.map(t => jp.getByText(t, { exact: false }).isVisible()))
          .catch(()=>false);

        if (success || progressed) {
          applied.push({ job: job.title, url: job.href, status: 'applied' });
          count++;
        } else {
          skipped.push({ job: job.title, url: job.href, reason: 'Could not submit' });
        }

      } catch (e) {
        skipped.push({ job: job.title, url: job.href, reason: 'Error: ' + (e.message || e.toString()) });
      } finally {
        await jp.close();
        await sleep(1500 + Math.floor(Math.random()*1000)); // human pacing
      }
    }

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


const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/usr/bin/google-chrome' // force system Chrome
  });
  const page = await browser.newPage();
  await page.goto('https://example.com');
  console.log(await page.title());
  await browser.close();
})();

