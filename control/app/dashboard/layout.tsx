import type { ReactNode } from 'react'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SESSION_COOKIE, verifySession } from '../../lib/auth'
import { TabBar } from './_ui/tab-bar'

// Middleware guards /dashboard too; this second check keeps data from rendering without a session.
const DashboardLayout = async ({ children }: { children: ReactNode }) => {
  const jar = await cookies()
  if (!(await verifySession(jar.get(SESSION_COOKIE)?.value))) redirect('/login')
  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-4 md:pt-14 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-16">
      {children}
      <TabBar />
    </div>
  )
}

export default DashboardLayout
