import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import type { ServerContext } from '@modelcontextprotocol/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { apiRead, MAX_REPLY_CHARS, type ApiReadDeps } from '../lib/api'
import { emptyFound, maskText, normPhone, pick, rewrite, scan, scanHandles, scanText, unmask, type MaskMap } from '../lib/mask'
import type { MaskResult } from '../lib/mask-db'
import { maskValue, unmaskArgs, type PrivacyDeps } from '../lib/privacy'
import {
  authHeader,
  buildUrl,
  httpFailure,
  isHeaderName,
  isHost,
  isKeyValue,
  isPublicAddress,
  MAX_BYTES,
  parseKeyMeta,
  publicLookup,
  scrubKey,
  sealedRequest,
  type KeyMeta,
  type SealedResponse,
} from '../lib/sealed-http'
import { run } from '../lib/tools'
import { binding, seal } from '../lib/vault'

const map = (email: Record<string, number> = {}, phone: Record<string, number> = {}): MaskMap => ({
  email: new Map(Object.entries(email)),
  phone: new Map(Object.entries(phone)),
})

describe('finding contact details', () => {
  test('emails and phone numbers in text', () => {
    const f = emptyFound()
    scanText('Write to Priya.Shah@Example.com or call +91 98765 43210 / 9123456780, US +1 (415) 555-2671.', f)
    expect([...f.emails]).toEqual(['priya.shah@example.com'])
    expect([...f.phones].sort()).toEqual(['+14155552671', '+919876543210', '9123456780'])
  })

  test('ids, amounts, dates and time offsets are not phone numbers', () => {
    const f = emptyFound()
    scanText('pay_9876543210 order-9876543210 ref 12345678901234567 at 2026-11-10T10:00:00+05:30 total 98765.43 v1.9876543210', f)
    expect([...f.phones]).toEqual([])
    expect(normPhone('12345')).toBeNull()
    expect(normPhone('+91 98765 43210')).toBe('+919876543210')
  })

  test('in JSON, a bare number is a phone only when its field name says so', () => {
    const f = scan({ created_at: 9876543210, amount: 9123456780, customer: { phone: 9876543210, mobile_no: '098765 43210', email: 'a@example.com' }, list: ['b@example.com'] })
    expect([...f.emails].sort()).toEqual(['a@example.com', 'b@example.com'])
    expect([...f.phones].sort()).toEqual(['09876543210', '9876543210'])
  })
})

describe('masking and putting back', () => {
  const m = map({ 'priya@example.com': 12 }, { '+919876543210': 3, '9876543210': 4 })

  test('a known value becomes its stand-in; an unknown one stays or becomes a bare tag', () => {
    const text = 'Priya <Priya@Example.com>, +91 98765-43210, other@example.com'
    expect(maskText(text, m, false)).toBe('Priya <[EMAIL_12]>, [PHONE_3], other@example.com')
    expect(maskText(text, m, true)).toBe('Priya <[EMAIL_12]>, [PHONE_3], [EMAIL]')
  })

  test('JSON keeps its shape; keys that are addresses are masked too', () => {
    const data = { id: 7, amount: 9876543210, contact: { phone: 9876543210, email: 'priya@example.com' }, by: { 'priya@example.com': 2 }, n: null, ok: true }
    expect(rewrite(data, m, true)).toEqual({ id: 7, amount: 9876543210, contact: { phone: '[PHONE_4]', email: '[EMAIL_12]' }, by: { '[EMAIL_12]': 2 }, n: null, ok: true })
  })

  test('stand-ins are found and replaced by real values, encoded where asked', () => {
    const args = { recipient: 'Priya <[EMAIL_12]>', path: '/c?email=[EMAIL_12]&p=[PHONE_3]', nested: [{ note: 'call [PHONE_3] or [PHONE_99]' }] }
    const refs = scanHandles(args)
    expect([[...refs.emails], [...refs.phones].sort()]).toEqual([[12], [3, 99]])
    const real = { email: new Map([[12, 'priya+x@example.com']]), phone: new Map([[3, '+919876543210']]) }
    expect(unmask(args.recipient, real)).toBe('Priya <priya+x@example.com>')
    expect(unmask(args.path, real, encodeURIComponent)).toBe('/c?email=priya%2Bx%40example.com&p=%2B919876543210')
    expect(unmask(args.nested, real)).toEqual([{ note: 'call +919876543210 or [PHONE_99]' }])
  })

  test('a masked value does not match again', () => {
    const once = maskText('priya@example.com +91 98765 43210', m, true)
    expect(maskText(once, m, true)).toBe(once)
    expect(scan(once)).toEqual(emptyFound())
  })

  test('pick keeps only the asked fields, through lists', () => {
    const data = { count: 2, items: [{ id: 'a', amount: 5, notes: { x: 1, y: 2 } }, { id: 'b', amount: 7, notes: { x: 3 } }], extra: 'drop' }
    expect(pick(data, ['items.id', 'items.notes.x', 'count'])).toEqual({ count: 2, items: [{ id: 'a', notes: { x: 1 } }, { id: 'b', notes: { x: 3 } }] })
    expect(pick(data, ['items', 'items.id'])).toEqual({ items: data.items })
    expect(pick([{ id: 1, z: 2 }], ['id'])).toEqual([{ id: 1 }])
  })
})

