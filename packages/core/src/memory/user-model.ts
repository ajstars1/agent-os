/**
 * USER.md — persistent user model updated after every session.
 *
 * Mirrors Hermes Agent's USER.md pattern but integrated with agent-os's
 * existing UserProfileStore. The USER.md acts as a frozen snapshot injected
 * into the system prompt at session start, preserving Anthropic prefix cache.
 *
 * Update cycle (after assistant responds):
 *   1. Extract new facts about the user from the exchange
 *   2. Merge into the § -delimited USER.md file
 *   3. Next session starts with the updated snapshot
 *
 * File location: ~/.agent-os/USER.md
 * Delimiter: § (section sign) between entries, same as Hermes
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Logger } from '@agent-os-core/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

export type UserModelAction = 'add' | 'replace' | 'remove' | 'read';

export interface UserModelEntry {
  key: string;
  value: string;
}

// ─── File paths ───────────────────────────────────────────────────────────────

function userMdPath(): string {
  const dir = join(homedir(), '.agent-os');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'USER.md');
}

const DELIMITER = '§';
const MAX_CHARS = 8_000; // keep the snapshot from bloating the context window

// ─── Read / parse ─────────────────────────────────────────────────────────────

export function readUserModel(): string {
  const path = userMdPath();
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function parseEntries(content: string): UserModelEntry[] {
  return content
    .split(DELIMITER)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((block) => {
      const newline = block.indexOf('\n');
      const key = newline >= 0 ? block.slice(0, newline).trim() : block.trim();
      const value = newline >= 0 ? block.slice(newline + 1).trim() : '';
      return { key, value };
    });
}

function serialiseEntries(entries: UserModelEntry[]): string {
  return entries.map((e) => `${e.key}\n${e.value}`).join(`\n${DELIMITER}\n`);
}

// ─── Write operations ─────────────────────────────────────────────────────────

export function addUserFact(key: string, value: string): void {
  const content = readUserModel();
  const entries = parseEntries(content);

  // Prevent duplicate keys
  const existingIdx = entries.findIndex((e) => e.key.toLowerCase() === key.toLowerCase());
  if (existingIdx >= 0) {
    entries[existingIdx] = { key, value };
  } else {
    entries.push({ key, value });
  }

  const updated = serialiseEntries(entries);
  writeUserModel(updated.slice(0, MAX_CHARS));
}

export function replaceUserFact(keySubstring: string, newKey: string, newValue: string): boolean {
  const content = readUserModel();
  const entries = parseEntries(content);
  const idx = entries.findIndex((e) => e.key.toLowerCase().includes(keySubstring.toLowerCase()));
  if (idx < 0) return false;
  entries[idx] = { key: newKey, value: newValue };
  writeUserModel(serialiseEntries(entries).slice(0, MAX_CHARS));
  return true;
}

export function removeUserFact(keySubstring: string): boolean {
  const content = readUserModel();
  const entries = parseEntries(content);
  const before = entries.length;
  const filtered = entries.filter((e) => !e.key.toLowerCase().includes(keySubstring.toLowerCase()));
  if (filtered.length === before) return false;
  writeUserModel(serialiseEntries(filtered));
  return true;
}

function writeUserModel(content: string): void {
  writeFileSync(userMdPath(), content, 'utf-8');
}

// ─── System prompt injection ──────────────────────────────────────────────────

/** Returns the USER.md content formatted for system prompt injection. */
export function getUserModelBlock(): string {
  const content = readUserModel();
  if (!content.trim()) return '';
  return `## What I Know About You\n\n${content}`;
}

// ─── LLM-assisted extraction ──────────────────────────────────────────────────

/**
 * Extract new user facts from a conversation exchange and merge into USER.md.
 * Runs asynchronously after each response — never blocks the main thread.
 *
 * Only extracts facts that are:
 * - Persistent (not ephemeral request context)
 * - Personal (about the user's identity, preferences, projects, habits)
 * - Not already captured (checked by content hash)
 */
export async function extractAndUpdateUserModel(
  userMessage: string,
  assistantResponse: string,
  logger: Logger,
  anthropicKey?: string,
): Promise<void> {
  const apiKey = anthropicKey ?? process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) return;

  // Skip short exchanges — not enough signal
  if (userMessage.length + assistantResponse.length < 200) return;

  // Deduplicate: skip if we've processed this exact exchange recently
  const hash = createHash('sha256')
    .update(userMessage.slice(0, 100) + assistantResponse.slice(0, 100))
    .digest('hex')
    .slice(0, 12);

  const seenPath = join(homedir(), '.agent-os', '.user-model-seen');
  let seenHashes: Set<string>;
  try {
    seenHashes = new Set(readFileSync(seenPath, 'utf-8').trim().split('\n').filter(Boolean));
  } catch {
    seenHashes = new Set();
  }
  if (seenHashes.has(hash)) return;

  const currentModel = readUserModel();
  const prompt = `You are updating a persistent user profile from a conversation.

Current profile:
${currentModel.slice(0, 2000) || '(empty — first entry)'}

New conversation exchange:
User: ${userMessage.slice(0, 500)}
Assistant: ${assistantResponse.slice(0, 300)}

Extract at most 2 NEW facts about the user that are:
- Persistent (role, project, preference, habit, frustration, goal)
- NOT already in the current profile
- NOT ephemeral (not "user asked about X today")

For each fact, output exactly:
ADD: <short key>
<one-line value>

If nothing new to add, output: NOTHING

Rules:
- Key must be under 40 chars
- Value must be under 120 chars
- Never output more than 2 ADD blocks`;

  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content.find((c) => c.type === 'text')?.text ?? '';

    if (text.trim() === 'NOTHING') return;

    // Parse ADD blocks
    const addBlocks = [...text.matchAll(/ADD:\s*(.+)\n(.+)/g)];
    for (const m of addBlocks) {
      const key = (m[1] ?? '').trim().slice(0, 60);
      const value = (m[2] ?? '').trim().slice(0, 150);
      if (key && value) {
        addUserFact(key, value);
        logger.debug({ key }, '[UserModel] Added fact');
      }
    }

    // Mark as seen
    seenHashes.add(hash);
    try {
      writeFileSync(seenPath, [...seenHashes].slice(-500).join('\n') + '\n', 'utf-8');
    } catch { /* ignore */ }
  } catch (err) {
    logger.warn({ err }, '[UserModel] Extraction failed');
  }
}

// ─── Tool handler ─────────────────────────────────────────────────────────────

export function handleUserModelTool(
  action: UserModelAction,
  key?: string,
  value?: string,
): { content: string; isError: boolean } {
  switch (action) {
    case 'read':
      return { content: readUserModel() || '(no user facts recorded yet)', isError: false };

    case 'add':
      if (!key || !value) return { content: 'add requires key and value', isError: true };
      addUserFact(key, value);
      return { content: `Added: ${key}`, isError: false };

    case 'replace': {
      if (!key || !value) return { content: 'replace requires key and value', isError: true };
      const [searchKey, ...rest] = key.split('::');
      const newKey = rest.join('::') || searchKey!;
      const ok = replaceUserFact(searchKey!, newKey, value);
      return { content: ok ? `Replaced: ${newKey}` : `Not found: ${searchKey}`, isError: !ok };
    }

    case 'remove':
      if (!key) return { content: 'remove requires key', isError: true };
      const ok = removeUserFact(key);
      return { content: ok ? `Removed entries matching: ${key}` : `Not found: ${key}`, isError: !ok };

    default:
      return { content: `Unknown action: ${action as string}`, isError: true };
  }
}
