import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

// Keeps the sign-in session fresh on the pages that need it. Never runs on /api/* or /.well-known/*, so MCP
// traffic pays nothing extra.
export const middleware = async (req: NextRequest) => {
  let res = NextResponse.next({ request: req })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) return res
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) req.cookies.set(name, value)
        res = NextResponse.next({ request: req })
        for (const { name, value, options } of list) res.cookies.set(name, value, options)
      },
    },
  })
  // refreshes an expired access token and writes the new cookies onto the response
  await supabase.auth.getClaims()
  return res
}

export const config = { matcher: ['/app/:path*', '/oauth/:path*', '/login'] }
