'use client'

import { useState } from 'react'

// A line of text with a Copy button (the connector link).
export const CopyLine = ({ text, label }: { text: string; label: string }) => {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-ground p-2">
      <code className="min-w-0 flex-1 truncate px-1 text-sm" title={text}>
        {text}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={label}
        className="shrink-0 rounded-md bg-lift px-3 py-1.5 text-sm font-medium active:opacity-80"
      >
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  )
}
