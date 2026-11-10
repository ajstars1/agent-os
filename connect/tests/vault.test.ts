import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { SMTPServer } from 'smtp-server'
import { mailFailure, parseRecipient, sendMail, transportOptions, unsendable, verifyLogin, type MailLogin, type Server } from '../lib/mail'
import type { Claim } from '../lib/send-db'
import { outcomeLine, sendApproved, type SenderDeps } from '../lib/sender'
import type { Approval } from '../lib/types'
import { binding, open, seal } from '../lib/vault'

const KEY = randomBytes(32)
const USER = '11111111-1111-4111-8111-111111111111'
const PASSWORD = 'abcd efgh ijkl mnop-SECRET'

describe('sealing', () => {
  test('a sealed value opens only with the same key, owner and kind', () => {
    const sealed = seal(KEY, PASSWORD, binding(USER, 'smtp'))
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/)
    expect(sealed).not.toContain('SECRET')
    expect(open(KEY, sealed, binding(USER, 'smtp'))).toBe(PASSWORD)
    expect(() => open(randomBytes(32), sealed, binding(USER, 'smtp'))).toThrow()
    expect(() => open(KEY, sealed, binding('22222222-2222-4222-8222-222222222222', 'smtp'))).toThrow()
    expect(() => open(KEY, sealed, binding(USER, 'other'))).toThrow()
  })

  test('a changed value does not open, and two seals of one value differ', () => {
    const sealed = seal(KEY, PASSWORD, 'b')
    const [v, iv, body, tag] = sealed.split('.')
    const flipped = body.startsWith('A') ? `B${body.slice(1)}` : `A${body.slice(1)}`
    expect(() => open(KEY, [v, iv, flipped, tag].join('.'), 'b')).toThrow()
    expect(() => open(KEY, 'v2.a.b.c', 'b')).toThrow()
    expect(seal(KEY, PASSWORD, 'b')).not.toBe(sealed)
  })
})

describe('mail rules', () => {
  test('a draft goes to exactly one address', () => {
    expect(parseRecipient('Priya Shah <Priya@Example.com>')).toBe('priya@example.com')
    expect(parseRecipient('priya@example.com')).toBe('priya@example.com')
    expect(parseRecipient('Priya')).toBeNull()
    expect(parseRecipient('a@example.com, b@example.com')).toBeNull()
    expect(parseRecipient(null)).toBeNull()
    expect(unsendable({ recipient: 'a@example.com', subject: 'Hi' })).toBeNull()
    expect(unsendable({ recipient: 'a@example.com', subject: null })).toContain('subject')
    expect(unsendable({ recipient: 'nobody', subject: 'Hi' })).toContain('one email address')
  })

  test('real providers always use TLS and never a host from input', () => {
    const login: MailLogin = { provider: 'gmail', username: 'me@example.com', password: 'x', fromName: null }
    const gmail = transportOptions(login)
    expect([gmail.host, gmail.port, gmail.secure, gmail.requireTLS, gmail.ignoreTLS]).toEqual(['smtp.gmail.com', 465, true, true, false])
    const icloud = transportOptions({ ...login, provider: 'icloud' })
    expect([icloud.port, icloud.secure, icloud.requireTLS]).toEqual([587, false, true])
  })

  test('only failures before the message left count as "not sent"', () => {
    expect(mailFailure({ code: 'EAUTH' }).notSent).toBe(true)
    expect(mailFailure({ code: 'EENVELOPE' }).notSent).toBe(true)
    expect(mailFailure({ code: 'ETIMEDOUT', command: 'CONN' }).notSent).toBe(true)
    expect(mailFailure({ code: 'ESOCKET', command: 'DATA' }).notSent).toBe(false)
    expect(mailFailure(new Error('boom')).notSent).toBe(false)
  })
})

