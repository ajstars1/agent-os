import type { Browser, BrowserContext, Page } from 'playwright';

export interface BrowserSession {
  taskId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  createdAt: number;
}

/** In-memory session registry — one session per taskId. */
const _sessions = new Map<string, BrowserSession>();

export function getSession(taskId: string): BrowserSession | undefined {
  return _sessions.get(taskId);
}

export function setSession(taskId: string, session: BrowserSession): void {
  _sessions.set(taskId, session);
}

export function deleteSession(taskId: string): void {
  _sessions.delete(taskId);
}

/** Close and remove a session. Silently ignores errors. */
export async function closeSession(taskId: string): Promise<void> {
  const session = _sessions.get(taskId);
  if (!session) return;
  _sessions.delete(taskId);
  try {
    await session.context.close();
    await session.browser.close();
  } catch {
    // ignore cleanup errors
  }
}

/** Close all sessions (called on process exit). */
export async function closeAllSessions(): Promise<void> {
  const ids = [..._sessions.keys()];
  await Promise.allSettled(ids.map(closeSession));
}
