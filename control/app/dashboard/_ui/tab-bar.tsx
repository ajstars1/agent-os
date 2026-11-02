'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/dashboard', label: 'Today', icon: 'M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z' },
  { href: '/dashboard/tasks', label: 'Tasks', icon: 'M5 6h14M5 12h14M5 18h9' },
  { href: '/dashboard/v', label: 'Ventures', icon: 'M4 5h7v7H4zM13 5h7v7h-7zM4 14h7v6H4zM13 14h7v6h-7z' },
  { href: '/dashboard/story', label: 'Story', icon: 'M5 19V11M10 19V6M15 19v-9M20 19V4' },
  { href: '/dashboard/log', label: 'Log', icon: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z' },
] as const

const isActive = (path: string, href: string): boolean =>
  href === '/dashboard' ? path === '/dashboard' : path === href || path.startsWith(`${href}/`)

// Bottom bar on phones, a quiet top strip on wide screens. prefetch off: every visit is one render, on tap only.
export const TabBar = () => {
  const path = usePathname()
  return (
    <nav
      aria-label="Sections"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-ground/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:top-0 md:bottom-auto md:border-t-0 md:border-b md:pb-0"
    >
      <ul className="mx-auto flex max-w-2xl justify-between px-2 md:justify-start md:gap-1 md:px-4">
        {TABS.map((t) => {
          const active = isActive(path, t.href)
          return (
            <li key={t.href} className="flex-1 md:flex-none">
              <Link
                href={t.href}
                prefetch={false}
                aria-current={active ? 'page' : undefined}
                className={`flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium md:flex-row md:gap-2 md:px-3 md:py-3 md:text-sm ${
                  active ? 'text-ink' : 'text-faint'
                }`}
              >
                <svg viewBox="0 0 24 24" className="size-5 md:size-4" fill="none" stroke="currentColor" strokeWidth={active ? 2.2 : 1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d={t.icon} />
                </svg>
                {t.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
