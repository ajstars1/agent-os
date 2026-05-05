import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { DeliveryTarget } from './jobs.js';

export interface DeliveryResult {
  ok: boolean;
  error?: string;
}

/** Deliver cron job output to the configured target. */
export async function deliver(
  jobId: string,
  jobName: string,
  output: string,
  target: DeliveryTarget,
): Promise<DeliveryResult> {
  switch (target) {
    case 'local':
      return deliverLocal(jobId, jobName, output);
    case 'discord':
      return deliverDiscord(jobName, output);
    case 'telegram':
      return deliverTelegram(jobName, output);
    case 'slack':
      return deliverSlack(jobName, output);
    case 'email':
      return deliverEmail(jobName, output);
    case 'cli':
      // CLI delivery just writes to stdout — the daemon picks it up
      process.stdout.write(`\n[cron/${jobName}] ${output}\n`);
      return { ok: true };
    default:
      return { ok: false, error: `Unknown delivery target: ${target}` };
  }
}

function deliverLocal(jobId: string, jobName: string, output: string): DeliveryResult {
  const dir = join(homedir(), '.agent-os', 'cron', 'output');
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `${jobName}-${ts}.txt`);
  writeFileSync(file, `Job: ${jobName} (${jobId})\nTime: ${new Date().toISOString()}\n\n${output}\n`, 'utf-8');
  return { ok: true };
}

async function deliverDiscord(jobName: string, output: string): Promise<DeliveryResult> {
  const webhookUrl = process.env['DISCORD_CRON_WEBHOOK_URL'];
  if (!webhookUrl) return { ok: false, error: 'DISCORD_CRON_WEBHOOK_URL not set' };

  try {
    const chunks = chunkText(output, 1900);
    for (const chunk of chunks) {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `**[cron/${jobName}]**\n\`\`\`\n${chunk}\n\`\`\`` }),
        signal: AbortSignal.timeout(10_000),
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function deliverTelegram(jobName: string, output: string): Promise<DeliveryResult> {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  const chatId = process.env['TELEGRAM_CRON_CHAT_ID'];
  if (!token || !chatId) return { ok: false, error: 'TELEGRAM_BOT_TOKEN or TELEGRAM_CRON_CHAT_ID not set' };

  try {
    const chunks = chunkText(output, 3800);
    for (const chunk of chunks) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `*[cron/${jobName}]*\n\`\`\`\n${chunk}\n\`\`\``,
          parse_mode: 'Markdown',
        }),
        signal: AbortSignal.timeout(10_000),
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function deliverSlack(jobName: string, output: string): Promise<DeliveryResult> {
  const webhookUrl = process.env['SLACK_CRON_WEBHOOK_URL'];
  if (!webhookUrl) return { ok: false, error: 'SLACK_CRON_WEBHOOK_URL not set' };

  try {
    const chunks = chunkText(output, 2900);
    for (const chunk of chunks) {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `*[cron/${jobName}]*\n\`\`\`${chunk}\`\`\``,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function deliverEmail(jobName: string, output: string): Promise<DeliveryResult> {
  // Email delivery requires nodemailer — log a placeholder until Phase 3 wires it up
  return { ok: false, error: 'Email delivery not yet configured. Set up gateway/email in Phase 3.' };
}

function chunkText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks.length > 0 ? chunks : ['(empty output)'];
}
