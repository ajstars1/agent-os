/**
 * Voice conversation loop — ties together recording, transcription, agent, and TTS.
 *
 * Flow per turn:
 *   1. Print prompt → user presses ENTER to start recording
 *   2. Mic records until user presses ENTER again
 *   3. Transcribe audio → show transcript
 *   4. Stream agent response → collect full text
 *   5. Speak the response via TTS
 *   6. Repeat
 *
 * Usage:
 *   aos --voice
 *   aos --voice --tts openai --stt openai
 */

import { createInterface } from 'node:readline';
import type { AgentEngine } from '@agent-os-core/core';
import type { Logger } from '@agent-os-core/shared';
import { startRecording, cleanupRecording } from './recorder.js';
import { transcribe } from './transcriber.js';
import { speak, checkTTSAvailability } from './tts.js';

export interface VoiceLoopOptions {
  /** Conversation/channel ID to use (defaults to 'voice'). */
  conversationId?: string;
  engine: AgentEngine;
  logger?: Logger;
  ttsBackend?: 'system' | 'openai' | 'elevenlabs' | 'auto';
  ttsVoice?: string;
  sttLanguage?: string;
  openaiKey?: string;
  elevenLabsKey?: string;
  /** If true, auto-detect silence to stop recording (not yet implemented — falls back to manual). */
  vad?: boolean;
}

function print(msg: string): void {
  process.stdout.write(msg + '\n');
}

function printDim(msg: string): void {
  process.stdout.write(`\x1b[2m${msg}\x1b[0m\n`);
}

function printGreen(msg: string): void {
  process.stdout.write(`\x1b[32m${msg}\x1b[0m\n`);
}

function printCyan(msg: string): void {
  process.stdout.write(`\x1b[36m${msg}\x1b[0m\n`);
}

export async function runVoiceLoop(opts: VoiceLoopOptions): Promise<void> {
  const {
    conversationId = 'voice',
    engine,
    logger,
    ttsBackend = 'auto',
    ttsVoice,
    sttLanguage,
    openaiKey,
    elevenLabsKey,
  } = opts;

  // Availability check
  const ttsStatus = await checkTTSAvailability();
  print('\n🎙️  AgentOS Voice Mode\n');
  print(`TTS: ${Object.entries(ttsStatus).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none found'}`);
  print(`STT: ${openaiKey ?? process.env['OPENAI_API_KEY'] ? 'Whisper API' : 'local engine'}`);
  print('\nCommands: ENTER = start/stop recording | "exit" or Ctrl+C = quit\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let running = true;

  process.on('SIGINT', () => { running = false; rl.close(); });

  while (running) {
    // ── Step 1: Wait for ENTER to start recording ──────────────────────────
    await new Promise<void>((resolve) => {
      rl.question('\x1b[33m● Press ENTER to speak…\x1b[0m ', (answer) => {
        if (answer.toLowerCase() === 'exit' || answer.toLowerCase() === 'quit') {
          running = false;
        }
        resolve();
      });
    });

    if (!running) break;

    // ── Step 2: Start recording ────────────────────────────────────────────
    let session;
    try {
      session = await startRecording();
      print('\x1b[31m● Recording… (press ENTER to stop)\x1b[0m');
    } catch (err) {
      print(`\x1b[31mRecording failed: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
      printDim('You can type your message manually instead:');
      const typed = await new Promise<string>((resolve) => rl.question('> ', resolve));
      if (typed.toLowerCase() === 'exit') break;
      await processTextTurn(typed, conversationId, engine, logger, ttsBackend, ttsVoice, openaiKey, elevenLabsKey);
      continue;
    }

    // ── Step 3: Wait for ENTER to stop ────────────────────────────────────
    await new Promise<void>((resolve) => rl.question('', () => resolve()));
    await session.stop();
    print('\x1b[33m⏳ Transcribing…\x1b[0m');

    // ── Step 4: Transcribe ─────────────────────────────────────────────────
    let transcript = '';
    try {
      transcript = await transcribe(session.filePath, {
        language: sttLanguage,
        openaiKey,
      });
    } catch (err) {
      print(`\x1b[31mTranscription failed: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
    } finally {
      cleanupRecording(session.filePath);
    }

    if (!transcript.trim()) {
      printDim('(nothing heard — try speaking louder or check your microphone)');
      continue;
    }

    printGreen(`You: ${transcript}`);

    await processTextTurn(transcript, conversationId, engine, logger, ttsBackend, ttsVoice, openaiKey, elevenLabsKey);
  }

  rl.close();
  print('\n👋 Voice mode ended.\n');
}

async function processTextTurn(
  message: string,
  conversationId: string,
  engine: AgentEngine,
  logger: Logger | undefined,
  ttsBackend: 'system' | 'openai' | 'elevenlabs' | 'auto',
  ttsVoice: string | undefined,
  openaiKey: string | undefined,
  elevenLabsKey: string | undefined,
): Promise<void> {
  printCyan('Assistant: ');
  let fullResponse = '';

  try {
    for await (const chunk of engine.chat({ conversationId, message })) {
      if (chunk.type === 'text' && chunk.content) {
        process.stdout.write(chunk.content);
        fullResponse += chunk.content;
      }
      if (chunk.type === 'done') break;
    }
    process.stdout.write('\n');
  } catch (err) {
    print(`\x1b[31mAgent error: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
    return;
  }

  if (!fullResponse.trim()) return;

  // Speak the response
  try {
    // Strip markdown for cleaner TTS
    const spoken = fullResponse
      .replace(/```[\s\S]*?```/g, '[code block]')
      .replace(/`[^`]+`/g, '')
      .replace(/[*_#>\[\]]/g, '')
      .replace(/\n+/g, ' ')
      .trim()
      .slice(0, 500); // cap at 500 chars for voice

    await speak(spoken, {
      backend: ttsBackend,
      voice: ttsVoice,
      openaiKey,
      elevenLabsKey,
    });
  } catch (err) {
    if (logger) logger.warn({ err }, '[Voice] TTS playback failed');
    else process.stderr.write(`[Voice] TTS playback failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