// A stand-in for the database: gives numbers the way handles_mask does.
const fakePrivacy = (level: MaskResult['level'] = 'api', known: { email?: Record<string, number>; phone?: Record<string, number> } = {}) => {
  const email = new Map(Object.entries(known.email ?? {}))
  const phone = new Map(Object.entries(known.phone ?? {}))
  const calls: Array<{ emails: string[]; phones: string[]; source: string }> = []
  const deps: PrivacyDeps = {
    lookup: async (emails, phones, source) => {
      calls.push({ emails, phones, source })
      if (level !== 'off' && (level === 'all' || source === 'api')) {
        for (const e of emails) if (!email.has(e)) email.set(e, email.size + 1)
        for (const p of phones) if (!phone.has(p)) phone.set(p, phone.size + 1)
      }
      const only = (m: Map<string, number>, keys: string[]): Record<string, number> => Object.fromEntries([...m].filter(([k]) => keys.includes(k)))
      return { level, email: level === 'off' ? {} : only(email, emails), phone: level === 'off' ? {} : only(phone, phones) }
    },
    resolve: async (emails, phones) => ({
      email: Object.fromEntries([...email].filter(([, n]) => emails.includes(n)).map(([v, n]) => [String(n), v])),
      phone: Object.fromEntries([...phone].filter(([, n]) => phones.includes(n)).map(([v, n]) => [String(n), v])),
    }),
  }
  return { deps, calls }
}

describe('the privacy layer', () => {
  test('data from a connected service is always masked', async () => {
    const { deps } = fakePrivacy()
    const out = await maskValue(deps, { customers: [{ email: 'a@example.com', phone: '+91 98765 43210' }, { email: 'b@example.com' }] }, 'api')
    expect(out).toEqual({ customers: [{ email: '[EMAIL_1]', phone: '[PHONE_1]' }, { email: '[EMAIL_2]' }] })
  })

  test('the person\'s own data: only values that already have a stand-in are masked', async () => {
    const { deps } = fakePrivacy('api', { email: { 'a@example.com': 5 } })
    expect(await maskValue(deps, { recipient: 'a@example.com', note: 'cc mine@example.com' }, 'own')).toEqual({ recipient: '[EMAIL_5]', note: 'cc mine@example.com' })
  })

  test('"all" masks the person\'s own data too; "off" masks nothing', async () => {
    expect(await maskValue(fakePrivacy('all').deps, 'call 9876543210, mail mine@example.com', 'own')).toBe('call [PHONE_1], mail [EMAIL_1]')
    expect(await maskValue(fakePrivacy('off').deps, { email: 'a@example.com' }, 'api')).toEqual({ email: 'a@example.com' })
  })

  test('nothing to mask or resolve means no database call', async () => {
    const { deps, calls } = fakePrivacy()
    expect(await maskValue(deps, { title: 'Call the accountant', n: 3 }, 'own')).toEqual({ title: 'Call the accountant', n: 3 })
    expect(await unmaskArgs(deps, { title: 'x' })).toEqual({ title: 'x' })
    expect(calls).toEqual([])
  })

  test('a lookup failure is not swallowed', async () => {
    const deps: PrivacyDeps = { lookup: async () => { throw new Error('db down') }, resolve: async () => ({ email: {}, phone: {} }) }
    expect(maskValue(deps, 'a@example.com', 'api')).rejects.toThrow('db down')
  })

  test('the tool wrapper puts real values in before the tool runs and masks what comes back', async () => {
    const { deps } = fakePrivacy('api', { email: { 'priya@example.com': 12 } })
    const sb = { rpc: async () => ({ data: true, error: null }) } as unknown as SupabaseClient
    const ctx = { http: { authInfo: { token: 't', clientId: 'app', scopes: [], extra: { userId: 'u-1' } } } } as unknown as ServerContext
    let seen: unknown = null
    const tool = run(
      async (_sb, a: { recipient: string; path: string }) => {
        seen = a
        return { saved: a.recipient, other: 'someone@example.com' }
      },
      () => sb,
      { privacy: () => deps, urlArgs: ['path'] },
    )
    const res = await tool({ recipient: '[EMAIL_12]', path: '/x?e=[EMAIL_12]' }, ctx)
    expect(seen).toEqual({ recipient: 'priya@example.com', path: '/x?e=priya%40example.com' })
    expect(JSON.parse(res.content[0].text)).toEqual({ saved: '[EMAIL_12]', other: 'someone@example.com' })
  })
})

