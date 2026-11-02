'use client'

import { useMemo, useState } from 'react'
import type { ActivityRow } from '../../../lib/dash'
import { ventureMeta } from '../../../lib/ventures'
import { VentureDot } from './bits'
import { ActivityItem } from './rows'

// Same grouping as lib/dash channelGroup; duplicated here to keep server-only code out of the bundle.
const group = (channel: string): string => {
  const c = channel.toLowerCase()
  if (c.startsWith('linkedin')) return 'LinkedIn'
  if (c === 'gmail' || c === 'email' || c === 'zoho') return 'Email'
  if (c === 'whatsapp') return 'WhatsApp'
  if (c === 'reddit') return 'Reddit'
  if (c === 'internal') return 'Internal'
  return 'Other'
}

export const ActivityBrowser = ({ items, now }: { items: ActivityRow[]; now: string }) => {
  const [venture, setVenture] = useState('')
  const [channel, setChannel] = useState('')
  const ventures = useMemo(() => [...new Set(items.map((a) => a.venture))], [items])
  const channels = useMemo(() => [...new Set(items.map((a) => group(a.channel)))], [items])
  const shown = items.filter((a) => (!venture || a.venture === venture) && (!channel || group(a.channel) === channel))
  const chip = (on: boolean): string =>
    `inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium whitespace-nowrap ${
      on ? 'border-ink bg-ink text-ground' : 'border-line text-dim'
    }`
  return (
    <div>
      <div className="no-scrollbar -mx-4 mt-2 flex gap-2 overflow-x-auto px-4 py-1">
        <button type="button" className={chip(!venture)} aria-pressed={!venture} onClick={() => setVenture('')}>
          All ventures
        </button>
        {ventures.map((v) => (
          <button key={v} type="button" className={chip(venture === v)} aria-pressed={venture === v} onClick={() => setVenture(venture === v ? '' : v)}>
            <VentureDot venture={v} />
            {ventureMeta(v).name}
          </button>
        ))}
      </div>
      <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 py-1">
        <button type="button" className={chip(!channel)} aria-pressed={!channel} onClick={() => setChannel('')}>
          All channels
        </button>
        {channels.map((c) => (
          <button key={c} type="button" className={chip(channel === c)} aria-pressed={channel === c} onClick={() => setChannel(channel === c ? '' : c)}>
            {c}
          </button>
        ))}
      </div>
      <p className="mt-2 text-sm text-faint">{shown.length} entries</p>
      <ul className="divide-y divide-line">
        {shown.map((a) => (
          <ActivityItem key={a.id} a={a} now={now} />
        ))}
      </ul>
    </div>
  )
}
