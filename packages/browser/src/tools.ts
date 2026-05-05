/**
 * Browser automation tools for agent-os.
 *
 * Backends selected at runtime via env/settings:
 *   BROWSER_BACKEND=local|browser-use  (default: local)
 *   BROWSER_USE_API_KEY=...            (required for browser-use backend)
 */

import { z } from 'zod';
import type { ToolResult } from '@agent-os-core/shared';
import { getOrCreateLocalSession, closeSession as closeLocal } from './backends/local.js';
import {
  createBrowserUseSession,
  getBrowserUseSession,
  buNavigate,
  buSnapshot,
  buClick,
  buType,
  buClose,
} from './backends/browser-use.js';

type Backend = 'local' | 'browser-use';

function getBackend(): Backend {
  const env = process.env['BROWSER_BACKEND'] ?? 'local';
  return env === 'browser-use' ? 'browser-use' : 'local';
}

function defaultTaskId(): string {
  return 'default';
}

// ─── Snapshot helpers ─────────────────────────────────────────────────────────

/** Extract a simplified text representation of a Playwright page using ARIA snapshot. */
async function buildSnapshot(page: import('playwright').Page): Promise<string> {
  try {
    // Playwright's built-in aria snapshot (v1.41+)
    const snapshot = await page.locator('body').ariaSnapshot().catch(() => null);
    if (snapshot) return snapshot;
  } catch {
    // fall through to text extraction
  }
  // Fallback: extract visible text from body
  const text = await page.evaluate(() => {
    const body = document.body;
    if (!body) return '';
    // Extract interactive elements with their labels
    const elements: string[] = [];
    body.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"]').forEach((el, i) => {
      const tag = el.tagName.toLowerCase();
      const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.textContent?.trim().slice(0, 60) || '';
      const type = el.getAttribute('type') ?? '';
      elements.push(`[${i}] ${tag}${type ? `[type=${type}]` : ''}: ${label}`);
    });
    return [
      `Title: ${document.title}`,
      `URL: ${location.href}`,
      '',
      'Interactive elements:',
      ...elements.slice(0, 50),
      '',
      'Page text (truncated):',
      body.innerText.slice(0, 4000),
    ].join('\n');
  }).catch(() => '(could not extract page content)');
  return text;
}

// ─── Tool handlers ────────────────────────────────────────────────────────────

const NavigateSchema = z.object({
  url: z.string().url(),
  taskId: z.string().default('default'),
});

export async function handleNavigate(raw: Record<string, unknown>): Promise<ToolResult> {
  const parsed = NavigateSchema.safeParse(raw);
  if (!parsed.success) return { toolCallId: '', content: parsed.error.toString(), isError: true };
  const { url, taskId } = parsed.data;

  try {
    if (getBackend() === 'browser-use') {
      const apiKey = process.env['BROWSER_USE_API_KEY'] ?? '';
      const session = getBrowserUseSession(taskId) ?? createBrowserUseSession(taskId, apiKey);
      const snapshot = await buNavigate(session, url);
      return { toolCallId: '', content: `Navigated to ${url}\n\n${snapshot}`, isError: false };
    }

    const { page } = await getOrCreateLocalSession(taskId);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const title = await page.title();
    const snapshot = await buildSnapshot(page);
    return {
      toolCallId: '',
      content: `Navigated to: ${title} (${url})\n\n${snapshot.slice(0, 8000)}`,
      isError: false,
    };
  } catch (err) {
    return { toolCallId: '', content: String(err), isError: true };
  }
}

const ClickSchema = z.object({
  ref: z.string().min(1).describe('Accessibility ref (nodeId) or CSS selector'),
  taskId: z.string().default('default'),
});