describe('where a key may go', () => {
  test('only public internet addresses', () => {
    for (const ip of ['8.8.8.8', '104.18.0.1', '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true)
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', 'not-an-ip']) {
      expect(isPublicAddress(ip), ip).toBe(false)
    }
  })

  test('a name that points at a private address is refused at connect time', async () => {
    const ask = (addresses: { address: string; family: number }[], all = false): Promise<{ code?: string; address?: unknown }> =>
      new Promise((resolve) =>
        publicLookup((_h, cb) => cb(null, addresses))('x.example.org', { all }, (err, address) =>
          resolve(err ? { code: (err as NodeJS.ErrnoException).code } : { address }),
        ),
      )
    expect(await ask([{ address: '93.184.216.34', family: 4 }])).toEqual({ address: '93.184.216.34' })
    expect(await ask([{ address: '93.184.216.34', family: 4 }], true)).toEqual({ address: [{ address: '93.184.216.34', family: 4 }] })
    expect(await ask([{ address: '10.0.0.5', family: 4 }])).toEqual({ code: 'EPRIVATE' })
    // one private address among public ones is enough to refuse
    expect(await ask([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }])).toEqual({ code: 'EPRIVATE' })
    expect(await ask([])).toEqual({ code: 'EPRIVATE' })
    const real = await new Promise<string | undefined>((resolve) => publicLookup()('localhost', {}, (err) => resolve((err as NodeJS.ErrnoException | null)?.code)))
    expect(real).toBe('EPRIVATE')
  })

  test('hosts, header names, keys and paths are checked', () => {
    for (const h of ['api.razorpay.com', 'my-shop.myshopify.com', 'a.b.co']) expect(isHost(h), h).toBe(true)
    for (const h of ['localhost', '127.0.0.1', 'api', 'api.internal', 'x.local', 'API.example.com', 'a..b.com', 'evil.com/path', 'user@evil.com', '[::1]', 'a.com:8080']) {
      expect(isHost(h), h).toBe(false)
    }
    expect([isHeaderName('X-API-Key'), isHeaderName('Host'), isHeaderName('Content-Length'), isHeaderName('X Bad'), isHeaderName('X:Bad')]).toEqual([true, false, false, false, false])
    expect([isKeyValue('sk_live_12345678', 'bearer'), isKeyValue('short', 'bearer'), isKeyValue('has space 123', 'bearer'), isKeyValue('id:se cret-123', 'basic'), isKeyValue('abc\r\nX-Evil: 1', 'header')]).toEqual([true, false, false, true, false])
    expect(buildUrl('api.example.com', '/v1/x?a=1').href).toBe('https://api.example.com/v1/x?a=1')
    for (const p of ['v1/x', '/a b', '/x\r\nHost: evil', '']) expect(() => buildUrl('api.example.com', p), p).toThrow()
    expect(buildUrl('api.example.com', '//evil.com/x').hostname).toBe('api.example.com')
    expect(buildUrl('api.example.com', '/@evil.com/x').hostname).toBe('api.example.com')
    expect(() => buildUrl('127.0.0.1', '/x')).toThrow()
    expect(parseKeyMeta({ host: 'api.example.com', scheme: 'header', header: 'X-API-Key', writes: 'ask' })).toEqual({ host: 'api.example.com', scheme: 'header', header: 'X-API-Key', writes: 'ask' })
    expect(parseKeyMeta({ host: 'api.example.com', scheme: 'bearer' })?.writes).toBe('never')
    expect(parseKeyMeta({ host: '10.0.0.1', scheme: 'bearer' })).toBeNull()
    expect(parseKeyMeta({ host: 'api.example.com', scheme: 'header' })).toBeNull()
  })

  test('the key goes in the right header and is scrubbed from any reply', () => {
    expect(authHeader({ host: 'h.example.com', scheme: 'bearer', writes: 'never' }, 'abc12345')).toEqual(['authorization', 'Bearer abc12345'])
    expect(authHeader({ host: 'h.example.com', scheme: 'basic', writes: 'never' }, 'id:secret')).toEqual(['authorization', `Basic ${Buffer.from('id:secret').toString('base64')}`])
    expect(authHeader({ host: 'h.example.com', scheme: 'basic', writes: 'never' }, 'keyonly1')[1]).toBe(`Basic ${Buffer.from('keyonly1:').toString('base64')}`)
    expect(authHeader({ host: 'h.example.com', scheme: 'header', header: 'X-API-Key', writes: 'never' }, 'abc12345')).toEqual(['X-API-Key', 'abc12345'])
    const key = 'id_1:s3cr3t/+value'
    const echoed = `you sent ${key} | ${encodeURIComponent(key)} | Basic ${Buffer.from(key).toString('base64')} | ${Buffer.from(key).toString('base64url')}`
    const clean = scrubKey(echoed, key)
    expect(clean).toBe('you sent [KEY] | [KEY] | Basic [KEY] | [KEY]')
  })

  test('failures before the request left can be retried; after, they cannot', () => {
    expect(httpFailure(Object.assign(new Error('x'), { code: 'ENOTFOUND', delivered: false })).notSent).toBe(true)
    expect(httpFailure(Object.assign(new Error('x'), { code: 'EPRIVATE', delivered: false })).reason).toContain('public address')
    expect(httpFailure(Object.assign(new Error('x'), { code: 'ECONNRESET', delivered: true })).notSent).toBe(false)
  })
})

