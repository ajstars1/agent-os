// The masking layer around everything an assistant reads and writes.
//   out: contact details in a tool result become stand-ins ([EMAIL_12], [PHONE_3])
//   in:  stand-ins in a tool's input become the real values again, on the server, just before use
// Effects are passed in, so the rules are tested without a database.
import { channelEnv } from './env'
import { maskLookup, resolveHandles, type MaskResult, type Resolved } from './mask-db'
import { rewrite, scan, scanHandles, unmask, type MaskMap, type Real } from './mask'

export interface PrivacyDeps {
  lookup: (emails: string[], phones: string[], source: 'api' | 'own') => Promise<MaskResult>
  resolve: (emails: number[], phones: number[]) => Promise<Resolved>
}

// At most this many distinct values get a stand-in per result; the rest become a bare [EMAIL] / [PHONE].
const MAX_VALUES = 2000

const toMap = (r: MaskResult): MaskMap => ({ email: new Map(Object.entries(r.email)), phone: new Map(Object.entries(r.phone)) })

// source 'api' = the value came from a connected service: everything is masked, and a failure here must stop the
// result from going out (the caller lets the error through). source 'own' = the person's own aos data: only values
// that already have a stand-in are masked, unless the person chose to mask everything.
export const maskValue = async (d: PrivacyDeps, value: unknown, source: 'api' | 'own'): Promise<unknown> => {
  const found = scan(value)
  if (!found.emails.size && !found.phones.size) return value
  const result = await d.lookup([...found.emails].slice(0, MAX_VALUES), [...found.phones].slice(0, MAX_VALUES), source)
  if (result.level === 'off') return value
  return rewrite(value, toMap(result), source === 'api' || result.level === 'all')
}

const toReal = (r: Resolved): Real => ({
  email: new Map(Object.entries(r.email).map(([n, v]) => [Number(n), v])),
  phone: new Map(Object.entries(r.phone).map(([n, v]) => [Number(n), v])),
})

// Puts real values back into a tool's input. Arguments named in urlArgs go into a URL, so their values are encoded.
export const unmaskArgs = async <A>(d: PrivacyDeps, args: A, urlArgs: string[] = []): Promise<A> => {
  const refs = scanHandles(args)
  if (!refs.emails.size && !refs.phones.size) return args
  const real = toReal(await d.resolve([...refs.emails], [...refs.phones]))
  if (!args || typeof args !== 'object' || Array.isArray(args)) return unmask(args, real) as A
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => [k, urlArgs.includes(k) ? unmask(v, real, encodeURIComponent) : unmask(v, real)]),
  ) as A
}

// Null when the server has no secret key: masking is then off as a whole, and so are saved API keys.
export const privacyFor = (userId: string | null): PrivacyDeps | null =>
  userId && channelEnv().secretKey
    ? {
        lookup: (emails, phones, source) => maskLookup(userId, emails, phones, source),
        resolve: (emails, phones) => resolveHandles(userId, emails, phones),
      }
    : null
