/**
 * Skill Security Scanner — scans .md skill files for dangerous patterns
 * before install or on startup.
 *
 * Verdicts:
 *   safe      — no issues found, install proceeds
 *   warning   — suspicious patterns, user is warned but install continues
 *   dangerous — high-confidence malicious pattern, install blocked (non-overridable)
 */

export type GuardVerdict = 'safe' | 'warning' | 'dangerous';
export type IssueSeverity = 'warning' | 'dangerous';

export interface GuardIssue {
  type: string;
  description: string;
  severity: IssueSeverity;
  match?: string;
}

export interface GuardResult {
  verdict: GuardVerdict;
  issues: GuardIssue[];
}

// ─── Pattern banks ────────────────────────────────────────────────────────────

const DANGEROUS_PATTERNS: Array<{ type: string; re: RegExp; description: string }> = [
  // Prompt injection
  {
    type: 'prompt_injection',
    re: /ignore\s+(all\s+)?(previous|prior|earlier|above)\s+instructions?/i,
    description: 'Attempts to override system instructions',
  },
  {
    type: 'prompt_injection',
    re: /disregard\s+(your|all)\s+(previous|prior|system|safety|training)/i,
    description: 'Attempts to disregard training or safety instructions',
  },
  {
    type: 'prompt_injection',
    re: /forget\s+(everything|all)\s+(you|I|we)\s+(know|said|told)/i,
    description: 'Attempts to reset agent context',
  },
  {
    type: 'prompt_injection',
    re: /\bDAN\b.*\bjailbreak\b|\bjailbreak\b.*\bDAN\b/i,
    description: 'Jailbreak attempt detected',
  },
  // Data exfiltration
  {
    type: 'exfiltration',
    re: /curl\s+[^|]*\|\s*bash|wget\s+[^|]*\|\s*bash/i,
    description: 'Remote code execution via curl/wget pipe',
  },
  {
    type: 'exfiltration',
    re: /base64\s+-d\s*\|\s*(?:bash|sh|python|node)/i,
    description: 'Executes base64-decoded payload',
  },
  {
    type: 'exfiltration',
    re: /(?:nc|netcat)\s+[\w.-]+\s+\d+/,
    description: 'Netcat data exfiltration',
  },
  {
    type: 'exfiltration',
    re: /\$\{?(?:HOME|USER|PATH|ANTHROPIC|OPENAI|AWS_|SECRET|TOKEN|API_KEY)[^}]*\}?\s*(?:>>?|curl|wget)/i,
    description: 'Sends environment secrets to external destination',
  },
  // Destructive commands
  {
    type: 'destructive',
    re: /rm\s+-rf?\s+\/(?:\s|$|[^/])/,
    description: 'Destructive recursive delete of root or home',
  },
  {
    type: 'destructive',
    re: /DROP\s+(?:TABLE|DATABASE|SCHEMA)\s+/i,
    description: 'Destructive SQL statement',
  },
  {
    type: 'destructive',
    re: /\bdd\s+if=\//,
    description: 'Low-level disk write — potential data destruction',
  },
  {
    type: 'destructive',
    re: /mkfs\s+/,
    description: 'Filesystem creation — potential data destruction',
  },
  // Invisible/obfuscation — zero-width, BOM, directional overrides
  {
    type: 'invisible_unicode',
    re: new RegExp('[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\u00ad]'),
    description: 'Invisible or directional unicode — used to hide instructions',
  },
];

const WARNING_PATTERNS: Array<{ type: string; re: RegExp; description: string }> = [
  {
    type: 'code_injection',
    re: /\beval\s*\(|exec\s*\(|__import__\s*\(/,
    description: 'Dynamic code evaluation',
  },
  {
    type: 'network',
    re: /curl\s+https?:\/\/|wget\s+https?:\/\//,
    description: 'Makes outbound network requests',
  },
  {
    type: 'secret_access',
    re: /process\.env\s*\[|os\.environ/,
    description: 'Accesses environment variables',
  },
  {
    type: 'filesystem',
    re: /rm\s+-rf?\s+~/,
    description: 'Recursive delete in home directory',
  },
  {
    type: 'sudo',
    re: /\bsudo\b/,
    description: 'Uses elevated privileges',
  },
  {
    type: 'hidden_url',
    re: /https?:\/\/(?!github\.com|api\.github\.com|anthropic\.com|google\.com|openai\.com)\S{40,}/,
    description: 'References long/obfuscated external URL',
  },
];

// ─── Scanner ──────────────────────────────────────────────────────────────────

export function scanSkill(content: string, name: string): GuardResult {
  const issues: GuardIssue[] = [];

  // Strip frontmatter for content scanning (keep it for metadata checks)
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');

  for (const { type, re, description } of DANGEROUS_PATTERNS) {
    const match = re.exec(body);
    if (match) {
      issues.push({
        type,
        description,
        severity: 'dangerous',
        match: match[0].slice(0, 60),
      });
    }
  }

  for (const { type, re, description } of WARNING_PATTERNS) {
    const match = re.exec(body);
    if (match) {
      issues.push({
        type,
        description,
        severity: 'warning',
        match: match[0].slice(0, 60),
      });
    }
  }

  const hasDangerous = issues.some((i) => i.severity === 'dangerous');
  const verdict: GuardVerdict = hasDangerous ? 'dangerous' : issues.length > 0 ? 'warning' : 'safe';

  return { verdict, issues };
}

/** Format a GuardResult into a human-readable string for CLI output. */
export function formatGuardResult(result: GuardResult, skillName: string): string {
  if (result.verdict === 'safe') return `✓ ${skillName}: safe`;

  const icon = result.verdict === 'dangerous' ? '✗' : '⚠';
  const lines = [`${icon} ${skillName}: ${result.verdict}`];

  for (const issue of result.issues) {
    const prefix = issue.severity === 'dangerous' ? '  [DANGEROUS]' : '  [warning] ';
    lines.push(`${prefix} ${issue.type}: ${issue.description}`);
    if (issue.match) lines.push(`             matched: "${issue.match}"`);
  }

  return lines.join('\n');
}
