'use client'

import { useActionState, useEffect, useState } from 'react'
import { decideDraft, type DecideResult } from './decide-action'

type Armed = 'approved' | 'rejected' | null

// Two taps per decision: the first arms the button and says what will happen, the second submits.
// Approving queues a real send, so a stray tap never does it on its own.
export const DraftDecision = ({ id, target }: { id: number; target: string }) => {
  const [state, action, pending] = useActionState<DecideResult | null, FormData>(decideDraft, null)
  const [armed, setArmed] = useState<Armed>(null)

  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(null), 5000)
    return () => window.clearTimeout(t)
  }, [armed])

  if (state?.ok) {
    return (
      <p role="status" className="mt-4 rounded-lg bg-lift px-3 py-2.5 text-sm text-ink">
        {state.message}
      </p>
    )
  }

  const button = (decision: Exclude<Armed, null>, label: string, armedLabel: string, tone: string) => {
    const isArmed = armed === decision
    return (
      <button
        type={isArmed ? 'submit' : 'button'}
        disabled={pending}
        onClick={isArmed ? undefined : () => setArmed(decision)}
        className={`min-h-11 flex-1 rounded-lg px-3 py-2.5 text-[15px] font-semibold transition-colors disabled:opacity-50 ${
          isArmed ? tone : 'border border-line text-ink active:bg-lift'
        }`}
      >
        {pending && isArmed ? 'Saving…' : isArmed ? armedLabel : label}
      </button>
    )
  }

  return (
    <form action={action} className="mt-4">
      <input type="hidden" name="id" value={id} />
      {/* The decision travels in a field set by the armed button, not via the submitter, so it is always present. */}
      <input type="hidden" name="decision" value={armed ?? ''} />
      <div className="flex gap-2">
        {button('approved', 'Approve', 'Tap again to send', 'bg-good text-ground')}
        {button('rejected', 'Reject', 'Tap again to reject', 'bg-late text-ground')}
      </div>
      <p className="mt-2 text-xs text-faint" aria-live="polite">
        {armed === 'approved'
          ? `aos will send this exact text via ${target}.`
          : armed === 'rejected'
            ? 'The draft is dropped and nothing is sent.'
            : 'You can also answer with yes or no on the Discord card.'}
      </p>
      {state && !state.ok ? (
        <p role="alert" className="mt-2 text-sm text-late">
          {state.message}
        </p>
      ) : null}
    </form>
  )
}