// A real HTTP exchange against a local server (plain HTTP, test only).
describe('the sealed request on the wire', () => {
  const seen: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = []
  let server: http.Server
  let port = 0
  const meta: KeyMeta = { host: 'api.example.com', scheme: 'bearer', writes: 'ask' }
  const KEYV = 'sk_test_SECRET_0123456789'

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString('utf8')))
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'http://127.0.0.1:1/steal' }).end()
        } else if (req.url === '/big') {
          res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(MAX_BYTES + 5000))
        } else {
          res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, auth: req.headers.authorization }))
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test('GET carries the key and nothing from the caller but the path', async () => {
    const res = await sealedRequest({ meta, key: KEYV, method: 'GET', path: '/v1/payments?count=2' }, { insecureLocalPort: port })
    expect(res.status).toBe(200)
    const req = seen.at(-1)
    expect([req?.method, req?.url, req?.headers.authorization, req?.headers.host]).toEqual(['GET', '/v1/payments?count=2', `Bearer ${KEYV}`, 'api.example.com'])
    expect(scrubKey(res.text, KEYV)).toBe('{"ok":true,"auth":"Bearer [KEY]"}')
  })

  test('POST sends the approved body word for word', async () => {
    const body = '{"payment":"pay_1","amount":500}'
    const res = await sealedRequest({ meta, key: KEYV, method: 'POST', path: '/v1/refunds', body, contentType: 'application/json' }, { insecureLocalPort: port })
    expect(res.status).toBe(201)
    const req = seen.at(-1)
    expect([req?.method, req?.body, req?.headers['content-type']]).toEqual(['POST', body, 'application/json'])
  })

  test('a redirect is reported, not followed; a huge reply is cut', async () => {
    const before = seen.length
    const redirect = await sealedRequest({ meta, key: KEYV, method: 'GET', path: '/redirect' }, { insecureLocalPort: port })
    expect(redirect.status).toBe(302)
    expect(seen.length).toBe(before + 1)
    const big = await sealedRequest({ meta, key: KEYV, method: 'GET', path: '/big' }, { insecureLocalPort: port })
    expect([big.truncated, big.text.length]).toEqual([true, MAX_BYTES])
  })

  test('a bad path never opens a connection', async () => {
    const before = seen.length
    let failure = null
    try {
      await sealedRequest({ meta, key: KEYV, method: 'GET', path: '/a b' }, { insecureLocalPort: port })
    } catch (e) {
      failure = httpFailure(e)
    }
    expect(failure?.notSent).toBe(true)
    expect(seen.length).toBe(before)
  })
})