// A real SMTP conversation against a local server (no TLS, test only).
describe('sending over SMTP', () => {
  const received: Array<{ from: string; to: string[]; raw: string }> = []
  let server: SMTPServer
  let local: Server
  const login: MailLogin = { provider: 'gmail', username: 'me@example.com', password: PASSWORD, fromName: 'Asha "Rao"\r\nBcc: x@evil.test' }

  beforeAll(async () => {
    server = new SMTPServer({
      secure: false,
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      authMethods: ['PLAIN', 'LOGIN'],
      onAuth: (auth, _session, cb) =>
        auth.username === 'me@example.com' && auth.password === PASSWORD ? cb(null, { user: auth.username }) : cb(new Error('Invalid login')),
      onRcptTo: (address, _session, cb) => (address.address.endsWith('@blocked.test') ? cb(new Error('No such user')) : cb()),
      onData: (stream, session, cb) => {
        let raw = ''
        stream.on('data', (c: Buffer) => (raw += c.toString('utf8')))
        stream.on('end', () => {
          received.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: session.envelope.rcptTo.map((r) => r.address), raw })
          cb()
        })
      },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.server.address()
    local = { host: '127.0.0.1', port: typeof addr === 'object' && addr ? addr.port : 0, insecure: true }
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test('a good login verifies; a bad one is refused before anything is sent', async () => {
    await verifyLogin(login, local)
    let failure = null
    try {
      await verifyLogin({ ...login, password: 'wrong' }, local)
    } catch (e) {
      failure = mailFailure(e)
    }
    expect(failure?.notSent).toBe(true)
    expect(failure?.reason).toContain('refused the login')
  })

  test('the approved text goes out word for word, to one recipient, with no injected headers', async () => {
    const text = 'Hello Priya,\n\nThe quote is ₹12,000.\n.\nRegards'
    await sendMail(login, { to: 'priya@example.com', subject: 'Quote for the order', text }, local)
    const m = received.at(-1)
    expect(m?.from).toBe('me@example.com')
    expect(m?.to).toEqual(['priya@example.com'])
    expect(m?.raw).toContain('Subject: Quote for the order')
    expect(m?.raw).not.toMatch(/^Bcc:/im)
    expect(m?.raw).not.toContain('evil.test>')
    const body = m?.raw.split(/\r?\n\r?\n/).slice(1).join('\n\n') ?? ''
    const decoded = /quoted-printable/i.test(m?.raw ?? '')
      ? Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8')
      : /base64/i.test(m?.raw ?? '')
        ? Buffer.from(body, 'base64').toString('utf8')
        : body
    expect(decoded.replace(/\r\n/g, '\n').trim()).toBe(text)
  })

  test('a refused recipient is "not sent"', async () => {
    const before = received.length
    let failure = null
    try {
      await sendMail(login, { to: 'nobody@blocked.test', subject: 'Hi', text: 'x' }, local)
    } catch (e) {
      failure = mailFailure(e)
    }
    expect(failure?.notSent).toBe(true)
    expect(received.length).toBe(before)
  })
})

describe('the sealed send', () => {
  const approval = (over: Partial<Approval> = {}): Approval => ({
    id: 9, task_id: null, channel: 'email', recipient: 'Priya <priya@example.com>', subject: 'Quote', draft: 'Approved text.',
    status: 'approved', result: null, send_after: null, created_at: '2026-11-10T06:00:00Z', decided_at: '2026-11-10T06:01:00Z',
    ...over,
  })
  const claimOf = (over: Partial<Approval> = {}, sealed = seal(KEY, PASSWORD, binding(USER, 'smtp'))): Claim => ({
    user_id: USER,
    approval: approval(over),
    meta: { provider: 'gmail', username: 'me@example.com', from_name: 'Asha' },
    ciphertext: sealed,
  })

  const harness = (opts: { claim?: Claim; claimError?: string; sendError?: unknown; key?: Buffer | null } = {}) => {
    const finished: Array<[string, number, string, string]> = []
    const sent: Array<{ login: MailLogin; to: string; subject: string; text: string }> = []
    const deps: SenderDeps = {
      key: opts.key === undefined ? KEY : opts.key,
      now: () => new Date('2026-11-10T06:30:00Z'),
      claim: async () => {
        if (opts.claimError) throw new Error(opts.claimError)
        return opts.claim ?? claimOf()
      },
      finish: async (userId, id, outcome, result) => {
        finished.push([userId, id, outcome, result])
      },
      send: async (login, msg) => {
        if (opts.sendError) throw opts.sendError
        sent.push({ login, ...msg })
      },
    }
    return { deps, finished, sent }
  }

  test('opens the login, sends the approved text, records it, and never repeats the password', async () => {
    const h = harness()
    const out = await sendApproved(h.deps)
    expect(out).toEqual({ kind: 'sent', to: 'priya@example.com' })
    expect(h.sent).toEqual([
      { login: { provider: 'gmail', username: 'me@example.com', password: PASSWORD, fromName: 'Asha' }, to: 'priya@example.com', subject: 'Quote', text: 'Approved text.' },
    ])
    expect(h.finished).toEqual([[USER, 9, 'sent', 'Sent by aos from m***@example.com at 2026-11-10T06:30:00.000Z']])
    expect(JSON.stringify([out, h.finished, outcomeLine(9, out)])).not.toContain('SECRET')
  })

  test('nothing to do is quiet; other refusals are shown; unknown errors are not', async () => {
    expect(await sendApproved(harness({ claimError: 'Cannot send draft 9: no email connection' }).deps)).toEqual({ kind: 'skipped', reason: 'no email connection' })
    expect(await sendApproved(harness({ claimError: 'Cannot send draft 9: it is already being sent' }).deps)).toEqual({ kind: 'not_sent', reason: 'it is already being sent' })
    const odd = await sendApproved(harness({ claimError: 'relation "public.secrets" does not exist' }).deps)
    expect(odd.kind).toBe('not_sent')
    expect(JSON.stringify(odd)).not.toContain('relation')
    expect((await sendApproved(harness({ key: null }).deps)).kind).toBe('skipped')
  })

  test('a draft aos cannot send is released, not sent', async () => {
    for (const over of [{ subject: null }, { recipient: 'Priya' }, { recipient: 'a@example.com b@example.com' }]) {
      const h = harness({ claim: claimOf(over) })
      expect((await sendApproved(h.deps)).kind).toBe('not_sent')
      expect(h.sent).toEqual([])
      expect(h.finished[0][2]).toBe('retry')
    }
  })

  test('a login sealed for someone else, or with another key, does not open', async () => {
    const other = harness({ claim: claimOf({}, seal(KEY, PASSWORD, binding('22222222-2222-4222-8222-222222222222', 'smtp'))) })
    expect((await sendApproved(other.deps)).kind).toBe('not_sent')
    expect(other.sent).toEqual([])
    const rekeyed = harness({ claim: claimOf({}, seal(randomBytes(32), PASSWORD, binding(USER, 'smtp'))) })
    expect((await sendApproved(rekeyed.deps)).kind).toBe('not_sent')
    expect(rekeyed.finished[0][2]).toBe('retry')
  })

  test('a refused login can be retried; a broken connection mid-send is never retried', async () => {
    const refused = harness({ sendError: { code: 'EAUTH' } })
    expect((await sendApproved(refused.deps)).kind).toBe('not_sent')
    expect(refused.finished[0][2]).toBe('retry')
    const broken = harness({ sendError: { code: 'ESOCKET', command: 'DATA' } })
    expect((await sendApproved(broken.deps)).kind).toBe('unknown')
    expect(broken.finished[0][2]).toBe('failed')
  })
})
