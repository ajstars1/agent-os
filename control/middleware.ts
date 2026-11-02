import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySession } from './lib/auth'

// Runs only on the matcher paths below, never on /api/*, so MCP and cron traffic pays nothing extra.
export const middleware = async (req: NextRequest) => {
  const authed = await verifySession(req.cookies.get(SESSION_COOKIE)?.value)
  const { pathname } = req.nextUrl
  if (pathname === '/') {
    return NextResponse.redirect(new URL(authed ? '/dashboard' : '/login', req.url))
  }
  if (pathname.startsWith('/dashboard') && !authed) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  if (pathname === '/login' && authed) {
    return NextResponse.redirect(new URL('/dashboard', req.url))
  }
  return NextResponse.next()
}

export const config = { matcher: ['/', '/login', '/dashboard/:path*'] }