describe('a read for an assistant', () => {
  const VAULT = randomBytes(32)
  const USER = '11111111-1111-4111-8111-111111111111'
  const KEYV = 'sk_live_SECRET_0123456789'
  const deps = (res: SealedResponse, over: Partial<ApiReadDeps> = {}): ApiReadDeps & { paths: string[] } => {
    const paths: string[] = []
    return {
      paths,
      userId: USER,
      vault: VAULT,
      readKey: async () => ({ meta: { host: 'api.example.com', scheme: 'bearer', writes: 'never' }, ciphertext: seal(VAULT, KEYV, binding(USER, 'api:shop')) }),
      request: async (req) => {
        paths.push(`${req.method} ${req.path} ${req.key === KEYV}`)
        return res
      },
      mask: (v) => maskValue(fakePrivacy().deps, v, 'api'),
      ...over,
    }
  }
  const json = (data: unknown, status = 200): SealedResponse => ({ status, contentType: 'application/json', text: JSON.stringify(data), truncated: false })

  test('the reply comes back masked, compact, and without the key', async () => {
    const d = deps(json({ items: [{ id: 'o1', email: 'a@example.com', phone: '+91 98765 43210', total: 500, echo: KEYV }] }))
    const out = await apiRead(d, { key: 'shop', path: '/orders' })
    expect(out).toBe('HTTP 200\n{"items":[{"id":"o1","email":"[EMAIL_1]","phone":"[PHONE_1]","total":500,"echo":"[KEY]"}]}')
    expect(d.paths).toEqual(['GET /orders true'])
  })

  test('"fields" cuts the reply down before it is sent back', async () => {
    const d = deps(json({ items: [{ id: 'o1', email: 'a@example.com', total: 500, lines: [1, 2, 3] }], page: 1 }))
    expect(await apiRead(d, { key: 'shop', path: '/orders', fields: ['items.id', 'items.total'] })).toBe('HTTP 200\n{"items":[{"id":"o1","total":500}]}')
  })

  test('plain text and error replies are masked too; a long reply is cut with a note', async () => {
    const text = await apiRead(deps({ status: 404, contentType: 'text/plain', text: 'no customer a@example.com', truncated: false }), { key: 'shop', path: '/x' })
    expect(text).toBe('HTTP 404\nno customer [EMAIL_1]')
    const long = await apiRead(deps(json({ blob: 'y'.repeat(MAX_REPLY_CHARS * 2) })), { key: 'shop', path: '/x' })
    expect(long.length).toBeLessThan(MAX_REPLY_CHARS + 200)
    expect(long).toContain('ask again with "fields"')
  })

  test('if masking fails, nothing of the reply is returned', async () => {
    const d = deps(json({ email: 'a@example.com' }), { mask: async () => { throw new Error('db down') } })
    expect(apiRead(d, { key: 'shop', path: '/x' })).rejects.toThrow('db down')
  })

  test('a key sealed for another name or person does not open, and no request is made', async () => {
    const d = deps(json({}), { readKey: async () => ({ meta: { host: 'api.example.com', scheme: 'bearer', writes: 'never' }, ciphertext: seal(VAULT, KEYV, binding(USER, 'api:other')) }) })
    expect(apiRead(d, { key: 'shop', path: '/x' })).rejects.toThrow('could not be opened')
    expect(d.paths).toEqual([])
    const bad = deps(json({}), { readKey: async () => ({ meta: { host: '10.0.0.1', scheme: 'bearer' }, ciphertext: 'x' }) })
    expect(apiRead(bad, { key: 'shop', path: '/x' })).rejects.toThrow('not saved correctly')
  })
})
