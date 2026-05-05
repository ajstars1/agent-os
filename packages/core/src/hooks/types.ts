import { z } from 'zod';

// ─── Hook event names ─────────────────────────────────────────────────────────

export type HookEvent =
  | 'toolUsePre'    // Before a tool runs — can block execution
  | 'toolUsePost'   // After a tool completes — gets output
  | 'toolUseError'  // On tool failure
  | 'messageReceived' // When user sends a message
  | 'responseDone';   // After the full assistant response is emitted

// ─── Hook types ───────────────────────────────────────────────────────────────

/** Run a shell command when the hook fires. stdout is logged. */
const CommandHookSchema = z.object({
  type: z.literal('command'),
  command: z.string().min(1),
  /** Env vars injected into the command's environment. */
  env: z.record(z.string()).optional(),
  /** Timeout in ms (default 30s). */
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
  /** If true, run only once per session and then deactivate. */
  once: z.boolean().default(false),
});

/** POST the hook payload as JSON to a URL. */
const HttpHookSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
  once: z.boolean().default(false),
});

/** Prepend extra content to the next user prompt. */
const PromptHookSchema = z.object({
  type: z.literal('prompt'),
  /** The extra prompt text to prepend. Supports {toolName}, {toolInput}, {output} placeholders. */
  content: z.string().min(1),
  once: z.boolean().default(false),
});

export const HookDefinitionSchema = z.discriminatedUnion('type', [
  CommandHookSchema,
  HttpHookSchema,
  PromptHookSchema,
]);
export type HookDefinition = z.infer<typeof HookDefinitionSchema>;

// ─── Hook matcher ─────────────────────────────────────────────────────────────

/**
 * A hook binding: which events trigger this hook, optional tool-name filter,
 * and the hook definition itself.
 *
 * Example in settings.json:
 * ```json
 * {
 *   "hooks": [
 *     {
 *       "events": ["toolUsePre"],
 *       "match": "bash",
 *       "hook": { "type": "command", "command": "echo 'about to run bash'" }
 *     }
 *   ]
 * }
 * ```
 */
export const HookBindingSchema = z.object({
  /** One or more events that trigger this hook. */
  events: z.array(z.enum(['toolUsePre', 'toolUsePost', 'toolUseError', 'messageReceived', 'responseDone'])).min(1),
  /**
   * Optional tool name match (exact or glob). Only applies for tool* events.
   * Examples: "bash", "edit", "bash|read_file", "*"
   */
  match: z.string().optional(),
  hook: HookDefinitionSchema,
});
export type HookBinding = z.infer<typeof HookBindingSchema>;

// ─── Payload passed to hooks ──────────────────────────────────────────────────

export interface HookPayload {
  event: HookEvent;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  output?: string;
  isError?: boolean;
  message?: string;
  sessionId?: string;
  timestamp: number;
}

// ─── Hook result ─────────────────────────────────────────────────────────────

export interface HookResult {
  /** For toolUsePre command hooks: if the command exits non-zero, the tool call is blocked. */
  blocked: boolean;
  /** Output from command hooks — shown as a status message. */
  output?: string;
  /** For prompt hooks: extra text to prepend to the next message. */
  promptAddition?: string;
}
