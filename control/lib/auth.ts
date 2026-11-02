// Dashboard session: an httpOnly cookie holding "<expiry ms>.<HMAC-SHA256 hex>".
// The HMAC key is derived from AOS_DASHBOARD_PASSCODE, so changing the passcode signs everyone out.
// Web Crypto only, so the same code runs in middleware (edge) and in server components / actions (node).

export const SESSION_COOKIE = 'aos_dash'
export const SESSION_TTL_S = 30 * 24 * 3600

const enc = new TextEncoder()

const hex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')

const passcode = (): string | null => {
  const p = process.env.AOS_DASHBOARD_PASSCODE
  return p && p.length >= 8 ? p : null
}

const hmac = async (secret: string, msg: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(`aos-dashboard-session:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))
}

// Constant-time for equal lengths; length itself is not secret here (fixed-size digests).
const safeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export const isDashboardConfigured = (): boolean => passcode() !== null

// Compares digests rather than raw strings so timing does not leak the passcode length.
export const checkPasscode = async (input: string): Promise<boolean> => {
  const p = passcode()
  if (!p) return false
  const [a, b] = await Promise.all([hmac(p, `pc:${input}`), hmac(p, `pc:${p}`)])
  return safeEqual(a, b)
}

// Keyed hash of the client IP for the login brake, so raw IPs never reach the database.
export const hashIp = async (ip: string): Promise<string> => {
  const p = passcode()
  if (!p) throw new Error('AOS_DASHBOARD_PASSCODE is not set')
  return hmac(p, `ip:${ip}`)
}

export const createSession = async (now: number = Date.now()): Promise<string> => {
  const p = passcode()
  if (!p) throw new Error('AOS_DASHBOARD_PASSCODE is not set')
  const exp = now + SESSION_TTL_S * 1000
  return `${exp}.${await hmac(p, `session:${exp}`)}`
}

export const verifySession = async (value: string | undefined, now: number = Date.now()): Promise<boolean> => {
  const p = passcode()
  if (!p || !value) return false
  const [expStr, sig] = value.split('.')
  const exp = Number(expStr)
  if (!sig || !Number.isFinite(exp) || exp < now) return false
  return safeEqual(sig, await hmac(p, `session:${exp}`))
}
