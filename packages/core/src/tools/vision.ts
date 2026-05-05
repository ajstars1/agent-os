/**
 * Vision tools — image analysis and screenshot description.
 *
 * Tools:
 *   analyze_image(path_or_url)  — describe an image using Claude's vision API
 *   describe_screenshot()       — snapshot the current browser page and analyze it
 *
 * Uses the Claude Messages API with base64-encoded images.
 * Falls back to a URL media block when the input is already an http/https URL.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { ToolResult } from '@agent-os-core/shared';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js';

// ─── MIME detection ───────────────────────────────────────────────────────────

const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function getMime(filePath: string): string {
  return EXT_TO_MIME[extname(filePath).toLowerCase()] ?? 'image/jpeg';
}

// ─── analyze_image ────────────────────────────────────────────────────────────

const AnalyzeImageSchema = z.object({
  path_or_url: z.string().min(1),
  question: z.string().optional().default('Describe this image in detail.'),
});

export async function handleAnalyzeImage(
  raw: Record<string, unknown>,
  anthropicKey: string | undefined,
): Promise<ToolResult> {
  const parsed = AnalyzeImageSchema.safeParse(raw);
  if (!parsed.success) return { toolCallId: '', content: parsed.error.toString(), isError: true };
  const { path_or_url, question } = parsed.data;

  const apiKey = anthropicKey ?? process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    return { toolCallId: '', content: 'ANTHROPIC_API_KEY required for image analysis', isError: true };
  }

  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    // Determine source type
    const isUrl = path_or_url.startsWith('http://') || path_or_url.startsWith('https://');
    const isBase64 = path_or_url.startsWith('data:image/');

    let imageBlock: object;

    if (isUrl) {
      imageBlock = {
        type: 'image',
        source: { type: 'url', url: path_or_url },
      };
    } else if (isBase64) {
      const match = path_or_url.match(/^data:(image\/[a-z]+);base64,(.+)$/);
      if (!match) return { toolCallId: '', content: 'Invalid base64 image format', isError: true };
      imageBlock = {
        type: 'image',
        source: { type: 'base64', media_type: match[1], data: match[2] },
      };
    } else {
      // Local file
      const resolved = path_or_url.startsWith('~')
        ? path_or_url.replace('~', homedir())
        : resolvePath(path_or_url);
      if (!existsSync(resolved)) {
        return { toolCallId: '', content: `File not found: ${resolved}`, isError: true };
      }
      const bytes = await readFile(resolved);
      const b64 = bytes.toString('base64');
      const mime = getMime(resolved);
      imageBlock = {
        type: 'image',
        source: { type: 'base64', media_type: mime, data: b64 },
      };
    }

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          imageBlock as ContentBlockParam,
          { type: 'text', text: question },
        ],
      }],
    });

    const text = msg.content.find((c) => c.type === 'text')?.text ?? '(no description)';
    return { toolCallId: '', content: text, isError: false };
  } catch (err) {
    return { toolCallId: '', content: String(err), isError: true };
  }
}

// ─── describe_screenshot ─────────────────────────────────────────────────────

const DescribeScreenshotSchema = z.object({
  taskId: z.string().default('default'),
  question: z.string().optional().default('What is shown on this webpage? Describe the layout, content, and any important UI elements.'),
});

export async function handleDescribeScreenshot(
  raw: Record<string, unknown>,
  anthropicKey: string | undefined,
): Promise<ToolResult> {
  const parsed = DescribeScreenshotSchema.safeParse(raw);
  if (!parsed.success) return { toolCallId: '', content: parsed.error.toString(), isError: true };
  const { taskId, question } = parsed.data;

  // Take screenshot via browser tool if available
  let screenshotB64 = '';
  try {
    const { handleScreenshot } = await import('@agent-os-core/browser' as string) as {
      handleScreenshot: (input: Record<string, unknown>) => Promise<ToolResult>;
    };
    const result = await handleScreenshot({ taskId });
    if (result.isError) return result;
    screenshotB64 = result.content; // data:image/png;base64,...
  } catch {
    return { toolCallId: '', content: 'Browser package not installed — cannot take screenshot', isError: true };
  }

  // Analyze the screenshot
  return handleAnalyzeImage({ path_or_url: screenshotB64, question }, anthropicKey);
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const VISION_TOOL_DEFINITIONS = [
  {
    name: 'analyze_image',
    description:
      'Analyze and describe an image. Accepts a local file path, URL, or base64 data URI. ' +
      'Can answer specific questions about the image content.',
    inputSchema: {
      type: 'object',
      properties: {
        path_or_url: {
          type: 'string',
          description: 'Local file path (absolute or ~/…), https:// URL, or data:image/… base64 URI',
        },
        question: {
          type: 'string',
          description: 'Specific question to answer about the image (default: general description)',
          default: 'Describe this image in detail.',
        },
      },
      required: ['path_or_url'],
    },
  },
  {
    name: 'describe_screenshot',
    description:
      'Take a screenshot of the current browser page and describe what is visible. ' +
      'Requires the browser package and an active browser session.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', default: 'default' },
        question: {
          type: 'string',
          description: 'Specific question about the page content',
          default: 'What is shown on this webpage?',
        },
      },
      required: [],
    },
  },
] as const;
