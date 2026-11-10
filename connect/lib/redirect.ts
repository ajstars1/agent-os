// Where to send someone after sign-in. Only paths on this site are allowed, so a crafted link
// (?next=https://evil.example) cannot bounce a freshly signed-in person somewhere else.
export const DEFAULT_NEXT = '/app'

export const safeNext = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return DEFAULT_NEXT
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return DEFAULT_NEXT
  if (/[\u0000-\u001f\u007f]/.test(value)) return DEFAULT_NEXT
  try {
    const url = new URL(value, 'https://aos.invalid')
    if (url.origin !== 'https://aos.invalid') return DEFAULT_NEXT
    return `${url.pathname}${url.search}`
  } catch {
    return DEFAULT_NEXT
  }
}

// OAuth authorization ids come from Supabase Auth; accept only a plain token-like value.
export const isAuthorizationId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value)
