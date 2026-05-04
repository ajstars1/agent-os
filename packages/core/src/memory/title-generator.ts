import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '@agent-os-core/shared';

const TITLE_SYSTEM_PROMPT =
  'Generate a short, descriptive title (3-7 words) for a conversation that starts with the ' +
  'following exchange. Return ONLY the title text — no quotes, no punctuation at the end, no prefixes.';

/** Generate a conversation title from the first user+assistant exchange. */
async function generateTitle(
  apiKey: string | undefined,
  userMessage: string,
  assistantResponse: string,
  logger: Logger,
): Promise<string | null> {
  try {
    const client = new Anthropic(apiKey ? { apiKey } : {});
    const userSnippet = userMessage.slice(0, 500);
    const assistantSnippet = assistantResponse.slice(0, 500);

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 64,
      system: TITLE_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `User: ${userSnippet}\n\nAssistant: ${assistantSnippet}` },
      ],
    });

    const raw = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '';
    const cleaned = raw.replace(/^["']|["']$/g, '').replace(/^title:\s*/i, '').trim();
    if (!cleaned) return null;
    return cleaned.length > 80 ? cleaned.slice(0, 77) + '...' : cleaned;
  } catch (err: unknown) {
    logger.warn({ err }, 'Auto title generation failed');
    return null;
  }
}

export interface TitleStore {
  setTitle(conversationId: string, title: string): void;
  getTitle(conversationId: string): string | null;
}

/**
 * Fire-and-forget: generate a title after the first 1-2 exchanges.
 * Only runs when no title is already set.
 */
export function maybeAutoTitle(
  store: TitleStore,
  conversationId: string,
  userMessage: string,
  assistantResponse: string,
  messageCount: number,
  logger: Logger,
  apiKey?: string,
): void {
  if (!userMessage || !assistantResponse) return;
  if (messageCount > 4) return; // only on first ~2 exchanges

  const existing = store.getTitle(conversationId);
  if (existing) return;

  // Fire async — do not await
  generateTitle(apiKey, userMessage, assistantResponse, logger)
    .then((title) => {
      if (title) {
        store.setTitle(conversationId, title);
        logger.debug({ conversationId, title }, 'Auto-generated conversation title');
      }
    })
    .catch(() => {
      // swallow — title generation is best-effort
    });
}
