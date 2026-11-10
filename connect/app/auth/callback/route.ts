import { NextResponse, type NextRequest } from 'next/server'
import { safeNext } from '../../../lib/redirect'
import { sessionClient, siteOrigin } from '../../../lib/supabase-server'

// Google sends the person back here with a one-time code; we swap it for a session cookie.
export const GET = async (req: NextRequest): Promise<NextResponse> => {
  const origin = await siteOrigin()
  const next = safeNext(req.nextUrl.searchParams.get('next'))
  const code = req.nextUrl.searchParams.get('code')
  const failed = NextResponse.redirect(`${origin}/login?e=callback&next=${encodeURIComponent(next)}`)
  if (!code || code.length > 512) return failed
  try {
    const sb = await sessionClient()
    const { error } = await sb.auth.exchangeCodeForSession(code)
    if (error) return failed
    return NextResponse.redirect(`${origin}${next}`)
  } catch {
    return failed
  }
}
