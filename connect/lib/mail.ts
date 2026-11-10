// Sending mail with the person's own mail login (SMTP with an app password). Plain text only.
// The mail server's address always comes from the fixed list below, never from anything a user or an assistant
// typed, so this cannot be pointed at an arbitrary host.
import nodemailer from 'nodemailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'

export const PROVIDERS = {
  gmail: { label: 'Gmail or Google Workspace', host: 'smtp.gmail.com', port: 465 },
  zoho: { label: 'Zoho Mail (zoho.com address)', host: 'smtp.zoho.com', port: 465 },
  zoho_in: { label: 'Zoho Mail India (zoho.in address)', host: 'smtp.zoho.in', port: 465 },
  zoho_pro: { label: 'Zoho Mail with your own domain', host: 'smtppro.zoho.com', port: 465 },
  zoho_pro_in: { label: 'Zoho Mail India with your own domain', host: 'smtppro.zoho.in', port: 465 },
  yahoo: { label: 'Yahoo Mail', host: 'smtp.mail.yahoo.com', port: 465 },
  icloud: { label: 'iCloud Mail', host: 'smtp.mail.me.com', port: 587 },
  fastmail: { label: 'Fastmail', host: 'smtp.fastmail.com', port: 465 },
} as const

export type Provider = keyof typeof PROVIDERS

export const isProvider = (v: unknown): v is Provider => typeof v === 'string' && Object.hasOwn(PROVIDERS, v)

export interface MailLogin {
  provider: Provider
  username: string
  password: string
  fromName: string | null
}

export interface Server {
  host: string
  port: number
  // tests talk to a local server without TLS; production always uses TLS
  insecure?: boolean
}

export const transportOptions = (login: MailLogin, server: Server = PROVIDERS[login.provider]): SMTPTransport.Options => ({
  host: server.host,
  port: server.port,
  secure: !server.insecure && server.port === 465,
  requireTLS: !server.insecure,
  ignoreTLS: Boolean(server.insecure),
  auth: { user: login.username, pass: login.password },
  tls: { minVersion: 'TLSv1.2', servername: server.host },
  connectionTimeout: 8000,
  greetingTimeout: 8000,
  socketTimeout: 15000,
  disableFileAccess: true,
  disableUrlAccess: true,
})

const ADDRESS = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/gi

// The one address a draft goes to, or null when the text names none or more than one.
export const parseRecipient = (text: string | null): string | null => {
  const found = [...new Set((text ?? '').match(ADDRESS)?.map((a) => a.toLowerCase()) ?? [])]
  return found.length === 1 && found[0].length <= 254 ? found[0] : null
}

export interface Message {
  to: string
  subject: string
  text: string
}

// Why a draft cannot be sent by the server as it stands, or null when it can.
export const unsendable = (a: { recipient: string | null; subject: string | null }): string | null => {
  if (!parseRecipient(a.recipient)) return 'the recipient must be exactly one email address'
  if (!a.subject || /[\r\n]/.test(a.subject)) return 'it has no subject line'
  return null
}

const clean = (name: string | null): string | undefined => {
  const n = (name ?? '').replace(/[\r\n"<>]/g, '').trim()
  return n ? n.slice(0, 80) : undefined
}

// Checks the login without sending anything.
export const verifyLogin = async (login: MailLogin, server?: Server): Promise<void> => {
  const transport = nodemailer.createTransport(transportOptions(login, server))
  try {
    await transport.verify()
  } finally {
    transport.close()
  }
}

export const sendMail = async (login: MailLogin, msg: Message, server?: Server): Promise<void> => {
  const transport = nodemailer.createTransport(transportOptions(login, server))
  try {
    const name = clean(login.fromName)
    await transport.sendMail({
      from: name ? { name, address: login.username } : login.username,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      disableFileAccess: true,
      disableUrlAccess: true,
    })
  } finally {
    transport.close()
  }
}

export interface MailFailure {
  // true = the message certainly did not go out, so trying again is safe
  notSent: boolean
  // safe to show: says nothing about the server's own words
  reason: string
}

// Reads a nodemailer error. Anything that could have happened after the message started going out is treated as
// "may have been sent", so it is never sent twice by a retry.
export const mailFailure = (e: unknown): MailFailure => {
  const err = (e ?? {}) as { code?: unknown; command?: unknown }
  const code = typeof err.code === 'string' ? err.code : ''
  const command = typeof err.command === 'string' ? err.command : ''
  if (code === 'EAUTH') return { notSent: true, reason: 'your mail provider refused the login. Reconnect email on the aos page' }
  if (code === 'EENVELOPE') return { notSent: true, reason: 'the mail server refused the recipient address' }
  if (code === 'EDNS' || command === 'CONN') return { notSent: true, reason: 'the mail server could not be reached' }
  return { notSent: false, reason: 'the connection broke while sending. Check your Sent folder before sending it again' }
}
