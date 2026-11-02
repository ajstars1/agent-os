'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { db } from '../../lib/db'
import { SESSION_COOKIE, SESSION_TTL_S, checkPasscode, createSession, hashIp, isDashboardConfigured } from '../../lib/auth'

// Brute-force brake shared by every server instance (table login_attempts, migration 20261102120000):
// 5 failed attempts per IP in 15 minutes locks that IP out, plus a fixed delay on every miss.
const WINDOW_S = 15 * 60
const MAX_FAILS = 5

class LoginGateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoginGateError'
  }
}

const clientIp = async (): Promise<string> => {
  const h = await headers()
  return h.get('x-real-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}

const beginAttempt = async (ipHash: string): Promise<{ id: number; locked: boolean }> => {
  const { data, error } = await db().rpc('login_attempt_begin', {
    p_ip_hash: ipHash,
    p_window_s: WINDOW_S,
    p_max: MAX_FAILS,
  })
  if (error) throw new LoginGateError(error.message)
  const row = (Array.isArray(data) ? data[0] : data) as { attempt_id: number; locked: boolean } | undefined
  if (!row) throw new LoginGateError('login_attempt_begin returned nothing')
  return { id: row.attempt_id, locked: row.locked }
}

const finishAttempt = async (id: number, ok: boolean): Promise<void> => {
  const { error } = await db().rpc('login_attempt_finish', { p_attempt_id: id, p_ok: ok })
  if (error) throw new LoginGateError(error.message)
}

export const login = async (formData: FormData): Promise<never> => {
  if (!isDashboardConfigured()) redirect('/login?e=setup')
  const raw = formData.get('passcode')
  const input = typeof raw === 'string' ? raw.slice(0, 200) : ''

  // Fails closed: if the brake can't be read or written, nobody signs in.
  let ok = false
  try {
    const attempt = await beginAttempt(await hashIp(await clientIp()))
    if (attempt.locked) redirect('/login?e=locked')
    ok = input.length > 0 && (await checkPasscode(input))
    await finishAttempt(attempt.id, ok)
  } catch (err) {
    if (err instanceof LoginGateError) redirect('/login?e=unavailable')
    throw err // redirect() signals by throwing; let it through
  }

  if (!ok) {
    await new Promise((r) => setTimeout(r, 600))
    redirect('/login?e=bad')
  }

  const jar = await cookies()
  jar.set(SESSION_COOKIE, await createSession(), {
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
