import { describe, expect, test } from 'bun:test'
import { handleUpdate, type BotDeps } from '../lib/bot'
import type { Snapshot } from '../lib/channel-db'
import type { SendOutcome } from '../lib/sender'
import { parseButton, parseText, sameSecret, type Button, type Update } from '../lib/telegram'
import type { Approval } from '../lib/types'

const CHAT = 4242
const NOW = new Date('2026-11-10T06:30:00Z') // 12:00 in Kolkata

const draft = (id: number, over: Partial<Approval> = {}): Approval => ({
  id,
  task_id: null,
  channel: 'email',
  recipient: 'priya@example.com',
  subject: 'Hello',
  draft: `Hello, draft ${id}`,
  status: 'pending',
  result: null,
  send_after: null,
  created_at: NOW.toISOString(),
  decided_at: null,
  ...over,
})

interface Sent {
  chatId: string
  text: string
  buttons?: Button[][]
}

const harness = (snap: Snapshot | null, opts: { claim?: boolean; decideError?: string; channel?: string; sent?: SendOutcome } = {}) => {
  const autoSent: Array<[string, number]> = []
  const sent: Sent[] = []
  const edits: string[] = []
  const answers: string[] = []
  const decided: Array<[string, number, string]> = []
  const deps: BotDeps = {
    siteUrl: 'https://aos.test',
    now: () => NOW,
    send: async (chatId, text, buttons) => {
      sent.push({ chatId, text, buttons })
    },
    edit: async (_c, _m, text) => {
      edits.push(text)
    },
    answer: async (_id, text) => {
      answers.push(text)
    },
    claim: async () => opts.claim ?? false,
    snapshot: async () => snap,
    decide: async (chatId, id, decision) => {
      if (opts.decideError) throw new Error(opts.decideError)
      decided.push([chatId, id, decision])
      return draft(id, { status: decision, channel: opts.channel ?? 'email' })
    },
    autoSend: async (chatId, id) => {
      autoSent.push([chatId, id])
      return opts.sent ?? { kind: 'skipped', reason: 'no email connection' }
    },
  }
  return { deps, sent, edits, answers, decided, autoSent }
}

const msg = (text: string, type = 'private'): Update => ({
  update_id: 1,
  message: { chat: { id: CHAT, type }, from: { username: 'priya' }, text },
})

const button = (data: string): Update => ({
  update_id: 2,
  callback_query: { id: 'cb1', data, message: { message_id: 9, chat: { id: CHAT, type: 'private' }, text: 'Draft #5 · email' } },
})

const SNAP: Snapshot = {
  timezone: 'Asia/Kolkata',
  tasks: [
    {
      id: 1, title: 'Call the CA', area: 'general', owner: 'me', status: 'todo', due_at: '2026-11-10T09:00:00Z', recur: null,
      notes: null, goal_id: null, parent_id: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    },
  ],
  approvals: [draft(5), draft(6)],
  goals: [],
  events: [{ id: 3, title: 'Demo with Ravi', area: 'general', starts_at: '2026-11-10T10:00:00Z', ends_at: null, location: null, notes: null }],
}

describe('reading what the person typed', () => {
  test('commands and yes/no', () => {
    expect(parseText('/start abc')).toEqual({ kind: 'link', code: 'abc' })
    expect(parseText('/start')).toEqual({ kind: 'start' })
    expect(parseText('/today')).toEqual({ kind: 'today' })
    expect(parseText('today')).toEqual({ kind: 'today' })
    expect(parseText('/drafts@aos_bot')).toEqual({ kind: 'drafts' })
    expect(parseText('yes 12')).toEqual({ kind: 'decide', id: 12, decision: 'approved' })
    expect(parseText('No #7')).toEqual({ kind: 'decide', id: 7, decision: 'rejected' })
    expect(parseText('yes please')).toEqual({ kind: 'help' })
    expect(parseText('maybe 12')).toEqual({ kind: 'help' })
  })

  test('buttons', () => {
    expect(parseButton('a:5')).toEqual({ id: 5, decision: 'approved' })
    expect(parseButton('r:5')).toEqual({ id: 5, decision: 'rejected' })
    expect(parseButton('x:5')).toBeNull()
    expect(parseButton('a:5; drop')).toBeNull()
    expect(parseButton(undefined)).toBeNull()
  })

  test('the webhook secret is compared exactly', () => {
    expect(sameSecret('s3cret-value', 's3cret-value')).toBe(true)
    expect(sameSecret('s3cret-valuX', 's3cret-value')).toBe(false)
    expect(sameSecret('short', 's3cret-value')).toBe(false)
    expect(sameSecret(null, 's3cret-value')).toBe(false)
  })
})

