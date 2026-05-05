/**
 * Text-to-speech — converts text to audio and plays it.
 *
 * Backend priority (auto mode):
 *   1. System TTS    — always available, no API key (espeak/say/SAPI)
 *   2. OpenAI TTS   — OPENAI_API_KEY set, model tts-1, high quality
 *   3. ElevenLabs   — ELEVENLABS_API_KEY set, highest quality
 *
 * Playback uses system commands: aplay (Linux), afplay (macOS), ffplay (cross-platform).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export type TTSBackend = 'system' | 'openai' | 'elevenlabs' | 'auto';

export interface SpeakOptions {
  backend?: TTSBackend;
  voice?: string;        // backend-specific voice name
  speed?: number;        // 0.5–2.0
  openaiKey?: string;
  elevenLabsKey?: string;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/** Convert text to speech and play it. Resolves when playback completes. */
export async function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  const { backend = 'auto' } = opts;

  if (backend === 'openai' || (backend === 'auto' && (opts.openaiKey ?? process.env['OPENAI_API_KEY']))) {
    try {
      await speakOpenAI(text, opts);
      return;
    } catch { /* fall through */ }
  }

  if (backend === 'elevenlabs' || (backend === 'auto' && (opts.elevenLabsKey ?? process.env['ELEVENLABS_API_KEY']))) {
    try {
      await speakElevenLabs(text, opts);
      return;
    } catch { /* fall through */ }
  }

  // System TTS — always last resort, always works
  await speakSystem(text, opts);
}

// ─── System TTS ───────────────────────────────────────────────────────────────

async function speakSystem(text: string, opts: SpeakOptions): Promise<void> {
  const platform = process.platform;
  const speed = opts.speed ?? 1.0;

  if (platform === 'darwin') {
    const voice = opts.voice ?? 'Samantha';
    const rate = Math.round(180 * speed);
    await execFileAsync('say', ['-v', voice, '-r', String(rate), text]);
  } else if (platform === 'win32') {
    // PowerShell SAPI
    const escaped = text.replace(/'/g, "''");
    await execFileAsync('powershell', [
      '-Command',
      `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = ${Math.round((speed - 1) * 5)}; $s.Speak('${escaped}')`,
    ]);
  } else {
    // Linux — try espeak-ng, then espeak, then festival
    try {
      const speedWpm = Math.round(175 * speed);
      await execFileAsync('espeak-ng', ['-s', String(speedWpm), text]);
    } catch {
      try {
        await execFileAsync('espeak', [text]);
      } catch {
        // festival fallback
        try {
          const { spawn } = await import('node:child_process');
          await new Promise<void>((resolve, reject) => {
            const proc = spawn('festival', ['--tts'], { stdio: ['pipe', 'ignore', 'ignore'] });
            proc.stdin?.write(text);
            proc.stdin?.end();
            proc.on('close', resolve);
            proc.on('error', reject);
          });
        } catch {
          throw new Error(
            'No TTS engine found. Install one:\n' +
            '  Ubuntu: sudo apt install espeak-ng\n' +
            '  Or set OPENAI_API_KEY for cloud TTS.',
          );
        }
      }
    }
  }
}

// ─── OpenAI TTS ───────────────────────────────────────────────────────────────

async function speakOpenAI(text: string, opts: SpeakOptions): Promise<void> {
  const apiKey = opts.openaiKey ?? process.env['OPENAI_API_KEY'] ?? '';
  const voice = opts.voice ?? 'nova'; // nova, alloy, echo, fable, onyx, shimmer
  const speed = Math.max(0.25, Math.min(4.0, opts.speed ?? 1.0));

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text.slice(0, 4096),
      voice,
      speed,
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`OpenAI TTS ${res.status}`);

  const audioBytes = Buffer.from(await res.arrayBuffer());
  const tmpFile = join(tmpdir(), `agent-os-tts-${Date.now()}.mp3`);
  writeFileSync(tmpFile, audioBytes);

  try {
    await playAudioFile(tmpFile);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* */ }
  }
}

// ─── ElevenLabs TTS ──────────────────────────────────────────────────────────

async function speakElevenLabs(text: string, opts: SpeakOptions): Promise<void> {
  const apiKey = opts.elevenLabsKey ?? process.env['ELEVENLABS_API_KEY'] ?? '';
  // Default to Rachel voice (a stable ElevenLabs voice ID)
  const voiceId = opts.voice ?? '21m00Tcm4TlvDq8ikWAM';

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: text.slice(0, 5000),
      model_id: 'eleven_turbo_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}`);

  const audioBytes = Buffer.from(await res.arrayBuffer());
  const tmpFile = join(tmpdir(), `agent-os-tts-${Date.now()}.mp3`);
  writeFileSync(tmpFile, audioBytes);

  try {
    await playAudioFile(tmpFile);
  } finally {
    try { unlinkSync(tmpFile); } catch { /* */ }
  }
}

// ─── Playback ─────────────────────────────────────────────────────────────────

async function playAudioFile(filePath: string): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === 'darwin') {
      await execFileAsync('afplay', [filePath]);
    } else if (platform === 'win32') {
      await execFileAsync('powershell', [
        '-Command', `(New-Object Media.SoundPlayer '${filePath}').PlaySync()`,
      ]);
    } else {
      // Linux — try aplay (wav), mpg123, ffplay, paplay
      const ext = filePath.endsWith('.mp3') ? 'mp3' : 'wav';
      if (ext === 'mp3') {
        try { await execFileAsync('mpg123', ['-q', filePath]); return; } catch { /* */ }
        try { await execFileAsync('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', filePath]); return; } catch { /* */ }
      }
      try { await execFileAsync('aplay', [filePath]); } catch {
        await execFileAsync('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', filePath]);
      }
    }
  } catch (err) {
    throw new Error(`Audio playback failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Check which TTS backends are available on this system. */
export async function checkTTSAvailability(): Promise<Record<string, boolean>> {
  const platform = process.platform;
  const hasOpenAI = Boolean(process.env['OPENAI_API_KEY']);
  const hasElevenLabs = Boolean(process.env['ELEVENLABS_API_KEY']);

  let hasSystem = false;
  if (platform === 'darwin') hasSystem = true;
  else if (platform === 'win32') hasSystem = true;
  else {
    for (const cmd of ['espeak-ng', 'espeak', 'festival']) {
      try { await execFileAsync('which', [cmd]); hasSystem = true; break; } catch { /* */ }
    }
  }

  return { system: hasSystem, openai: hasOpenAI, elevenlabs: hasElevenLabs };
}
