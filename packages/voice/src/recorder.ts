/**
 * Audio recorder — captures mic input to a temp WAV file.
 *
 * Uses system commands, tried in order:
 *   Linux:  arecord (ALSA) → sox → ffmpeg
 *   macOS:  sox → ffmpeg
 *   Windows: ffmpeg
 *
 * No npm audio dependency needed — ships with zero weight.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';

const execFileAsync = promisify(execFile);

export interface RecordingSession {
  filePath: string;
  stop: () => Promise<void>;
}

function tempWavPath(): string {
  return join(tmpdir(), `agent-os-rec-${Date.now()}.wav`);
}

async function hasCommand(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('which', [cmd]);
    return true;
  } catch {
    try {
      await execFileAsync('where', [cmd]); // Windows
      return true;
    } catch {
      return false;
    }
  }
}

/** Start recording from the default microphone. Returns a session handle. */
export async function startRecording(): Promise<RecordingSession> {
  const filePath = tempWavPath();
  let proc: ChildProcess;

  const platform = process.platform;

  if (platform === 'linux' && await hasCommand('arecord')) {
    // ALSA — most reliable on Linux
    proc = spawn('arecord', [
      '-f', 'S16_LE',
      '-r', '16000',
      '-c', '1',
      filePath,
    ], { stdio: 'ignore' });
  } else if (await hasCommand('sox')) {
    // sox — cross-platform
    proc = spawn('sox', [
      '-d',           // default input device
      '-r', '16000',
      '-c', '1',
      '-e', 'signed',
      '-b', '16',
      filePath,
    ], { stdio: 'ignore' });
  } else if (await hasCommand('ffmpeg')) {
    // ffmpeg — universal fallback
    const inputDev = platform === 'darwin' ? ':0' :
                     platform === 'win32'  ? 'audio=Microphone' :
                     'default';
    const inputFmt = platform === 'darwin' ? 'avfoundation' :
                     platform === 'win32'  ? 'dshow' :
                     'alsa';
    proc = spawn('ffmpeg', [
      '-f', inputFmt,
      '-i', inputDev,
      '-ar', '16000',
      '-ac', '1',
      '-y',
      filePath,
    ], { stdio: 'ignore' });
  } else {
    throw new Error(
      'No audio recorder found. Install one of: arecord (Linux), sox, or ffmpeg.\n' +
      '  Ubuntu/Debian: sudo apt install alsa-utils\n' +
      '  macOS: brew install sox\n' +
      '  All: https://ffmpeg.org/download.html',
    );
  }

  const stop = (): Promise<void> => new Promise((resolve) => {
    if (!proc.pid) { resolve(); return; }
    proc.kill('SIGTERM');
    // Give it 300ms to flush then force-kill
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } }, 300);
    proc.on('close', () => { clearTimeout(timer); resolve(); });
  });

  return { filePath, stop };
}

/** Clean up a temp recording file. */
export function cleanupRecording(filePath: string): void {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch { /* ignore */ }
}
