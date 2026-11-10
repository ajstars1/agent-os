'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { channelEnv } from '../../lib/env'
import { isProvider, verifyLogin, type Provider } from '../../lib/mail'
import { isHeaderName, isHost, isKeyValue, type Scheme } from '../../lib/sealed-http'
import { SELF_SENT, sendForUser, type SendOutcome } from '../../lib/sender'
import {
  createLinkCode,
  decideApproval,
  removeApiKey,
  removeMailConnection,
  saveApiKey,
  saveMailConnection,
  setMaskLevel,
  setProfile,
  unlinkPhone,
  withinRate,
} from '../../lib/store'
import { binding, seal, vaultKey } from '../../lib/vault'
import { signedIn } from '../../lib/supabase-server'
import { isValidTimeZone } from '../../lib/time'

const decisionSchema = z.object({
  id: z.coerce.number().int().positive(),
  decision: z.enum(['approved', 'rejected']),
  draft: z.string().max(5000).optional(),
})

const back = (code?: string): never => redirect(code ? `/app?e=${code}` : '/app')
const done = (notice: string): never => redirect(`/app?n=${notice}`)

// Where to land after aos tried to send an approved email.
const afterSend = (o: SendOutcome): never => {
  if (o.kind === 'sent') return done(o.api ? 'ran' : 'sent')
  if (o.kind === 'skipped') return back()
  if (o.kind === 'refused') return back('send_refused')
  return back(o.kind === 'unknown' ? 'send_unknown' : /login|Reconnect/.test(o.reason) ? 'send_login' : /recipient|subject/.test(o.reason) ? 'send_shape' : /limit/.test(o.reason) ? 'send_limit' : 'send')
}

// The one place a draft gets approved. It runs with the person's own website session; the database refuses the
// same change from any connected app.
export const decideDraft = async (formData: FormData): Promise<void> => {
  const parsed = decisionSchema.safeParse({
    id: formData.get('id'),
    decision: formData.get('decision'),
    draft: formData.get('draft') ?? undefined,
  })
  if (!parsed.success) back('input')
  const { id, decision, draft } = parsed.data!
  const user = await signedIn().catch(() => null)
  if (!user) redirect('/login?next=/app')
  let channel: string | null = null
  try {
    const edited = draft?.trim()
    channel = (await decideApproval(user.sb, id, decision, decision === 'approved' && edited ? edited : undefined)).channel
  } catch {
    channel = null
  }
  revalidatePath('/app')
  if (channel === null) back('decide')
  if (decision !== 'approved' || !SELF_SENT.has(channel ?? '')) back()
  // The person said yes to an email or an API request: aos does it now, with their own saved login or key.
  afterSend(await sendForUser(user.userId, id).catch((): SendOutcome => ({ kind: 'not_sent', reason: 'unknown' })))
}

const idSchema = z.object({ id: z.coerce.number().int().positive() })

// "Send now" on an email the person already approved.
export const sendNow = async (formData: FormData): Promise<void> => {
  const parsed = idSchema.safeParse({ id: formData.get('id') })
  if (!parsed.success) back('input')
  const user = await signedIn().catch(() => null)
  if (!user) redirect('/login?next=/app')
  const outcome = await sendForUser(user.userId, parsed.data!.id).catch((): SendOutcome => ({ kind: 'not_sent', reason: 'unknown' }))
  revalidatePath('/app')
  if (outcome.kind === 'skipped') back('send')
  afterSend(outcome)
}

const mailSchema = z.object({
  provider: z.string().refine(isProvider),
  username: z.email().max(254),
  password: z.string().min(4).max(200),
  from_name: z.string().max(80).optional(),
})

// Connect the person's mailbox. The login is checked against their mail provider, sealed, and stored. It is never
// shown again, to anyone: not on this page, not to an assistant.
export const connectEmail = async (formData: FormData): Promise<void> => {
  const key = vaultKey()
  if (!key) back('mail_off')
  const parsed = mailSchema.safeParse({
    provider: formData.get('provider'),
    username: String(formData.get('username') ?? '').trim().toLowerCase(),
    // app passwords are shown in groups with spaces; the spaces are not part of it
    password: String(formData.get('password') ?? '').replace(/\s+/g, ''),
    from_name: String(formData.get('from_name') ?? '').trim() || undefined,
  })
  if (!parsed.success) back('mail_input')
  const { username, password, from_name: fromName } = parsed.data!
  const provider = parsed.data!.provider as Provider
  const user = await signedIn().catch(() => null)
  if (!user) redirect('/login?next=/app')

  let code: string | null = null
  try {
    // so this page cannot be used to guess someone's mail password
    if (!(await withinRate(user.sb, 'mail-connect', 5, 3600))) code = 'mail_rate'
  } catch {
    code = 'mail_save'
  }
  if (code) back(code)

  try {
    await verifyLogin({ provider, username, password, fromName: fromName ?? null })
  } catch {
    code = 'mail_login'
  }
  if (code) back(code)

  try {
    await saveMailConnection(user.sb, { provider, username, from_name: fromName ?? null }, seal(key!, password, binding(user.userId, 'smtp')))
  } catch {
    code = 'mail_save'
  }
  revalidatePath('/app')
  if (code) back(code)
  done('mail')
}

