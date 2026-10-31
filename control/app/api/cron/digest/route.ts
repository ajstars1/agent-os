import { NextRequest, NextResponse } from 'next/server'
import { notify } from '../../../../lib/discord'
import { agenda, formatAgenda } from '../../../../lib/tasks'

// Vercel Cron calls this daily (vercel.json) with Authorization: Bearer $CRON_SECRET.
export const GET = async (req: NextRequest) => {
  try {
    if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const text = formatAgenda(await agenda(2))
    const sent = await notify(`**Good morning. Today's plan**\n${text}`)
    return NextResponse.json({ success: true, sent })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
