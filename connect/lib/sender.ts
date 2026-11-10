// The sealed actions: after the person's yes, send one approved email with their own mail login, or make one
// approved API request with their saved key. The model takes no part: it asked, the person approved, and this code
// opens the secret, does exactly what was approved and records what happened. Effects are passed in so the whole
// flow is tested without a network.
import { isProvider, mailFailure, parseRecipient, sendMail, unsendable, type MailLogin, type Message } from './mail'
import { maskValue, privacyFor } from './privacy'
import { httpFailure, parseKeyMeta, scrubKey, sealedRequest, type SealedRequest, type SealedResponse } from './sealed-http'
import { claimSend, claimSendFromChat, finishSend, type Claim } from './send-db'
import { binding, open, vaultKey } from './vault'

export type SendOutcome =
  // it went out. to = the address, or the request that ran
  | { kind: 'sent'; to: string; api?: boolean }
  // nothing went out and nothing is wrong: not something aos sends, no connection, scheduled for later
  | { kind: 'skipped'; reason: string }
  // it did not go out; the draft is still approved and can be sent again
  | { kind: 'not_sent'; reason: string }
  // the service received the request and said no; never retried
  | { kind: 'refused'; reason: string }
  // it may have gone out; never retried automatically
  | { kind: 'unknown'; reason: string }

export interface SenderDeps {
  claim: () => Promise<Claim>
  finish: (userId: string, id: number, outcome: 'sent' | 'failed' | 'retry', result: string) => Promise<void>
  key: Buffer | null
  send: (login: MailLogin, msg: Message) => Promise<void>
  request: (req: SealedRequest) => Promise<SealedResponse>
  // masks what a service answered before it is stored where an assistant can read it; may throw
  mask: (userId: string, text: string) => Promise<string>
  now: () => Date
}

// Messages the database raises on purpose. Only these are shown.
const CLAIM_ERROR = /^Cannot send draft \d+: ([a-z0-9 ,]+)$/
const QUIET = new Set(['it is not an email', 'no email connection', 'it is scheduled for later'])

const hint = (address: string): string => address.replace(/^(.).*(@.*)$/, '$1***$2')

type Release = (reason: string) => Promise<SendOutcome>

const sendEmail = async (d: SenderDeps, claim: Claim, release: Release): Promise<SendOutcome> => {
  const { approval: a, user_id: userId } = claim
  const problem = unsendable(a)
  const to = parseRecipient(a.recipient)
  if (problem || !to || !a.subject) return release(problem ?? 'the recipient must be exactly one email address')

  const { provider, username, from_name: fromName } = claim.meta
  if (!isProvider(provider) || typeof username !== 'string') return release('the email connection is incomplete. Reconnect email on the aos page')

  let password: string
  try {
    password = open(d.key as Buffer, claim.ciphertext, binding(userId, 'smtp'))
  } catch {
    return release('the saved mail login could not be opened. Reconnect email on the aos page')
  }

  try {
    await d.send({ provider, username, password, fromName: typeof fromName === 'string' ? fromName : null }, { to, subject: a.subject, text: a.draft })
  } catch (e) {
    const f = mailFailure(e)
    if (f.notSent) return release(f.reason)
    await d.finish(userId, a.id, 'failed', `May not have been sent: ${f.reason}.`).catch(() => undefined)
    return { kind: 'unknown', reason: f.reason }
  }

  // The mail is out. If recording it fails, the claim stays in place, so it is not sent a second time.
  await d.finish(userId, a.id, 'sent', `Sent by aos from ${hint(username)} at ${d.now().toISOString()}`).catch(() => undefined)
  return { kind: 'sent', to }
}

const METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const runRequest = async (d: SenderDeps, claim: Claim, release: Release): Promise<SendOutcome> => {
  const { approval: a, user_id: userId } = claim
  const action = a.action
  const meta = parseKeyMeta(claim.meta)
  if (!action || !meta || !METHODS.has(action.method)) return release('the saved request or key is incomplete. Ask again')

  let key: string
  try {
    key = open(d.key as Buffer, claim.ciphertext, binding(userId, `api:${action.key}`))
  } catch {
    return release('the saved key could not be opened. Save it again on the aos page')
  }

  const what = `${action.method} ${meta.host}${action.path.split('?')[0]}`
  let res: SealedResponse
  try {
    res = await d.request({ meta, key, method: action.method, path: action.path, body: action.body, contentType: action.content_type })
  } catch (e) {
    const f = httpFailure(e)
    if (f.notSent) return release(f.reason)
    await d.finish(userId, a.id, 'failed', `May not have run: ${f.reason}.`).catch(() => undefined)
    return { kind: 'unknown', reason: f.reason }
  }

  // The first part of the answer is kept so the assistant can read an id or an error. Key out, contact details masked;
  // if masking fails, only the status is kept.
  const answer = await d.mask(userId, scrubKey(res.text.slice(0, 2000), key)).then(
    (t) => t.replace(/\s+/g, ' ').trim().slice(0, 600),
    () => '',
  )
  const ok = res.status >= 200 && res.status < 300
  await d.finish(userId, a.id, ok ? 'sent' : 'failed', `HTTP ${res.status}${answer ? `. ${answer}` : ''}`).catch(() => undefined)
  return ok ? { kind: 'sent', to: `${what} (HTTP ${res.status})`, api: true } : { kind: 'refused', reason: `the service answered HTTP ${res.status}` }
}

export const sendApproved = async (d: SenderDeps): Promise<SendOutcome> => {
  if (!d.key) return { kind: 'skipped', reason: 'sending is not set up on this server' }

  let claim: Claim
  try {
    claim = await d.claim()
  } catch (e) {
    const why = CLAIM_ERROR.exec(e instanceof Error ? e.message : '')?.[1]
    if (why && QUIET.has(why)) return { kind: 'skipped', reason: why }
    return { kind: 'not_sent', reason: why ?? 'something went wrong. Try again in a minute' }
  }

  const { approval: a, user_id: userId } = claim
  const release: Release = async (reason) => {
    await d.finish(userId, a.id, 'retry', `Not sent: ${reason}.`).catch(() => undefined)
    return { kind: 'not_sent', reason }
  }
  return a.channel === 'api' ? runRequest(d, claim, release) : sendEmail(d, claim, release)
}

// What aos does itself after a yes.
export const SELF_SENT = new Set(['email', 'api'])

const maskAnswer = async (userId: string, text: string): Promise<string> => {
  const privacy = privacyFor(userId)
  if (!privacy) throw new Error('masking is off')
  return String(await maskValue(privacy, text, 'api'))
}

const real = (claim: () => Promise<Claim>): SenderDeps => ({
  claim,
  finish: finishSend,
  key: vaultKey(),
  send: sendMail,
  request: sealedRequest,
  mask: maskAnswer,
  now: () => new Date(),
})

// userId must come from a verified token.
export const sendForUser = (userId: string, id: number): Promise<SendOutcome> => sendApproved(real(() => claimSend(userId, id)))

export const sendFromChat = (chatId: string, id: number): Promise<SendOutcome> => sendApproved(real(() => claimSendFromChat(chatId, id)))

export const outcomeLine = (id: number, o: SendOutcome): string =>
  o.kind === 'sent'
    ? o.api
      ? `Draft #${id} ran: ${o.to}.`
      : `Draft #${id} was sent to ${o.to}.`
    : o.kind === 'skipped'
      ? `Draft #${id} was not sent by aos: ${o.reason}.`
      : o.kind === 'not_sent'
        ? `Draft #${id} was not sent: ${o.reason}. It is still approved.`
        : o.kind === 'refused'
          ? `Draft #${id} ran, but ${o.reason}. It is not retried; approval_list shows the answer.`
          : `Draft #${id} may not have been sent: ${o.reason}.`