export const disconnectEmail = async (): Promise<void> => {
  const user = await signedIn().catch(() => null)
  if (!user) redirect('/login?next=/app')
  let failed = false
  try {
    await removeMailConnection(user.sb)
  } catch {
    failed = true
  }
  revalidatePath('/app')
  back(failed ? 'mail_save' : undefined)
}

const clientSchema = z.object({ client_id: z.string().min(1).max(128) })

// Disconnect an app: its consent, sessions and refresh tokens are revoked by Supabase Auth.
export const disconnectApp = async (formData: FormData): Promise<void> => {
  const parsed = clientSchema.safeParse({ client_id: formData.get('client_id') })
  if (!parsed.success) back('input')
  const user = await signedIn().catch(() => null)
  if (!user) redirect('/login?next=/app')
  let failed = false
  try {
    const { error } = await user.sb.auth.oauth.revokeGrant({ clientId: parsed.data!.client_id })
    failed = Boolean(error)
  } catch {
    failed = true
  }
  revalidatePath('/app')
  back(failed ? 'disconnect' : undefined)
}

const zoneSchema = z.object({ timezone: z.string().min(1).max(64).refine(isValidTimeZone) })

export const saveTimeZone = async (formData: FormData): Promise<void> => {
  const parsed = zoneSchema.safeParse({ timezone: formData.get('timezone') })
  if (!parsed.success) back('zone')
  const user = await signedIn().catch(() => null)
  if (!user) redirect('/login?next=/app')
  let failed = false
  try {
    await setProfile(user.sb, { timezone: parsed.data!.timezone })
  } catch {
    failed = true
  }
  revalidatePath('/app')
  back(failed ? 'zone' : undefined)
}

// Start linking Telegram: a one-time code, then off to the bot, which receives it when the person presses Start.
export const connectTelegram = async (): Promise<void> => {
  const bot = channelEnv().botUsername
  if (!bot) back('phone')
  const user = await signedIn().catch(() => null)
  if (!user) redirect('/login?next=/app')
  let code: string | null = null
  try {
    code = await createLinkCode(user.sb)
  } catch {
    code = null
  }
  if (!code) back('phone')
  redirect(`https://t.me/${bot}?start=${code}`)
}

export const disconnectPhone = async (): Promise<void> => {
  const user = await signedIn().catch(() => null)
  if (!user) redirect('/login?next=/app')
  let failed = false
  try {
    await unlinkPhone(user.sb)
  } catch {
    failed = true
  }
  revalidatePath('/app')
  back(failed ? 'phone' : undefined)
}

const keySchema = z.object({
  name: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  host: z.string().max(253).refine(isHost),
  scheme: z.enum(['bearer', 'basic', 'header']),
  header: z.string().max(64).optional(),
  key: z.string().min(8).max(2000),
  writes: z.enum(['never', 'ask']),
})

// Accepts "api.example.com" or a pasted address like "https://api.example.com/v1/": only the host is kept.
const hostOf = (raw: string): string => raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '')

// Save an API key with the one host it may be sent to. It is sealed and never shown again, to anyone.
export const connectApiKey = async (formData: FormData): Promise<void> => {
  const vault = vaultKey()
  if (!vault) back('mail_off')
  const parsed = keySchema.safeParse({
    name: String(formData.get('name') ?? '').trim().toLowerCase(),
    host: hostOf(String(formData.get('host') ?? '')),
    scheme: formData.get('scheme'),
    header: String(formData.get('header') ?? '').trim() || undefined,
    key: String(formData.get('key') ?? '').trim(),
    writes: formData.get('writes') === 'ask' ? 'ask' : 'never',
  })
  if (!parsed.success) back('key_input')
  const { name, host, header, key, writes } = parsed.data!
  const scheme: Scheme = parsed.data!.scheme
  if (!isKeyValue(key, scheme) || (scheme === 'header' && (!header || !isHeaderName(header)))) back('key_input')
  const user = await signedIn().catch(() => null)
  if (!user) redirect('/login?next=/app')
  let failed = false
  try {
    const meta = { host, scheme, ...(scheme === 'header' && header ? { header } : {}), writes }
    await saveApiKey(user.sb, name, meta, seal(vault!, key, binding(user.userId, `api:${name}`)))
  } catch {
    failed = true
  }
  revalidatePath('/app')
  if (failed) back('key_save')
  done('key')
}

const nameSchema = z.object({ name: z.string().regex(/^[a-z0-9_-]{1,40}$/) })

export const disconnectApiKey = async (formData: FormData): Promise<void> => {
  const parsed = nameSchema.safeParse({ name: formData.get('name') })
  if (!parsed.success) back('input')
  const user = await signedIn().catch(() => null)
  if (!user) redirect('/login?next=/app')
  let failed = false
  try {
    await removeApiKey(user.sb, parsed.data!.name)
  } catch {
    failed = true
  }
  revalidatePath('/app')
  back(failed ? 'key_save' : undefined)
}

const levelSchema = z.object({ level: z.enum(['off', 'api', 'all']) })

export const savePrivacy = async (formData: FormData): Promise<void> => {
  const parsed = levelSchema.safeParse({ level: formData.get('level') })
  if (!parsed.success) back('input')
  const user = await signedIn().catch(() => null)
  if (!user) redirect('/login?next=/app')
  let failed = false
  try {
    await setMaskLevel(user.sb, parsed.data!.level)
  } catch {
    failed = true
  }
  revalidatePath('/app')
  if (failed) back('privacy')
  done('privacy')
}
