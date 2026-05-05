/**
 * Browser Use cloud backend.
 * Requires BROWSER_USE_API_KEY in env.
 * Wraps the Browser Use REST API — https://docs.browser-use.com
 */

export interface BrowserUseSession {
  sessionId: string;
  apiKey: string;
  baseUrl: string;
}

const _sessions = new Map<string, BrowserUseSession>();

const DEFAULT_BASE = 'https://api.browser-use.com/v1';

export function createBrowserUseSession(taskId: string, apiKey: string): BrowserUseSession {
  const session: BrowserUseSession = {
    sessionId: taskId,
    apiKey,
    baseUrl: DEFAULT_BASE,
  };
  _sessions.set(taskId, session);
  return session;
}

export function getBrowserUseSession(taskId: string): BrowserUseSession | undefined {
  return _sessions.get(taskId);
}

async function buFetch(
  session: BrowserUseSession,
  path: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(`${session.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Browser Use API ${res.status}: ${text}`);
  }
  return res.json();
}

export async function buNavigate(session: BrowserUseSession, url: string): Promise<string> {
  const result = await buFetch(session, '/navigate', { session_id: session.sessionId, url });
  return (result as { snapshot?: string }).snapshot ?? '(navigated)';
}

export async function buSnapshot(session: BrowserUseSession): Promise<string> {
  const result = await buFetch(session, '/snapshot', { session_id: session.sessionId });
  return (result as { snapshot?: string }).snapshot ?? '(empty page)';
}

export async function buClick(session: BrowserUseSession, ref: string): Promise<string> {
  await buFetch(session, '/click', { session_id: session.sessionId, ref });
  return `Clicked ${ref}`;
}

export async function buType(session: BrowserUseSession, ref: string, text: string): Promise<string> {
  await buFetch(session, '/type', { session_id: session.sessionId, ref, text });
  return `Typed into ${ref}`;
}

export async function buClose(session: BrowserUseSession): Promise<void> {
  await buFetch(session, '/close', { session_id: session.sessionId }).catch(() => {});
  _sessions.delete(session.sessionId);
}