export async function handleClick(raw: Record<string, unknown>): Promise<ToolResult> {
  const parsed = ClickSchema.safeParse(raw);
  if (!parsed.success) return { toolCallId: '', content: parsed.error.toString(), isError: true };
  const { ref, taskId } = parsed.data;

  try {
    if (getBackend() === 'browser-use') {
      const session = getBrowserUseSession(taskId);
      if (!session) return { toolCallId: '', content: 'No active browser session', isError: true };
      const result = await buClick(session, ref);
      return { toolCallId: '', content: result, isError: false };
    }

    const { page } = await getOrCreateLocalSession(taskId);
    // Try ref as nodeId first, then as CSS selector
    try {
      await page.locator(`[aria-label="${ref}"], [role][name="${ref}"]`).first().click({ timeout: 5000 });
    } catch {
      await page.click(ref, { timeout: 10_000 });
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    const snapshot = await buildSnapshot(page);
    return { toolCallId: '', content: `Clicked ${ref}\n\n${snapshot.slice(0, 6000)}`, isError: false };
  } catch (err) {
    return { toolCallId: '', content: String(err), isError: true };
  }
}

const TypeSchema = z.object({
  ref: z.string().min(1).describe('Accessibility ref or CSS selector'),
  text: z.string(),
  taskId: z.string().default('default'),
  pressEnter: z.boolean().default(false),
});

export async function handleType(raw: Record<string, unknown>): Promise<ToolResult> {
  const parsed = TypeSchema.safeParse(raw);
  if (!parsed.success) return { toolCallId: '', content: parsed.error.toString(), isError: true };
  const { ref, text, taskId, pressEnter } = parsed.data;

  try {
    if (getBackend() === 'browser-use') {
      const session = getBrowserUseSession(taskId);
      if (!session) return { toolCallId: '', content: 'No active browser session', isError: true };
      const result = await buType(session, ref, text);
      return { toolCallId: '', content: result, isError: false };
    }

    const { page } = await getOrCreateLocalSession(taskId);
    await page.fill(ref, text, { timeout: 10_000 });
    if (pressEnter) await page.keyboard.press('Enter');
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    return { toolCallId: '', content: `Typed "${text}" into ${ref}`, isError: false };
  } catch (err) {
    return { toolCallId: '', content: String(err), isError: true };
  }
}

const SnapshotSchema = z.object({
  taskId: z.string().default('default'),
});

export async function handleSnapshot(raw: Record<string, unknown>): Promise<ToolResult> {
  const parsed = SnapshotSchema.safeParse(raw);
  if (!parsed.success) return { toolCallId: '', content: parsed.error.toString(), isError: true };
  const { taskId } = parsed.data;

  try {
    if (getBackend() === 'browser-use') {
      const session = getBrowserUseSession(taskId);
      if (!session) return { toolCallId: '', content: 'No active browser session', isError: true };
      const snapshot = await buSnapshot(session);
      return { toolCallId: '', content: snapshot, isError: false };
    }

    const { page } = await getOrCreateLocalSession(taskId);
    const url = page.url();
    const title = await page.title();
    const snapshot = await buildSnapshot(page);
    return {
      toolCallId: '',
      content: `Current page: ${title} (${url})\n\n${snapshot.slice(0, 10_000)}`,
      isError: false,
    };
  } catch (err) {
    return { toolCallId: '', content: String(err), isError: true };
  }
}

const ScreenshotSchema = z.object({
  taskId: z.string().default('default'),
  fullPage: z.boolean().default(false),
});

export async function handleScreenshot(raw: Record<string, unknown>): Promise<ToolResult> {
  const parsed = ScreenshotSchema.safeParse(raw);
  if (!parsed.success) return { toolCallId: '', content: parsed.error.toString(), isError: true };
  const { taskId, fullPage } = parsed.data;

  if (getBackend() === 'browser-use') {
    return { toolCallId: '', content: 'Screenshots not supported with Browser Use backend', isError: true };
  }

  try {
    const { page } = await getOrCreateLocalSession(taskId);
    const buf = await page.screenshot({ type: 'png', fullPage });
    const b64 = buf.toString('base64');
    return {
      toolCallId: '',
      content: `data:image/png;base64,${b64}`,
      isError: false,
    };
  } catch (err) {
    return { toolCallId: '', content: String(err), isError: true };
  }
}

const CloseSchema = z.object({
  taskId: z.string().default('default'),
});

export async function handleClose(raw: Record<string, unknown>): Promise<ToolResult> {
  const parsed = CloseSchema.safeParse(raw);
  if (!parsed.success) return { toolCallId: '', content: parsed.error.toString(), isError: true };
  const { taskId } = parsed.data;

  try {
    if (getBackend() === 'browser-use') {
      const session = getBrowserUseSession(taskId);
      if (session) await buClose(session);
    } else {
      await closeLocal(taskId);
    }
    return { toolCallId: '', content: `Browser session ${taskId} closed`, isError: false };
  } catch (err) {
    return { toolCallId: '', content: String(err), isError: true };
  }
}

// ─── Tool definitions (OpenAI / Anthropic schema format) ─────────────────────

export const BROWSER_TOOL_DEFINITIONS = [
  {
    name: 'browser_navigate',
    description:
      'Navigate the browser to a URL and return the page accessibility tree. Creates a new session if none exists for this taskId.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to (must include https://)' },
        taskId: { type: 'string', description: 'Session ID for isolation (default: "default")', default: 'default' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_click',
    description:
      'Click an element on the current page. Use the accessibility ref from browser_snapshot, or a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Accessibility nodeId ref from snapshot, or CSS selector' },
        taskId: { type: 'string', default: 'default' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an input field.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'CSS selector or accessibility ref for the input' },
        text: { type: 'string', description: 'Text to type' },
        taskId: { type: 'string', default: 'default' },
        pressEnter: { type: 'boolean', description: 'Press Enter after typing', default: false },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Get the current page as an accessibility tree (text mode). Use this to see the page state before clicking or typing.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', default: 'default' },
      },
      required: [],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a screenshot of the current browser page as a base64 PNG image.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', default: 'default' },
        fullPage: { type: 'boolean', description: 'Capture full scrollable page (default: viewport only)', default: false },
      },
      required: [],
    },
  },
  {
    name: 'browser_close',
    description: 'Close the browser session and free resources.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', default: 'default' },
      },
      required: [],
    },
  },
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_DEFINITIONS)[number]['name'];

export const BROWSER_HANDLERS: Record<BrowserToolName, (input: Record<string, unknown>) => Promise<ToolResult>> = {
  browser_navigate: handleNavigate,
  browser_click: handleClick,
  browser_type: handleType,
  browser_snapshot: handleSnapshot,
  browser_screenshot: handleScreenshot,
  browser_close: handleClose,
};
