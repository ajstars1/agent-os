import { NextResponse } from 'next/server'
import { sessionClient, siteOrigin } from '../../../lib/supabase-server'

// POST only, so a link or an image tag cannot sign someone out. Ends this browser's session only: apps the person
// connected keep working until they disconnect them on the dashboard.
export const POST = async (): Promise<NextResponse> => {
  const origin = await siteOrigin()
  try {
    const sb = await sessionClient()
    await sb.auth.signOut({ scope: 'local' })
  } catch {
    // signing out a missing or broken session is still "signed out"
  }
  return NextResponse.redirect(`${origin}/`, { status: 303 })
}
