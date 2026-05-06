'use client';

import { useMemo } from 'react';

/** Lightweight markdown renderer — covers 90% of agent output. */
function renderInline(text: string): string {
  // Escape HTML
  let out = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Inline code
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // Links: [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return out;
}

interface Props { content: string }

export function Markdown({ content }: Props) {
  const html = useMemo(() => {
    const lines = content.split('\n');
    const out: string[] = [];
    let inCode = false;
    let codeBuffer: string[] = [];
    let codeLang = '';
    let listType: 'ul' | 'ol' | null = null;

    const flushList = (): void => {
      if (listType) { out.push(`</${listType}>`); listType = null; }
    };

    for (const raw of lines) {
      const line = raw;

      // Fenced code blocks
      if (line.startsWith('```')) {
        if (inCode) {
          out.push(`<pre><code class="lang-${codeLang}">${codeBuffer.map((l) => l
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          ).join('\n')}</code></pre>`);
          codeBuffer = [];
          codeLang = '';
          inCode = false;
        } else {
          flushList();
          inCode = true;
          codeLang = line.slice(3).trim();
        }
        continue;
      }
      if (inCode) { codeBuffer.push(line); continue; }

      // Headings
      if (line.startsWith('### ')) { flushList(); out.push(`<h3>${renderInline(line.slice(4))}</h3>`); continue; }
      if (line.startsWith('## '))  { flushList(); out.push(`<h2>${renderInline(line.slice(3))}</h2>`); continue; }
      if (line.startsWith('# '))   { flushList(); out.push(`<h1>${renderInline(line.slice(2))}</h1>`); continue; }

      // Blockquote
      if (line.startsWith('> ')) {
        flushList();
        out.push(`<blockquote>${renderInline(line.slice(2))}</blockquote>`);
        continue;
      }

      // Lists
      const ulMatch = /^[\-*+] (.+)$/.exec(line);
      const olMatch = /^\d+\. (.+)$/.exec(line);

      if (ulMatch) {
        if (listType !== 'ul') { flushList(); out.push('<ul>'); listType = 'ul'; }
        out.push(`<li>${renderInline(ulMatch[1] ?? '')}</li>`);
        continue;
      }
      if (olMatch) {
        if (listType !== 'ol') { flushList(); out.push('<ol>'); listType = 'ol'; }
        out.push(`<li>${renderInline(olMatch[1] ?? '')}</li>`);
        continue;
      }

      // Empty line
      if (line.trim() === '') { flushList(); out.push(''); continue; }

      // Paragraph
      flushList();
      out.push(`<p>${renderInline(line)}</p>`);
    }
    flushList();
    if (inCode && codeBuffer.length > 0) {
      out.push(`<pre><code>${codeBuffer.join('\n')}</code></pre>`);
    }

    return out.join('\n');
  }, [content]);

  return (
    <div className="prose-arc" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
