// Runs the real migration on an in-process Postgres (PGlite) and attacks it the way a signed-in user or a
// connected AI app could: with a valid token, straight at the database, without our server in between.
import { beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { randomBytes } from 'node:crypto'
import { binding, seal } from '../lib/vault'
import { ACTIVITY_COLS, APPROVAL_COLS, EVENT_COLS, GOAL_COLS, TASK_COLS } from '../lib/types'

const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'
const APP = 'a0000000-0000-4000-8000-00000000000a' // an OAuth client id, as in a token issued to Claude or ChatGPT

// The parts of a Supabase project the migration relies on: roles, the auth schema and its two helpers.
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  insert into auth.users (id) values ('${ALICE}'), ('${BOB}');
`

let pg: PGlite

type Row = Record<string, unknown>

interface Who {
  sub?: string
  clientId?: string
  role?: 'authenticated' | 'anon' | 'service_role'
}

// Run one statement as a given token would: the API sets the role and the claims, then runs the query.
const as = async (who: Who, sql: string, params: unknown[] = []): Promise<Row[]> => {
  const claims = JSON.stringify({ sub: who.sub, role: who.role ?? 'authenticated', client_id: who.clientId })
  await pg.query(`select set_config('request.jwt.claims', $1, false)`, [claims])
  await pg.exec(`set role ${who.role ?? 'authenticated'}`)
  try {
    return (await pg.query<Row>(sql, params)).rows
  } finally {
    await pg.exec('reset role')
    await pg.query(`select set_config('request.jwt.claims', '', false)`)
  }
}

const alice: Who = { sub: ALICE }
const bob: Who = { sub: BOB }
const aliceApp: Who = { sub: ALICE, clientId: APP }

const fails = async (p: Promise<unknown>, pattern: RegExp): Promise<void> => {
  let message = ''
  try {
    await p
  } catch (e) {
    message = e instanceof Error ? e.message : String(e)
  }
  expect(message).toMatch(pattern)
}

beforeAll(async () => {
  pg = new PGlite()
  await pg.exec(SUPABASE_STUB)
  const dir = join(import.meta.dir, '..', 'supabase', 'migrations')
  for (const file of readdirSync(dir).sort()) await pg.exec(readFileSync(join(dir, file), 'utf8'))
})

describe('isolation between users', () => {
  let aliceTask = 0

  test('a user sees only their own rows', async () => {
    const [t] = await as(alice, `insert into tasks (title) values ('Call the accountant') returning id, user_id`)
    aliceTask = Number(t.id)
    expect(t.user_id).toBe(ALICE)
    await as(bob, `insert into tasks (title) values ('Bob task')`)
    expect((await as(alice, 'select title from tasks')).map((r) => r.title)).toEqual(['Call the accountant'])
    expect((await as(bob, 'select title from tasks')).map((r) => r.title)).toEqual(['Bob task'])
  })

  test('a user cannot change, soft-delete or read another user row by id', async () => {
    expect(await as(bob, `update tasks set title = 'hacked' where id = $1 returning id`, [aliceTask])).toEqual([])
    expect(await as(bob, `update tasks set deleted_at = now() where id = $1 returning id`, [aliceTask])).toEqual([])
    expect(await as(bob, 'select id from tasks where id = $1', [aliceTask])).toEqual([])
    expect((await as(alice, 'select title, deleted_at from tasks where id = $1', [aliceTask]))[0]).toEqual({
      title: 'Call the accountant',
      deleted_at: null,
    })
  })

  test('a user cannot write a row as someone else, or hand a row over', async () => {
    await fails(as(bob, `insert into tasks (title, user_id) values ('planted', $1)`, [ALICE]), /row-level security/)
    await fails(as(alice, `update tasks set user_id = $1 where id = $2`, [BOB, aliceTask]), /row-level security/)
  })

  test('a row cannot point at another user task or goal', async () => {
    await fails(
      as(bob, `insert into approvals (channel, draft, task_id) values ('email', 'hi', $1)`, [aliceTask]),
      /foreign key/,
    )
    const [g] = await as(alice, `insert into goals (title, target) values ('Ten orders', 10) returning id`)
    await fails(as(bob, `insert into tasks (title, goal_id) values ('ride along', $1)`, [g.id]), /foreign key/)
    await fails(as(bob, `select * from record_goal_reading($1, 99)`, [g.id]), /not found/)
  })

  test('nobody can hard-delete, and a signed-out caller gets nothing', async () => {
    await fails(as(alice, 'delete from tasks where id = $1', [aliceTask]), /permission denied/)
    await fails(as({ role: 'anon' }, 'select * from tasks'), /permission denied/)
    await fails(as({ role: 'anon' }, `insert into tasks (title) values ('anon task')`), /permission denied/)
  })

  test('functions act only on the caller rows', async () => {
    await fails(as(bob, `select * from complete_task($1, 'done')`, [aliceTask]), /not found/)
    expect((await as(alice, 'select status from tasks where id = $1', [aliceTask]))[0].status).toBe('todo')
  })
})

describe('the approval guard', () => {
  const draft = async (who: Who, text = 'Hello, following up on the quote.'): Promise<number> => {
    const [ap] = await as(who, `select id from request_approval('email', $1, 'client@example.com')`, [text])
    return Number(ap.id)
  }

  test('a connected app can draft but never approve, by function or by direct update', async () => {
    const id = await draft(aliceApp)
    await fails(as(aliceApp, `select * from decide_approval($1, 'approved')`, [id]), /Only the person can approve/)
    await fails(as(aliceApp, `update approvals set status = 'approved' where id = $1`, [id]), /Only the person can approve/)
    await fails(as(aliceApp, `update approvals set status = 'rejected' where id = $1`, [id]), /Only the person can approve/)
    expect((await as(alice, 'select status from approvals where id = $1', [id]))[0].status).toBe('pending')
  })

  test('a draft cannot be born approved', async () => {
    const [ap] = await as(
      aliceApp,
      `insert into approvals (channel, draft, status, decided_at) values ('email', 'sneaky', 'approved', now()) returning status, decided_at`,
    )
    expect(ap).toEqual({ status: 'pending', decided_at: null })
  })

  test('an app cannot mark an unapproved draft as sent', async () => {
    const id = await draft(aliceApp)
    await fails(as(aliceApp, `select * from mark_approval_sent($1, 'sent it')`, [id]), /Only an approved draft/)
    await fails(as(aliceApp, `update approvals set status = 'sent' where id = $1`, [id]), /Only an approved draft/)
  })

  test('the person approves; the approved text is then frozen', async () => {
    const id = await draft(aliceApp, 'Original text')
    const [ap] = await as(alice, `select status, draft, decided_at from decide_approval($1, 'approved', 'Edited by Alice')`, [id])
    expect(ap.status).toBe('approved')
    expect(ap.draft).toBe('Edited by Alice')
    expect(ap.decided_at).not.toBeNull()
    await fails(as(aliceApp, `update approvals set draft = 'swapped after approval' where id = $1`, [id]), /Only a pending draft/)
    await fails(as(aliceApp, `update approvals set recipient = 'other@example.com' where id = $1`, [id]), /Only a pending draft/)
    await fails(as(alice, `select * from decide_approval($1, 'rejected')`, [id]), /already decided/)
    await fails(as(alice, `update approvals set status = 'pending' where id = $1`, [id]), /cannot go back/)
  })

  test('sending an approved draft logs it and closes its task', async () => {
    const [t] = await as(alice, `insert into tasks (title, area) values ('Send the quote', 'sales') returning id`)
    const [ap] = await as(aliceApp, `select id from request_approval('email', 'Quote attached.', 'client@example.com', $1)`, [t.id])
    expect((await as(alice, 'select status from tasks where id = $1', [t.id]))[0].status).toBe('waiting_approval')
    await as(alice, `select * from decide_approval($1, 'approved')`, [ap.id])
    const [sent] = await as(aliceApp, `select status, result from mark_approval_sent($1, 'Sent from Gmail 10:02')`, [ap.id])
    expect(sent).toEqual({ status: 'sent', result: 'Sent from Gmail 10:02' })
    expect((await as(alice, 'select status from tasks where id = $1', [t.id]))[0].status).toBe('done')
    const log = await as(alice, `select area, channel, account, action from activity where task_id = $1`, [t.id])
    expect(log).toEqual([{ area: 'sales', channel: 'email', account: 'client@example.com', action: `sent (approval ${ap.id})` }])
  })

  test('a rejected draft frees its task', async () => {
    const [t] = await as(alice, `insert into tasks (title) values ('Post the update') returning id`)
    const [ap] = await as(aliceApp, `select id from request_approval('linkedin-post', 'Big news', null, $1)`, [t.id])
    await as(alice, `select * from decide_approval($1, 'rejected')`, [ap.id])
    expect((await as(alice, 'select status from tasks where id = $1', [t.id]))[0].status).toBe('todo')
  })

  test('one user cannot decide another user draft', async () => {
    const id = await draft(aliceApp)
    await fails(as(bob, `select * from decide_approval($1, 'approved')`, [id]), /not found/)
  })
})

describe('tasks and goals', () => {
  test('closing a recurring task creates the next one in the same series', async () => {
    const [t] = await as(
      alice,
      `insert into tasks (title, due_at, recur, owner) values ('Check the inbox', '2026-11-10T04:30:00Z', 'daily', 'assistant') returning id`,
    )
    const rows = await as(alice, `select id, status, due_at, recur, parent_id, owner from complete_task($1, 'done', 'nothing new', '2026-11-11T04:30:00Z')`, [t.id])
    expect(rows).toHaveLength(2)
    expect(rows[0].status).toBe('done')
    expect(rows[1]).toMatchObject({ status: 'todo', recur: 'daily', owner: 'assistant' })
    expect(Number(rows[1].parent_id)).toBe(Number(t.id))
    expect(new Date(String(rows[1].due_at)).toISOString()).toBe('2026-11-11T04:30:00.000Z')
    await fails(as(alice, `select * from complete_task($1, 'done')`, [t.id]), /already closed/)
  })

  test('a recurring task needs a due time and a valid pattern', async () => {
    await fails(as(alice, `insert into tasks (title, recur) values ('No date', 'daily')`), /check constraint/)
    await fails(as(alice, `insert into tasks (title, recur, due_at) values ('Bad', 'hourly', now())`), /check constraint/)
  })

  test('a goal reading keeps history and marks the goal met at target', async () => {
    const [g] = await as(alice, `insert into goals (title, target, unit) values ('Five paying clients', 5, 'clients') returning id`)
    expect((await as(alice, `select current, status from record_goal_reading($1, 2, 'two signed')`, [g.id]))[0]).toMatchObject({ status: 'active' })
    expect((await as(alice, `select status from record_goal_reading($1, 5)`, [g.id]))[0].status).toBe('met')
    expect(await as(alice, 'select count(*)::int as n from goal_readings where goal_id = $1', [g.id])).toEqual([{ n: 2 }])
  })

  test('oversized text is refused by the database itself', async () => {
    await fails(as(alice, `insert into tasks (title) values ($1)`, ['x'.repeat(301)]), /check constraint/)
    await fails(as(alice, `insert into approvals (channel, draft) values ('email', $1)`, ['x'.repeat(5001)]), /check constraint/)
  })
})

describe('limits', () => {
  test('a row quota stops one user filling a table', async () => {
    await as(bob, `insert into goals (title, target) select 'Goal ' || n, 1 from generate_series(1, 200) n`)
    await fails(as(bob, `insert into goals (title, target) values ('One too many', 1)`), /Limit reached/)
    // another user is not affected
    await as(alice, `insert into goals (title, target) values ('Still fine', 1)`)
  })

  test('the rate limit counts per user and cannot be read or reset by the user', async () => {
    const hit = async (who: Who): Promise<boolean> => Boolean((await as(who, `select hit_rate('mcp', 3, 3600) as ok`))[0].ok)
    expect([await hit(alice), await hit(alice), await hit(alice)]).toEqual([true, true, true])
    expect(await hit(alice)).toBe(false)
    expect(await hit(bob)).toBe(true)
    await fails(as(alice, 'select * from rate_hits'), /permission denied/)
    await fails(as(alice, 'update rate_hits set hits = 0'), /permission denied/)
    expect(Boolean((await as({ role: 'authenticated' }, `select hit_rate('mcp', 3, 3600) as ok`))[0].ok)).toBe(false)
  })
})

// The data library talks to the database by name. A renamed column or function argument would only show up in
// production, so check every name the code uses against the real schema.
describe('the phone channel', () => {
  // the bot's webhook, calling with the server's secret key
  const server: Who = { role: 'service_role' }
  const CHAT = '700100'
  let code = ''

  const snapshot = async (chat: string): Promise<Record<string, unknown> | null> =>
    (await as(server, `select channel_snapshot('telegram', $1, now() - interval '1 day', now() + interval '1 day') as s`, [chat]))[0]
      .s as Record<string, unknown> | null

  test('only the person, signed in on the site, can make a link code', async () => {
    await fails(as(aliceApp, `select create_link_code('telegram')`), /assistant cannot/)
    await fails(as({ role: 'anon' }, `select create_link_code('telegram')`), /permission denied/)
    await fails(as(alice, `select create_link_code('sms')`), /Unknown channel/)
    code = String((await as(alice, `select create_link_code('telegram') as c`))[0].c)
    expect(code).toMatch(/^[0-9a-f]{64}$/)
    await fails(as(alice, 'select * from link_codes'), /permission denied/)
  })

  test('users and apps cannot call the bot functions', async () => {
    await fails(as(bob, `select channel_claim('telegram', $1, '999', null)`, [code]), /permission denied/)
    await fails(as(aliceApp, `select channel_decide('telegram', $1, 1, 'approved')`, [CHAT]), /permission denied/)
    await fails(as(alice, `select channel_snapshot('telegram', $1, now(), now())`, [CHAT]), /permission denied/)
    await fails(as(server, `select channel_user('telegram', $1)`, [CHAT]), /permission denied/)
  })

  test('a code links one chat, once', async () => {
    expect(await snapshot(CHAT)).toBeNull()
    expect((await as(server, `select channel_claim('telegram', 'nope', $1, null) as ok`, [CHAT]))[0].ok).toBe(false)
    expect((await as(server, `select channel_claim('telegram', $1, $2, 'Alice') as ok`, [code, CHAT]))[0].ok).toBe(true)
    expect((await as(server, `select channel_claim('telegram', $1, '700999', null) as ok`, [code]))[0].ok).toBe(false)
    expect((await as(alice, `select channel, label from channel_links where deleted_at is null`))).toEqual([{ channel: 'telegram', label: 'Alice' }])
    expect(await as(bob, 'select id from channel_links')).toEqual([])
    expect(await as(bob, 'select external_id from channel_links')).toEqual([])
  })

  test('the linked chat sees only its own person', async () => {
    const snap = await snapshot(CHAT)
    const tasks = snap?.tasks as Array<Record<string, unknown>>
    expect(tasks.length).toBeGreaterThan(0)
    for (const t of tasks) expect(t.user_id).toBeUndefined()
    const bobTitles = (await as(bob, 'select title from tasks')).map((r) => r.title)
    for (const t of tasks) expect(bobTitles).not.toContain(t.title)
  })

  test('yes from the linked chat decides that person\'s draft, and nobody else\'s', async () => {
    const [mine] = await as(aliceApp, `select (request_approval('email', 'Hi from the phone test')).id as id`)
    const [theirs] = await as(bob, `select (request_approval('email', 'Bob draft')).id as id`)
    const decided = (await as(server, `select channel_decide('telegram', $1, $2, 'approved') as a`, [CHAT, mine.id]))[0].a as Record<string, unknown>
    expect(decided.status).toBe('approved')
    expect(decided.user_id).toBeUndefined()
    await fails(as(server, `select channel_decide('telegram', $1, $2, 'approved')`, [CHAT, mine.id]), /already decided/)
    await fails(as(server, `select channel_decide('telegram', $1, $2, 'approved')`, [CHAT, theirs.id]), /not found/)
    await fails(as(server, `select channel_decide('telegram', '123', $1, 'approved')`, [theirs.id]), /not linked/)
    expect((await as(bob, 'select status from approvals where id = $1', [theirs.id]))[0].status).toBe('pending')
  })

  test('the person can unlink but not relink by hand', async () => {
    await fails(as(alice, `update channel_links set label = 'x'`), /permission denied/)
    await as(alice, 'update channel_links set deleted_at = now() where deleted_at is null')
    expect(await snapshot(CHAT)).toBeNull()
    const relinked = await as(alice, 'update channel_links set deleted_at = null returning id')
    expect(relinked).toEqual([])
  })

  test('linking the same chat to a new person moves it', async () => {
    const aliceCode = String((await as(alice, `select create_link_code('telegram') as c`))[0].c)
    const bobCode = String((await as(bob, `select create_link_code('telegram') as c`))[0].c)
    await as(server, `select channel_claim('telegram', $1, $2, null)`, [aliceCode, CHAT])
    await as(server, `select channel_claim('telegram', $1, $2, null)`, [bobCode, CHAT])
    expect(await as(alice, 'select id from channel_links where deleted_at is null')).toEqual([])
    expect((await as(bob, 'select id from channel_links where deleted_at is null')).length).toBe(1)
  })
})

describe('the vault and the sealed send', () => {
  const server: Who = { role: 'service_role' }
  const sealed = seal(randomBytes(32), 'app-password-SECRET', binding(ALICE, 'smtp'))
  const META = JSON.stringify({ provider: 'gmail', username: 'alice@example.com', from_name: 'Alice' })
  const newEmail = async (who: Who, extra = ''): Promise<number> =>
    Number((await as(who, `select (request_approval('email', 'Approved words.', 'Priya <priya@example.com>', null, ${extra || 'null'}, 'Quote')).id as id`))[0].id)
  const claim = (user: string, id: number): Promise<Row[]> => as(server, 'select send_claim($1, $2) as c', [user, id])

  test('an assistant cannot change a draft after asking; the person can', async () => {
    const id = await newEmail(aliceApp)
    await fails(as(aliceApp, `update approvals set draft = 'swapped before the yes' where id = $1`, [id]), /cannot change a draft after asking/)
    await fails(as(aliceApp, `update approvals set recipient = 'thief@example.com' where id = $1`, [id]), /cannot change a draft after asking/)
    await fails(as(aliceApp, `update approvals set subject = 'Other' where id = $1`, [id]), /cannot change a draft after asking/)
    await as(alice, `select decide_approval($1, 'approved', 'Edited by Alice.')`, [id])
    expect((await as(alice, 'select draft, status from approvals where id = $1', [id]))[0]).toEqual({ draft: 'Edited by Alice.', status: 'approved' })
    await fails(as(alice, `update approvals set subject = 'Late change' where id = $1`, [id]), /Only a pending draft/)
  })

  test('a subject cannot carry a line break', async () => {
    await fails(as(alice, `insert into approvals (channel, draft, subject) values ('email', 'x', E'Hi\nBcc: x@evil.test')`), /check constraint/)
  })

  test('only the person can save or remove a login, and nobody can read it back', async () => {
    await fails(as(aliceApp, 'select put_secret($1, $2::jsonb, $3)', ['smtp', META, sealed]), /assistant cannot/)
    await fails(as({ role: 'anon' }, 'select put_secret($1, $2::jsonb, $3)', ['smtp', META, sealed]), /permission denied/)
    await fails(as(alice, 'select put_secret($1, $2::jsonb, $3)', ['smtp', META, 'plain text password']), /check constraint/)
    await fails(as(alice, 'select put_secret($1, $2::jsonb, $3)', ['ftp', META, sealed]), /check constraint/)
    await as(alice, 'select put_secret($1, $2::jsonb, $3)', ['smtp', META, sealed])
    await as(alice, 'select put_secret($1, $2::jsonb, $3)', ['smtp', META, sealed]) // replacing keeps one row
    expect((await as(alice, `select kind, meta ->> 'username' as username from secrets where deleted_at is null`))).toEqual([{ kind: 'smtp', username: 'alice@example.com' }])
    await fails(as(alice, 'select ciphertext from secrets'), /permission denied/)
    await fails(as(alice, 'select * from secrets'), /permission denied/)
    await fails(as(alice, `update secrets set meta = '{}'`), /permission denied/)
    await fails(as(alice, `insert into secrets (user_id, kind, ciphertext) values ('${ALICE}', 'smtp', '')`), /permission denied/)
    expect(await as(aliceApp, 'select id from secrets')).toEqual([])
    expect(await as(bob, 'select id from secrets')).toEqual([])
    await fails(as(aliceApp, `select remove_secret('smtp')`), /assistant cannot/)
  })

  test('an assistant learns only that email is connected, with a hint of the address', async () => {
    expect((await as(aliceApp, 'select connection_status() as s'))[0].s).toEqual({ email: { connected: true, address_hint: 'a***@example.com' } })
    expect((await as(bob, 'select connection_status() as s'))[0].s).toEqual({ email: { connected: false } })
  })

  test('users and apps cannot call the send functions or claim a send by hand', async () => {
    const id = await newEmail(aliceApp)
    await as(alice, `select decide_approval($1, 'approved')`, [id])
    await fails(as(alice, 'select send_claim($1, $2)', [ALICE, id]), /permission denied/)
    await fails(as(aliceApp, 'select send_claim($1, $2)', [ALICE, id]), /permission denied/)
    await fails(as(aliceApp, `select send_finish($1, $2, 'sent', 'x')`, [ALICE, id]), /permission denied/)
    await fails(as(alice, `select channel_send_claim('telegram', '700100', $1)`, [id]), /permission denied/)
    await fails(as(aliceApp, 'update approvals set send_claimed_at = now() where id = $1', [id]), /Only the aos server/)
    await fails(as(alice, 'update approvals set send_claimed_at = now() where id = $1', [id]), /Only the aos server/)
  })

  test('only an approved, due email of that user can be claimed, and only once', async () => {
    const pending = await newEmail(aliceApp)
    await fails(claim(ALICE, pending), /it is pending, not approved/)
    const [post] = await as(aliceApp, `select (request_approval('linkedin-post', 'A post')).id as id`)
    await as(alice, `select decide_approval($1, 'approved')`, [post.id])
    await fails(claim(ALICE, Number(post.id)), /it is not an email/)
    const later = await newEmail(aliceApp, `now() + interval '1 day'`)
    await as(alice, `select decide_approval($1, 'approved')`, [later])
    await fails(claim(ALICE, later), /scheduled for later/)

    const id = await newEmail(aliceApp)
    await as(alice, `select decide_approval($1, 'approved')`, [id])
    await fails(claim(BOB, id), /not found/)
    const got = (await claim(ALICE, id))[0].c as { user_id: string; approval: Row; meta: Row; ciphertext: string }
    expect(got.user_id).toBe(ALICE)
    expect(got.ciphertext).toBe(sealed)
    expect(got.meta.username).toBe('alice@example.com')
    expect([got.approval.draft, got.approval.subject, got.approval.recipient]).toEqual(['Approved words.', 'Quote', 'Priya <priya@example.com>'])
    await fails(claim(ALICE, id), /already being sent/)

    // a send that certainly did not go out is released and can be claimed again
    await as(server, `select send_finish($1, $2, 'retry', 'Not sent: login refused.')`, [ALICE, id])
    expect((await as(alice, 'select status, result from approvals where id = $1', [id]))[0]).toEqual({ status: 'approved', result: 'Not sent: login refused.' })
    await claim(ALICE, id)
    await as(server, `select send_finish($1, $2, 'sent', 'Sent by aos')`, [ALICE, id])
    expect((await as(alice, 'select status from approvals where id = $1', [id]))[0].status).toBe('sent')
    await fails(claim(ALICE, id), /it is sent, not approved/)
    await fails(as(server, `select send_finish($1, $2, 'sent', 'again')`, [ALICE, id]), /is not being sent/)
    const log = await as(alice, `select channel, account, action from activity where action = 'sent by aos (approval ${id})'`)
    expect(log).toEqual([{ channel: 'email', account: 'Priya <priya@example.com>', action: `sent by aos (approval ${id})` }])
    expect(await as(bob, `select id from activity where action like 'sent by aos%'`)).toEqual([])
  })

  test('a sent email closes its task; a stale claim frees itself', async () => {
    const [t] = await as(alice, `insert into tasks (title) values ('Send the quote') returning id`)
    const [ap] = await as(aliceApp, `select (request_approval('email', 'Body', 'priya@example.com', $1, null, 'Quote')).id as id`, [t.id])
    await as(alice, `select decide_approval($1, 'approved')`, [ap.id])
    await claim(ALICE, Number(ap.id))
    await pg.query(`update approvals set send_claimed_at = now() - interval '6 minutes' where id = $1`, [ap.id])
    await claim(ALICE, Number(ap.id))
    await as(server, `select send_finish($1, $2, 'sent', 'ok')`, [ALICE, ap.id])
    expect((await as(alice, 'select status from tasks where id = $1', [t.id]))[0].status).toBe('done')
  })

  test('a yes from the linked chat can claim only that person\'s email', async () => {
    const code = String((await as(alice, `select create_link_code('telegram') as c`))[0].c)
    await as(server, `select channel_claim('telegram', $1, '800200', null)`, [code])
    const id = await newEmail(aliceApp)
    await as(server, `select channel_decide('telegram', '800200', $1, 'approved')`, [id])
    await fails(as(server, `select channel_send_claim('telegram', '999', $1)`, [id]), /not linked/)
    const got = (await as(server, `select channel_send_claim('telegram', '800200', $1) as c`, [id]))[0].c as { user_id: string }
    expect(got.user_id).toBe(ALICE)
    await as(server, `select send_finish($1, $2, 'failed', 'May not have been sent')`, [ALICE, id])
    expect((await as(alice, 'select status from approvals where id = $1', [id]))[0].status).toBe('failed')
  })

  test('no more than 50 emails a day', async () => {
    await pg.query(
      `insert into approvals (user_id, channel, draft, recipient, subject) select $1, 'email', 'x', 'p@example.com', 's' from generate_series(1, 50)`, [ALICE],
    )
    await pg.query(`update approvals set status = 'approved' where user_id = $1 and draft = 'x'`, [ALICE])
    await pg.query(`update approvals set send_claimed_at = now(), status = 'sent' where user_id = $1 and draft = 'x'`, [ALICE])
    const id = await newEmail(aliceApp)
    await as(alice, `select decide_approval($1, 'approved')`, [id])
    await fails(claim(ALICE, id), /limit of 50 emails a day/)
  })

  test('removing a login erases it; sends then find no connection', async () => {
    expect((await as(alice, `select remove_secret('smtp') as ok`))[0].ok).toBe(true)
    const rows = (await pg.query<{ ciphertext: string; gone: boolean }>(`select ciphertext, deleted_at is not null as gone from secrets where user_id = $1`, [ALICE])).rows
    expect(rows).toEqual([{ ciphertext: '', gone: true }])
    expect((await as(aliceApp, 'select connection_status() as s'))[0].s).toEqual({ email: { connected: false } })
    await pg.query(`update approvals set send_claimed_at = null where user_id = $1 and draft = 'x'`, [ALICE])
    const id = await newEmail(aliceApp)
    await as(alice, `select decide_approval($1, 'approved')`, [id])
    await fails(claim(ALICE, id), /no email connection/)
  })
})

describe('code and schema agree', () => {
  test('every column the code selects exists', async () => {
    const lists: Record<string, string> = { tasks: TASK_COLS, approvals: APPROVAL_COLS, goals: GOAL_COLS, events: EVENT_COLS, activity: ACTIVITY_COLS }
    for (const [table, cols] of Object.entries(lists)) {
      const rows = (await pg.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`, [table],
      )).rows.map((r) => r.column_name)
      for (const col of cols.split(',')) expect(rows, `${table}.${col}`).toContain(col)
    }
  })

  test('every database function the code calls exists with those argument names', async () => {
    const src = ['store.ts', 'channel-db.ts', 'send-db.ts'].map((f) => readFileSync(join(import.meta.dir, '..', 'lib', f), 'utf8')).join('\n')
    const calls = [...src.matchAll(/\.rpc\('([a-z_]+)',\s*\{([^}]*)\}/g)]
    expect(calls.length).toBeGreaterThanOrEqual(15)
    for (const [, name, body] of calls) {
      const used = [...body.matchAll(/(p_[a-z_]+):/g)].map((m) => m[1])
      const fn = (await pg.query<{ args: string[] }>(
        `select proargnames as args from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [name],
      )).rows[0]
      expect(fn, `function ${name}`).toBeDefined()
      for (const arg of used) expect(fn.args, `${name}(${arg})`).toContain(arg)
    }
  })

  test('every table has row level security on, and no policy allows delete', async () => {
    const tables = (await pg.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`,
    )).rows
    expect(tables.length).toBe(11)
    for (const t of tables) expect(t.relrowsecurity, t.relname).toBe(true)
    const deletes = (await pg.query(`select 1 from pg_policies where schemaname = 'public' and cmd in ('DELETE', 'ALL')`)).rows
    expect(deletes).toEqual([])
  })
})
