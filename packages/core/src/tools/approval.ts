/** Dangerous shell command detection with per-session approval state. */

interface DangerousPattern {
  regex: RegExp;
  description: string;
}

export const DANGEROUS_PATTERNS: DangerousPattern[] = [
  { regex: /rm\s+(-[a-z]*f[a-z]*r[a-z]*|-[a-z]*r[a-z]*f[a-z]*|--force|--recursive)\s*\/\s*/i, description: 'recursive force delete from root' },
  { regex: /rm\s+-rf?\s+~\//, description: 'recursive delete from home directory' },
  { regex: /:\(\){.*\|.*:.*};:/, description: 'fork bomb' },
  { regex: />\s*\/dev\/sda/, description: 'overwrite disk device' },
  { regex: /dd\s+.*of=\/dev\/(sd|hd|nvme|disk)/, description: 'dd to disk device' },
  { regex: /mkfs\s+.*\/dev\//, description: 'format disk device' },
  { regex: /DROP\s+(TABLE|DATABASE|SCHEMA)\s/i, description: 'SQL drop statement' },
  { regex: /TRUNCATE\s+TABLE\s/i, description: 'SQL truncate statement' },
  { regex: /git\s+(push\s+--force|push\s+-f)\s/, description: 'git force push' },
  { regex: /git\s+reset\s+--hard/, description: 'git hard reset' },
  { regex: /chmod\s+(-R\s+)?777\s+\//, description: 'world-writable permissions on root path' },
  { regex: /curl\s+.*\|\s*(bash|sh|zsh|fish)/, description: 'curl pipe to shell' },
  { regex: /wget\s+.*-O\s*-\s*\|/, description: 'wget pipe output' },
  { regex: /eval\s*\$\(curl/, description: 'eval curl output' },
  { regex: /shutdown\s+(-[a-z]*h|-r)\s+(now|\d)/i, description: 'system shutdown or reboot' },
  { regex: /reboot(\s|$)/i, description: 'system reboot' },
  { regex: /pkill\s+-9\s+-(1|KILL)\s+1/, description: 'kill init process' },
  { regex: />\s*\/etc\/(passwd|shadow|sudoers)/, description: 'overwrite system auth files' },
  { regex: /crontab\s+-r/, description: 'remove all crontabs' },
];

/** Returns the description of the first matched dangerous pattern, or null if safe. */
export function detectDangerousCommand(cmd: string): string | null {
  for (const { regex, description } of DANGEROUS_PATTERNS) {
    if (regex.test(cmd)) return description;
  }
  return null;
}

/** Per-session approval state. Tracks which pattern descriptions have been approved. */
export class DangerousCommandApproval {
  private readonly approved = new Map<string, Set<string>>();

  isApproved(sessionId: string, description: string): boolean {
    return this.approved.get(sessionId)?.has(description) ?? false;
  }

  approve(sessionId: string, description: string): void {
    if (!this.approved.has(sessionId)) this.approved.set(sessionId, new Set());
    this.approved.get(sessionId)!.add(description);
  }

  clearSession(sessionId: string): void {
    this.approved.delete(sessionId);
  }
}

export const globalApproval = new DangerousCommandApproval();
