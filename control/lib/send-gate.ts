// Deterministic pre-send gate (idea from ethanplusai/harvey): before the runner starts a
// "SEND APPROVED #N" task, the approved draft is checked with plain rules, no model. A draft that
// fails is never handed to Claude to send; Ayush gets the reasons on Discord instead.
// Drafts often start with an internal header ("... this header is not part of the email") and a
// marker line (EMAIL BODY:, REPLY:, BODY:, DM:), so the checks read only what would be sent.

const BODY_MARKERS = /^(?:EMAIL BODY|BODY|REPLY|DM|MESSAGE|POST|COMMENT|NOTE TEXT)\s*:\s*$/im

// What actually goes out: the text after the last body marker, else the draft minus a first
// paragraph flagged as not part of the message.
export const sendableText = (draft: string): string => {
  const text = draft.replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  let lastMarker = -1
  lines.forEach((l, i) => {
    if (BODY_MARKERS.test(l.trim())) lastMarker = i
  })
  if (lastMarker >= 0) return lines.slice(lastMarker + 1).join('\n').trim()
  const paras = text.split(/\n\s*\n/)
  if (paras.length > 1 && /not part of the|JUDGMENT CALL|NEW ACCEPT|^NOTE\b/i.test(paras[0])) {
    return paras.slice(1).join('\n\n').trim()
  }
  return text.trim()
}

// Longest body we expect per channel (characters). Real limits are higher; these catch a pasted
// thread or a doubled draft.
const MAX_CHARS: Record<string, number> = {
  'linkedin-dm': 1500,
  'linkedin-connect': 300,
  'linkedin-comment': 1250,
  'linkedin-post': 3000,
  indiehackers: 2000,
  reddit: 6000,
  gmail: 3000,
  whatsapp: 1500,
}

const UNFILLED = [
  /\{\{[^}]*\}\}/, // {{first_name}}
  /\{(?:first_?name|name|company|role|title|link|url)\}/i,
  /\[(?:first ?name|name|company|role|link|insert[^\]]*|your [^\]]*)\]/i,
  /<(?:name|first name|company|link)>/i,
  /\b(?:TODO|TBD|FIXME|XXX|lorem ipsum)\b/,
]

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i

export interface GateResult {
  ok: boolean
  reasons: string[]
}

export const checkSend = (channel: string, recipient: string | null, draft: string): GateResult => {
  const reasons: string[] = []
  const body = sendableText(draft)
  const ch = channel.toLowerCase()

  if (!body) reasons.push('the message body is empty')
  for (const re of UNFILLED) {
    const m = body.match(re)
    if (m) reasons.push(`unfilled placeholder "${m[0]}"`)
  }
  if (body.includes('—')) reasons.push('contains an em dash (house rule: none in copy)')
  const max = MAX_CHARS[ch]
  if (max && body.length > max) reasons.push(`${body.length} characters, over the ${max} cap for ${ch}`)
  const links = body.match(/https?:\/\/\S+/g) ?? []
  if (links.length > 2) reasons.push(`${links.length} links (max 2)`)

  const to = recipient ?? ''
  if (ch === 'gmail' && !EMAIL.test(to)) reasons.push('gmail recipient has no email address')
  if (ch.startsWith('linkedin-dm') && !/linkedin\.com\/(?:in|messaging\/thread)\/|existing linkedin thread|existing thread/i.test(to)) {
    reasons.push('linkedin-dm recipient has no profile URL or thread')
  }
  if (ch === 'reddit' && !/\br\/\w+|\bu\/\w+|reddit\.com\//i.test(to)) reasons.push('reddit recipient names no subreddit or user')

  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] }
}

// Scheduled sends: an approval with send_after in the future must not go out before it. Returns that time
// when the send has to wait, else null (no schedule, or the time has come).
export const waitUntil = (sendAfter: string | null | undefined, nowMs: number): Date | null => {
  if (!sendAfter) return null
  const t = new Date(sendAfter)
  return Number.isNaN(t.getTime()) || t.getTime() <= nowMs ? null : t
}

