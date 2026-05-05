/**
 * Bridge secret — a persistent random token stored at ~/.agent-os/.bridge-secret.
 * The VS Code extension reads this file to authenticate with the bridge server.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SECRET_PATH = join(homedir(), '.agent-os', '.bridge-secret');

export function getBridgeSecret(): string {
  // Env var takes priority (useful in CI / containers)
  if (process.env['BRIDGE_SECRET']) return process.env['BRIDGE_SECRET'];

  if (existsSync(SECRET_PATH)) {
    return readFileSync(SECRET_PATH, 'utf-8').trim();
  }

  // Generate and persist a new secret
  const secret = randomBytes(32).toString('hex');
  mkdirSync(join(homedir(), '.agent-os'), { recursive: true });
  writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}

export function secretFilePath(): string {
  return SECRET_PATH;
}
