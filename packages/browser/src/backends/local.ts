import { chromium } from 'playwright';
import type { BrowserSession } from '../session.js';
import { getSession, setSession, closeSession } from '../session.js';

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

export async function getOrCreateLocalSession(taskId: string): Promise<BrowserSession> {
  const existing = getSession(taskId);
  if (existing) return existing;

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
    ],
  });

  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });

  const page = await context.newPage();

  const session: BrowserSession = {
    taskId,
    browser,
    context,
    page,
    createdAt: Date.now(),
  };
  setSession(taskId, session);
  return session;
}

export { closeSession };
