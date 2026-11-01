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

// "SEND APPROVED #24 (gmail to ...)" → 24
export const approvalIdFromTitle = (title: string): number | null => {
  const m = /^SEND APPROVED #(\d+)\b/.exec(title)
  return m ? Number(m[1]) : null
}
