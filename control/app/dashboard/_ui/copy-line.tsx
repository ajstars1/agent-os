'use client'

import { useState } from 'react'

export const CopyLine = ({ text }: { text: string }) => {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    }
    window.setTimeout(() => setState('idle'), 1800)
  }
  return (
    <li className="flex items-start gap-3 py-3">
      <p className="min-w-0 flex-1 text-[15px] leading-relaxed">{text}</p>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs text-dim active:bg-raised"
        aria-live="polite"
      >
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Select it' : 'Copy'}
      </button>
    </li>
  )
}
