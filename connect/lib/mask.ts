// Masking of contact details: pure text and JSON work, no database. An email address or phone number becomes a
// stand-in such as [EMAIL_12]; the same stand-in always means the same value for one person, so an assistant can
// still follow who is who without seeing the value. lib/privacy.ts adds the database lookups.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
// "+91 98765 43210", "+1 (415) 555-2671", or a bare Indian mobile number. Not part of a longer word, id or address.
const PHONE = /(?<![\w@.+-])(?:\+\d[\d\s().-]{6,18}\d|[6-9]\d{9})(?![\w@-])/g
// field names whose value is a phone number even when it does not look like one in free text
const PHONE_KEY = /phone|mobile|msisdn|whatsapp|contact_?(?:no|num|number)|^tel(?:ephone)?$/i
const HANDLE = /\[(EMAIL|PHONE)_(\d{1,9})\]/g

export interface Found {
  emails: Set<string>
  phones: Set<string>
}

export interface MaskMap {
  email: Map<string, number>
  phone: Map<string, number>
}

export const emptyFound = (): Found => ({ emails: new Set(), phones: new Set() })

const normEmail = (s: string): string => s.toLowerCase()

// Digits with a leading + kept; null when it is not a plausible phone number.
export const normPhone = (s: string): string | null => {
  const digits = s.replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) return null
  return s.trim().startsWith('+') ? `+${digits}` : digits
}

const emailOut = (raw: string, map: MaskMap, strict: boolean): string => {
  const n = map.email.get(normEmail(raw))
  return n !== undefined ? `[EMAIL_${n}]` : strict ? '[EMAIL]' : raw
}

const phoneOut = (raw: string, map: MaskMap, strict: boolean): string => {
  const norm = normPhone(raw)
  if (!norm) return raw
  const n = map.phone.get(norm)
  return n !== undefined ? `[PHONE_${n}]` : strict ? '[PHONE]' : raw
}

export const scanText = (text: string, found: Found): void => {
  for (const m of text.match(EMAIL) ?? []) found.emails.add(normEmail(m))
  for (const m of text.replace(EMAIL, ' ').match(PHONE) ?? []) {
    const norm = normPhone(m)
    if (norm) found.phones.add(norm)
  }
}

// strict = a value with no stand-in becomes a bare [EMAIL] / [PHONE] instead of staying readable.
export const maskText = (text: string, map: MaskMap, strict: boolean): string =>
  text.replace(EMAIL, (m) => emailOut(m, map, strict)).replace(PHONE, (m) => phoneOut(m, map, strict))

const phoneField = (key: string | undefined, value: unknown): string | null => {
  if (!key || !PHONE_KEY.test(key)) return null
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value)
  return /^[\d\s()+.-]+$/.test(text) && normPhone(text) ? text : null
}

// Every email and phone number inside a JSON-like value. Bare numbers are left alone unless their field name says phone.
export const scan = (value: unknown, found: Found = emptyFound(), key?: string): Found => {
  const asPhone = phoneField(key, value)
  if (asPhone) {
    const norm = normPhone(asPhone)
    if (norm) found.phones.add(norm)
  } else if (typeof value === 'string') scanText(value, found)
  else if (Array.isArray(value)) for (const v of value) scan(v, found, key)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      scanText(k, found)
      scan(v, found, k)
    }
  }
  return found
}

export const rewrite = (value: unknown, map: MaskMap, strict: boolean, key?: string): unknown => {
  const asPhone = phoneField(key, value)
  if (asPhone) return phoneOut(asPhone, map, strict)
  if (typeof value === 'string') return maskText(value, map, strict)
  if (Array.isArray(value)) return value.map((v) => rewrite(v, map, strict, key))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [maskText(k, map, strict), rewrite(v, map, strict, k)]))
  }
  return value
}

// ---- the way back: stand-ins to real values ---------------------------------------------------------------

export interface HandleRefs {
  emails: Set<number>
  phones: Set<number>
}

export interface Real {
  email: Map<number, string>
  phone: Map<number, string>
}

export const scanHandles = (value: unknown, refs: HandleRefs = { emails: new Set(), phones: new Set() }): HandleRefs => {
  if (typeof value === 'string') {
    for (const m of value.matchAll(HANDLE)) (m[1] === 'EMAIL' ? refs.emails : refs.phones).add(Number(m[2]))
  } else if (Array.isArray(value)) for (const v of value) scanHandles(v, refs)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) scanHandles(v, refs)
  return refs
}

// An unknown stand-in is left as written. encode is for values placed inside a URL.
export const unmask = (value: unknown, real: Real, encode: (s: string) => string = (s) => s): unknown => {
  if (typeof value === 'string') {
    return value.replace(HANDLE, (whole, kind: string, n: string) => {
      const v = (kind === 'EMAIL' ? real.email : real.phone).get(Number(n))
      return v === undefined ? whole : encode(v)
    })
  }
  if (Array.isArray(value)) return value.map((v) => unmask(v, real, encode))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unmask(v, real, encode)]))
  return value
}

// ---- keeping only the fields asked for --------------------------------------------------------------------

// pick(data, ['items.id', 'items.amount']) keeps those paths; lists are walked through. Fewer fields, fewer tokens.
export const pick = (data: unknown, fields: string[]): unknown => {
  interface Node {
    [key: string]: Node | true
  }
  const tree: Node = {}
  for (const f of fields) {
    let node = tree
    const parts = f.split('.').filter(Boolean)
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const at = node[part]
      if (at === true) break // a shorter path already keeps everything below
      if (i === parts.length - 1) node[part] = true
      else node = at ?? (node[part] = {})
    }
  }
  const walk = (value: unknown, node: Node): unknown => {
    if (Array.isArray(value)) return value.map((v) => walk(v, node))
    if (!value || typeof value !== 'object') return undefined
    const out: Record<string, unknown> = {}
    for (const [k, sub] of Object.entries(node)) {
      const v = (value as Record<string, unknown>)[k]
      if (v === undefined) continue
      const kept = sub === true ? v : walk(v, sub)
      if (kept !== undefined) out[k] = kept
    }
    return out
  }
  return walk(data, tree)
}
