// The sealed action: send one approved email with the person's own mail login. The model never takes part: it
// asked for the draft, the person approved it, and this code opens the login, sends the approved text word for
// word and records what happened. Effects are passed in so the whole flow is tested without a network.
import { isProvider, mailFailure, parseRecipient, sendMail, unsendable, type MailLogin, type Message } from './mail'
import { claimSend, claimSendFromChat, finishSend, type Claim } from './send-db'
import { binding, open, vaultKey } from './vault'

export type SendOutcome =
  | { kind: 'sent'; to: string }
  // nothing went out and nothing is wrong: not an email, no connection, scheduled for later
  | { kind: 'skipped'; reason: string }
  // it did not go out; the draft is still approved and can be sent again
  | { kind: 'not_sent'; reason: string }
  // it may have gone out; never retried automatically
  | { kind: 'unknown'; reason: string }

export interface SenderDeps {
  claim: () => Promise<Claim>
  finish: (userId: string, id: number, outcome: 'sent' | 'failed' | 'retry', result: string) => Promise<void>
  key: Buffer | null
  send: (login: MailLogin, msg: Message) => Promise<void>
  now: () => Date
}

// Messages the database raises on purpose. Only these are shown.
const CLAIM_ERROR = /^Cannot send draft \d+: ([a-z0-9 ,]+)$/
const QUIET = new Set(['it is not an email', 'no email connection', 'it is scheduled for later'])

const hint = (address: string): string => address.replace(/^(.).*(@.*)$/, '$1***$2')

export const sendApproved = async (d: SenderDeps): Promise<SendOutcome> => {
  if (!d.key) return { kind: 'skipped', reason: 'email sending is not set up on this server' }

  let claim: Claim
  try {
    claim = await d.claim()
  } catch (e) {
    const why = CLAIM_ERROR.exec(e instanceof Error ? e.message : '')?.[1]
    if (why && QUIET.has(why)) return { kind: 'skipped', reason: why }
    return { kind: 'not_sent', reason: why ?? 'something went wrong. Try again in a minute' }
  }

  const { approval: a, user_id: userId } = claim
  const release = async (reason: string): Promise<SendOutcome> => {
    await d.finish(userId, a.id, 'retry', `Not sent: ${reason}.`).catch(() => undefined)
    return { kind: 'not_sent', reason }
  }

  const problem = unsendable(a)
  const to = parseRecipient(a.recipient)
  if (problem || !to || !a.subject) return release(problem ?? 'the recipient must be exactly one email address')

  const { provider, username, from_name: fromName } = claim.meta
  if (!isProvider(provider) || typeof username !== 'string') return release('the email connection is incomplete. Reconnect email on the aos page')

  let password: string
  try {
    password = open(d.key, claim.ciphertext, binding(userId, 'smtp'))
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

const real = (claim: () => Promise<Claim>): SenderDeps => ({ claim, finish: finishSend, key: vaultKey(), send: sendMail, now: () => new Date() })

// userId must come from a verified token.
export const sendForUser = (userId: string, id: number): Promise<SendOutcome> => sendApproved(real(() => claimSend(userId, id)))

export const sendFromChat = (chatId: string, id: number): Promise<SendOutcome> => sendApproved(real(() => claimSendFromChat(chatId, id)))

export const outcomeLine = (id: number, o: SendOutcome): string =>
  o.kind === 'sent'
    ? `Draft #${id} was sent to ${o.to}.`
    : o.kind === 'skipped'
      ? `Draft #${id} was not sent by aos: ${o.reason}.`
      : o.kind === 'not_sent'
        ? `Draft #${id} was not sent: ${o.reason}. It is still approved.`
        : `Draft #${id} may not have been sent: ${o.reason}.`
