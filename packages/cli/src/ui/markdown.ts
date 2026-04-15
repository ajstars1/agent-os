/**
 * Minimal markdown → ANSI renderer for terminal output.
 * Handles the most common patterns; leaves everything else as-is.
 */

const E = '\x1b';
const reset  = `${E}[0m`;
const bold   = (s: string) => `${E}[1m${s}${reset}`;
const dim    = (s: string) => `${E}[2m${s}${reset}`;
const italic = (s: string) => `${E}[3m${s}${reset}`;
const cyan   = (s: string) => `${E}[36m${s}${reset}`;
const yellow = (s: string) => `${E}[33m${s}${reset}`;

/** Apply inline formatting to a single string (bold, italic, code). */
function inlineFormat(text: string): string {
  return text
    // **bold** or __bold__
    .replace(/\*\*(.+?)\*\*/g, (_, t) => bold(t))
    .replace(/__(.+?)__/g, (_, t) => bold(t))
    // *italic* or _italic_ (single, not at word boundaries to avoid false matches)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, t) => italic(t))
    .replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, (_, t) => italic(t))
    // `inline code`
    .replace(/`([^`]+)`/g, (_, t) => cyan(t));
}

/** Render a markdown string to ANSI-coloured terminal text. */
export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines: string[] = [];

  for (const raw of lines) {
    // ── Fenced code blocks ────────────────────────────────────────────────────
    if (raw.startsWith('```')) {
      if (inCodeBlock) {
        // End of code block
        if (codeLang) out.push(dim(`╭─ ${codeLang} `) + dim('─'.repeat(40)));
        else out.push(dim('╭') + dim('─'.repeat(45)));
        
        for (const cl of codeLines) {
          out.push(`${dim('│')} ${cl}`);
        }
        out.push(dim('╰') + dim('─'.repeat(45)));
        codeLines = [];
        inCodeBlock = false;
        codeLang = '';
      } else {
        inCodeBlock = true;
        codeLang = raw.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(raw);
      continue;
    }

    // ── Headings ──────────────────────────────────────────────────────────────
    const h3 = raw.match(/^###\s+(.*)/);
    const h2 = raw.match(/^##\s+(.*)/);
    const h1 = raw.match(/^#\s+(.*)/);
    if (h1) { out.push('\n' + bold(yellow(h1[1] ?? '')) + '\n'); continue; }
    if (h2) { out.push('\n' + bold(cyan(h2[1] ?? '')) + '\n'); continue; }
    if (h3) { out.push(bold(h3[1] ?? '')); continue; }

    // ── Horizontal rule ───────────────────────────────────────────────────────
    if (/^[-*_]{3,}$/.test(raw.trim())) {
      out.push(dim('─'.repeat(52)));
      continue;
    }

    // ── Bullet lists (*, -, •) ────────────────────────────────────────────────
    const bullet = raw.match(/^(\s*)[-*•]\s+(.*)/);
    if (bullet) {
      const indent = '  '.repeat(Math.floor((bullet[1]?.length ?? 0) / 2));
      out.push(`${indent}  ${cyan('•')} ${inlineFormat(bullet[2] ?? '')}`);
      continue;
    }

    // ── Numbered lists ────────────────────────────────────────────────────────
    const numbered = raw.match(/^(\s*)\d+\.\s+(.*)/);
    if (numbered) {
      const indent = '  '.repeat(Math.floor((numbered[1]?.length ?? 0) / 2));
      const num = raw.match(/\d+/)?.[0] ?? '1';
      out.push(`${indent}  ${cyan(num + '.')} ${inlineFormat(numbered[2] ?? '')}`);
      continue;
    }

    // ── Blockquote ────────────────────────────────────────────────────────────
    const bq = raw.match(/^>\s*(.*)/);
    if (bq) {
      out.push(`  ${dim('│')} ${dim(inlineFormat(bq[1] ?? ''))}`);
      continue;
    }

    // ── Plain text (inline formatting only) ──────────────────────────────────
    out.push(inlineFormat(raw));
  }

  // Flush unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    if (codeLang) out.push(dim(`╭─ ${codeLang} `) + dim('─'.repeat(40)));
    else out.push(dim('╭') + dim('─'.repeat(45)));
    
    for (const cl of codeLines) out.push(`${dim('│')} ${cl}`);
    out.push(dim('╰') + dim('─'.repeat(45)));
  }

  return out.join('\n');
}
