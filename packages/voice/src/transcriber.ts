/**
 * Audio transcription — converts a WAV file to text.
 *
 * Backend priority:
 *   1. OpenAI Whisper API  (OPENAI_API_KEY set)
 *   2. Local Whisper via Python engine  (NEURAL_ENGINE_URL + /transcribe endpoint)
 *   3. Error with install instructions
 *
 * Whisper API model: whisper-1 (~$0.006/min, very fast)
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export type TranscriberBackend = 'openai' | 'local' | 'auto';

export interface TranscribeOptions {
  backend?: TranscriberBackend;
  language?: string; // ISO 639-1, e.g. 'en', 'hi', 'ja'
  openaiKey?: string;
  engineUrl?: string;
}

/** Transcribe a WAV file to text. Throws on failure. */
export async function transcribe(filePath: string, opts: TranscribeOptions = {}): Promise<string> {
  const { backend = 'auto', language, openaiKey, engineUrl } = opts;

  const apiKey = openaiKey ?? process.env['OPENAI_API_KEY'];
  const engineBase = engineUrl ?? process.env['NEURAL_ENGINE_URL'] ?? 'http://localhost:8765';

  if (backend === 'openai' || (backend === 'auto' && apiKey)) {
    return transcribeOpenAI(filePath, apiKey!, language);
  }

  if (backend === 'local' || backend === 'auto') {
    try {
      return await transcribeLocal(filePath, engineBase, language);
    } catch {
      // fall through to error
    }
  }

  throw new Error(
    'No transcription backend available.\n' +
    'Set OPENAI_API_KEY to use Whisper API, or start the neural engine for local Whisper.',
  );
}

async function transcribeOpenAI(filePath: string, apiKey: string, language?: string): Promise<string> {
  const audioBytes = readFileSync(filePath);
  const blob = new Blob([audioBytes], { type: 'audio/wav' });

  const form = new FormData();
  form.append('file', blob, basename(filePath));
  form.append('model', 'whisper-1');
  form.append('response_format', 'text');
  if (language) form.append('language', language);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Whisper API error ${res.status}: ${err}`);
  }

  return (await res.text()).trim();
}

async function transcribeLocal(filePath: string, engineBase: string, language?: string): Promise<string> {
  const audioBytes = readFileSync(filePath);
  const b64 = audioBytes.toString('base64');

  const res = await fetch(`${engineBase}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_b64: b64, language: language ?? 'en' }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) throw new Error(`Local transcription error ${res.status}`);
  const json = await res.json() as { text?: string };
  return (json.text ?? '').trim();
}
