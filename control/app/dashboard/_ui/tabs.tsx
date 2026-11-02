'use client'

import { useState, type ReactNode } from 'react'

export interface TabPanel {
  key: string
  label: string
  count?: number
  content: ReactNode
}

// Panels are rendered on the server once; switching tabs only toggles visibility in the browser.
export const Tabs = ({ panels, initial, sticky = true }: { panels: TabPanel[]; initial?: string; sticky?: boolean }) => {
  const [active, setActive] = useState(initial && panels.some((p) => p.key === initial) ? initial : (panels[0]?.key ?? ''))
  return (
    <div>
      <div role="tablist" className={`no-scrollbar -mx-4 flex gap-1 overflow-x-auto border-b border-line bg-ground/95 px-4 backdrop-blur ${sticky ? 'sticky top-0 z-20 md:top-12' : ''}`}>
        {panels.map((p) => {
          const on = p.key === active
          return (
            <button
              key={p.key}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={`panel-${p.key}`}
              onClick={() => setActive(p.key)}
              className={`-mb-px shrink-0 border-b-2 px-3 py-3 text-sm font-medium whitespace-nowrap ${
                on ? 'border-ink text-ink' : 'border-transparent text-faint'
              }`}
            >
              {p.label}
              {p.count !== undefined ? <span className="ml-1.5 font-normal opacity-70 tabular-nums">{p.count}</span> : null}
            </button>
          )
        })}
      </div>
      {panels.map((p) => (
        <div key={p.key} id={`panel-${p.key}`} role="tabpanel" hidden={p.key !== active} className="pt-2">
          {p.content}
        </div>
      ))}
    </div>
  )
}