// The send time, from the approval's send_after column or, until that is set everywhere, a header line in the
// draft ("Send after: 2026-11-05T09:30:00+05:30"). The header is outside the sendable body.
const SEND_AFTER_LINE = /^\s*send after\s*:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))\s*$/im

export const sendAfterOf = (approval: { send_after?: string | null; draft: string }): string | null => {
  if (approval.send_after) return approval.send_after
  const header = approval.draft.replace(sendableText(approval.draft), '')
  return SEND_AFTER_LINE.exec(header)?.[1] ?? null
}

// A LinkedIn post draft holds the post and, after a "FIRST COMMENT:" line, the comment with the links.
export const splitPost = (body: string): { post: string; comment: string | null } => {
  const m = /^\s*FIRST COMMENT\s*:\s*$/im.exec(body)
  if (!m) return { post: body.trim(), comment: null }
  return { post: body.slice(0, m.index).trim(), comment: body.slice(m.index + m[0].length).trim() || null }
}

// "SEND APPROVED #24 (gmail to ...)" → 24
export const approvalIdFromTitle = (title: string): number | null => {
  const m = /^SEND APPROVED #(\d+)\b/.exec(title)
  return m ? Number(m[1]) : null
}

// A note on the send task or its parent saying hold / held / "don't send" stops the send. Checked right before
// the runner starts the send, so a hold added after approval still wins.
const HOLD = /\b(?:on\s+hold|hold|held)\b|\bdon['’]?t\s+send\b|\bdo\s+not\s+send\b/i

export const holdReason = (notes: { id: number; notes: string | null }[]): string | null => {
  for (const t of notes) {
    const line = (t.notes ?? '').split('\n').find((l) => HOLD.test(l))
    if (line) return `task #${t.id} notes say hold: "${line.trim().slice(0, 120)}"`
  }
  return null
}

// Public posts, reposts and comments go to no one in particular, so they are not touches.
const isBroadcast = (ch: string, to: string): boolean =>
  /post|repost|comment|indiehackers/.test(ch) || (ch === 'reddit' && !/\bu\/\w+/i.test(to))

// Every handle we can see for the person (LinkedIn profile, LinkedIn thread, email, Reddit user, name), so
// touches add up even when one approval names a profile URL and the next only a thread or a name.
// The recipient field comes first; with no recipient, the draft's header (the part not sent) is used.
export const recipientKeys = (channel: string, recipient: string | null, draft = ''): string[] => {
  const ch = channel.toLowerCase()
  const to = recipient ?? ''
  if (isBroadcast(ch, to)) return []
  const handles = (text: string): string[] => {
    const li = /linkedin\.com\/in\/([A-Za-z0-9%_-]+)/i.exec(text)
    const thread = /linkedin\.com\/messaging\/thread\/([A-Za-z0-9%=_-]+)/i.exec(text)
    const email = EMAIL.exec(text)
    const reddit = /\bu\/([A-Za-z0-9_-]+)/i.exec(text)
    return [
      li && `linkedin:${li[1].toLowerCase()}`,
      thread && `linkedin-thread:${thread[1]}`,
      email && `email:${email[0].toLowerCase()}`,
      reddit && `reddit:${reddit[1].toLowerCase()}`,
    ].filter((k): k is string => Boolean(k))
  }
  // "Dr Surya Prakash (Crown Vet CMO), existing thread" → name:surya prakash
  const name = to
    .split(/[,(<|]| - | – |https?:\/\//)[0]
    .trim()
    .toLowerCase()
    .replace(/^(?:dr|mr|mrs|ms|prof)\.?\s+/, '')
    .replace(/\s+/g, ' ')
  const named = name && !/^(?:existing|same|their|his|her)\b|^[ur]\//.test(name) && !EMAIL.test(name) ? [`name:${name}`] : []
  const keys = [...handles(to), ...named]
  if (keys.length) return [...new Set(keys)]
  return handles(draft.replace(sendableText(draft), ''))
}

export const MAX_TOUCHES = 2

// priorTouches = approvals already sent to this person (not counting this one).
export const touchReason = (keys: string[], priorTouches: number): string | null =>
  keys.length && priorTouches >= MAX_TOUCHES
    ? `${keys[0]} already has ${priorTouches} touches; a third is blocked (one-DM rule)`
    : null