describe('the bot', () => {
  test('links with a good code and says so; a bad code gets a way back', async () => {
    const ok = harness(null, { claim: true })
    await handleUpdate(msg('/start abc'), ok.deps)
    expect(ok.sent[0].text).toStartWith('Linked.')
    const bad = harness(null, { claim: false })
    await handleUpdate(msg('/start abc'), bad.deps)
    expect(bad.sent[0].text).toContain('https://aos.test/app')
  })

  test('an unlinked chat is told how to link', async () => {
    const h = harness(null)
    await handleUpdate(msg('/today'), h.deps)
    expect(h.sent[0].text).toContain('not linked')
  })

  test('/today shows the day in the person\'s zone, without markdown stars', async () => {
    const h = harness(SNAP)
    await handleUpdate(msg('/today'), h.deps)
    const text = h.sent[0].text
    expect(text).toContain('Call the CA')
    expect(text).toContain('Demo with Ravi')
    expect(text).toContain('approval #5')
    expect(text).not.toContain('**')
  })

  test('/drafts sends each draft with its own buttons', async () => {
    const h = harness(SNAP)
    await handleUpdate(msg('/drafts'), h.deps)
    expect(h.sent.length).toBe(2)
    expect(h.sent[0].text).toContain('Hello, draft 5')
    expect(h.sent[0].buttons?.[0].map((b) => b.callback_data)).toEqual(['a:5', 'r:5'])
  })

  test('a button press decides, answers and closes the buttons', async () => {
    const h = harness(SNAP)
    await handleUpdate(button('a:5'), h.deps)
    expect(h.decided).toEqual([[String(CHAT), 5, 'approved']])
    expect(h.answers).toEqual(['Approved'])
    expect(h.edits[0]).toContain('approved')
  })

  test('a yes on an email sends it when a mailbox is connected, and says so', async () => {
    const h = harness(SNAP, { sent: { kind: 'sent', to: 'priya@example.com' } })
    await handleUpdate(button('a:5'), h.deps)
    expect(h.autoSent).toEqual([[String(CHAT), 5]])
    expect(h.edits[0]).toContain('approved and sent to priya@example.com')
  })

  test('a yes with no mailbox connected keeps the old wording', async () => {
    const h = harness(SNAP)
    await handleUpdate(msg('yes 5'), h.deps)
    expect(h.sent[0].text).toContain('Your assistant sends it')
  })

  test('a failed send says the draft is still approved', async () => {
    const h = harness(SNAP, { sent: { kind: 'not_sent', reason: 'your mail provider refused the login' } })
    await handleUpdate(msg('yes 5'), h.deps)
    expect(h.sent[0].text).toContain('not sent: your mail provider refused the login')
    expect(h.sent[0].text).toContain('still approved')
  })

  test('a no, or a yes on something that is not an email, never sends', async () => {
    const no = harness(SNAP, { sent: { kind: 'sent', to: 'x@example.com' } })
    await handleUpdate(button('r:5'), no.deps)
    expect(no.autoSent).toEqual([])
    const post = harness(SNAP, { channel: 'linkedin-post', sent: { kind: 'sent', to: 'x@example.com' } })
    await handleUpdate(button('a:5'), post.deps)
    expect(post.autoSent).toEqual([])
  })

  test('"no 6" rejects', async () => {
    const h = harness(SNAP)
    await handleUpdate(msg('no 6'), h.deps)
    expect(h.decided).toEqual([[String(CHAT), 6, 'rejected']])
    expect(h.sent[0].text).toContain('rejected')
  })

  test('only our own error messages reach the chat', async () => {
    const known = harness(SNAP, { decideError: 'Draft 9 not found or already decided' })
    await handleUpdate(msg('yes 9'), known.deps)
    expect(known.sent[0].text).toBe('Draft 9 not found or already decided')
    const internal = harness(SNAP, { decideError: 'relation "public.approvals" does not exist' })
    await handleUpdate(msg('yes 9'), internal.deps)
    expect(internal.sent[0].text).not.toContain('relation')
  })

  test('group chats are ignored', async () => {
    const h = harness(SNAP)
    await handleUpdate(msg('/today', 'group'), h.deps)
    await handleUpdate(msg('yes 5', 'supergroup'), h.deps)
    expect(h.sent).toEqual([])
    expect(h.decided).toEqual([])
  })
})
