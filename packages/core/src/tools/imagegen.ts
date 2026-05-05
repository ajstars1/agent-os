/**
 * Image generation tool — multi-backend image synthesis.
 *
 * Backends (tried in priority order unless specified):
 *   dall-e-3   — OpenAI DALL-E 3 (OPENAI_API_KEY, ~$0.04/image)
 *   flux       — Flux Schnell via Replicate (REPLICATE_API_TOKEN, ~$0.003/image)
 *   sd-local   — Stable Diffusion via local A1111 API (SD_API_URL, free)
 *
 * Output: saves PNG to ~/.agent-os/images/ and returns the file path + description.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { ToolResult } from '@agent-os-core/shared';

// ─── Output dir ───────────────────────────────────────────────────────────────

function imagesDir(): string {
  const dir = join(homedir(), '.agent-os', 'images');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function imagePath(prefix: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return join(imagesDir(), `${prefix}-${ts}.png`);
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const GenerateImageSchema = z.object({
  prompt: z.string().min(1).max(4000),
  model: z.enum(['dall-e-3', 'flux', 'sd-local', 'auto']).default('auto'),
  size: z.enum(['1024x1024', '1792x1024', '1024x1792', '512x512']).default('1024x1024'),
  quality: z.enum(['standard', 'hd']).default('standard'),
  style: z.enum(['vivid', 'natural']).default('vivid'),
});

// ─── Backends ─────────────────────────────────────────────────────────────────

async function generateDallE3(
  prompt: string,
  apiKey: string,
  size: string,
  quality: string,
  style: string,
): Promise<{ url: string; revisedPrompt?: string }> {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size,
      quality,
      style,
      response_format: 'url',
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`DALL-E 3 error ${res.status}: ${err}`);
  }

  const json = await res.json() as { data?: Array<{ url?: string; revised_prompt?: string }> };
  const item = json.data?.[0];
  if (!item?.url) throw new Error('DALL-E 3 returned no image URL');
  return { url: item.url, revisedPrompt: item.revised_prompt };
}

async function generateFlux(prompt: string, apiToken: string): Promise<string> {
  // Replicate API — synchronous prediction for flux-schnell
  const res = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions', {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiToken}`,
      'Content-Type': 'application/json',
      Prefer: 'wait', // synchronous mode — waits for completion
    },
    body: JSON.stringify({
      input: { prompt, num_outputs: 1, output_format: 'png' },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`Replicate/Flux error ${res.status}`);
  const json = await res.json() as { output?: string[] };
  const url = json.output?.[0];
  if (!url) throw new Error('Flux returned no image URL');
  return url;
}

async function generateSDLocal(prompt: string, sdUrl: string, size: string): Promise<string> {
  const [width, height] = size.split('x').map(Number);
  const res = await fetch(`${sdUrl}/sdapi/v1/txt2img`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      negative_prompt: 'blurry, low quality, ugly, watermark',
      width: width ?? 512,
      height: height ?? 512,
      steps: 20,
      cfg_scale: 7,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) throw new Error(`SD local error ${res.status}`);
  const json = await res.json() as { images?: string[] };
  const b64 = json.images?.[0];
  if (!b64) throw new Error('SD returned no image');
  return `data:image/png;base64,${b64}`;
}

// ─── Save image from URL or base64 ───────────────────────────────────────────

async function saveImage(source: string, prefix: string): Promise<string> {
  const path = imagePath(prefix);

  if (source.startsWith('data:image/')) {
    const b64 = source.split(',')[1] ?? '';
    writeFileSync(path, Buffer.from(b64, 'base64'));
    return path;
  }

  // Download from URL
  const res = await fetch(source, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Image download failed: ${res.status}`);
  const bytes = await res.arrayBuffer();
  writeFileSync(path, Buffer.from(bytes));
  return path;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function handleGenerateImage(raw: Record<string, unknown>): Promise<ToolResult> {
  const parsed = GenerateImageSchema.safeParse(raw);
  if (!parsed.success) return { toolCallId: '', content: parsed.error.toString(), isError: true };
  const { prompt, model, size, quality, style } = parsed.data;

  const openaiKey = process.env['OPENAI_API_KEY'];
  const replicateToken = process.env['REPLICATE_API_TOKEN'];
  const sdUrl = process.env['SD_API_URL'] ?? 'http://localhost:7860';

  // Determine backend
  const backend = model === 'auto'
    ? openaiKey ? 'dall-e-3' : replicateToken ? 'flux' : 'sd-local'
    : model;

  try {
    let imageSource: string;
    let revisedPrompt: string | undefined;

    if (backend === 'dall-e-3') {
      if (!openaiKey) return { toolCallId: '', content: 'OPENAI_API_KEY required for DALL-E 3', isError: true };
      const result = await generateDallE3(prompt, openaiKey, size, quality, style);
      imageSource = result.url;
      revisedPrompt = result.revisedPrompt;
    } else if (backend === 'flux') {
      if (!replicateToken) return { toolCallId: '', content: 'REPLICATE_API_TOKEN required for Flux', isError: true };
      imageSource = await generateFlux(prompt, replicateToken);
    } else {
      imageSource = await generateSDLocal(prompt, sdUrl, size);
    }

    const savedPath = await saveImage(imageSource, backend);
    const lines = [
      `Image generated with ${backend}`,
      `Saved to: ${savedPath}`,
      `Size: ${size}`,
    ];
    if (revisedPrompt && revisedPrompt !== prompt) {
      lines.push(`Revised prompt: ${revisedPrompt}`);
    }

    return { toolCallId: '', content: lines.join('\n'), isError: false };
  } catch (err) {
    return { toolCallId: '', content: String(err), isError: true };
  }
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export const IMAGEGEN_TOOL_DEFINITION = {
  name: 'generate_image',
  description:
    'Generate an image from a text prompt. ' +
    'Backends: dall-e-3 (OPENAI_API_KEY), flux (REPLICATE_API_TOKEN), sd-local (local Stable Diffusion). ' +
    'Images are saved to ~/.agent-os/images/ and the file path is returned.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed description of the image to generate' },
      model: {
        type: 'string',
        enum: ['dall-e-3', 'flux', 'sd-local', 'auto'],
        description: 'Image model (auto picks best available)',
        default: 'auto',
      },
      size: {
        type: 'string',
        enum: ['1024x1024', '1792x1024', '1024x1792'],
        description: 'Image dimensions (default 1024x1024)',
        default: '1024x1024',
      },
      quality: {
        type: 'string',
        enum: ['standard', 'hd'],
        description: 'DALL-E 3 quality (standard is faster, hd is sharper)',
        default: 'standard',
      },
    },
    required: ['prompt'],
  },
} as const;
