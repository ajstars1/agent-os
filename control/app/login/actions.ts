'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { SESSION_COOKIE, SESSION_TTL_S, checkPasscode, createSession, isDashboardConfigured } from '../../lib/auth'

// Best-effort brute-force brake: per-instance counter per IP plus a fixed delay on every miss.
const WINDOW_MS = 15 * 60 * 1000
const MAX_FAILS = 5
const fails = new Map<string, { n: number; first: number }>()

const clientIp = async (): Promise<string> => {
  const h = await headers()
  return h.get('x-real-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

const isLocked = (ip: string, now: number): boolean => {
  const f = fails.get(ip)
  if (!f) return false
  if (now - f.first > WINDOW_MS) {
    fails.delete(ip)
    return false
  }
  return f.n >= MAX_FAILS
}

const recordFail = (ip: string, now: number): void => {
  const f = fails.get(ip)
  if (!f || now - f.first > WINDOW_MS) fails.set(ip, { n: 1, first: now })
  else f.n += 1
  if (fails.size > 1000) fails.clear()
}

export const login = async (formData: FormData): Promise<never> => {
  if (!isDashboardConfigured()) redirect('/login?e=setup')
  const raw = formData.get('passcode')
  const input = typeof raw === 'string' ? raw.slice(0, 200) : ''
  const ip = await clientIp()
  const now = Date.now()
  if (isLocked(ip, now)) redirect('/login?e=locked')

  let ok = false
  try {
    ok = input.length > 0 && (await checkPasscode(input))
  } catch {
    ok = false
  }
  if (!ok) {
    recordFail(ip, now)
    await new Promise((r) => setTimeout(r, 600))
    redirect('/login?e=bad')
  }

  fails.delete(ip)
  const jar = await cookies()
  jar.set(SESSION_COOKIE, await createSession(now), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_S,
  })
  redirect('/dashboard')
}

export const logout = async (): Promise<never> => {
  const jar = await cookies()
  jar.delete(SESSION_COOKIE)
  redirect('/login')
}
