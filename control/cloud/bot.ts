// aos-cloud: the always-on basic bot. Runs on the Oracle VM (aos-mesh) next to MeshCentral, so it answers
// even when the PC is off. DMs from Ayush only. Node 22 runs this file directly (type stripping).
//   pc status | pc on | pc off / pc reset (then "force pc off" / "force pc reset")
//   agent | agent restart -> the PC's Discord agent + aos-watch, through MeshCentral
//   today | done N [note] | skip N | yes N | no N | edit N: text | add <task>
//   do <request> -> queued Claude task on the PC (wakes it through AMT) | voice notes are transcribed first
//   anything else -> Gemini answers, or routes PC work to a queued task after Ayush sends "go"
import { spawnSync } from 'node:child_process'
import { createSign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client, GatewayIntentBits, Partials, type Message } from 'discord.js'

const env = (k: string): string => {
  const v = process.env[k]
  if (!v) throw new Error(`missing ${k} in /etc/aos-cloud/env`)
  return v
}

const OWNER_ID = env('OWNER_ID')
const MESH_NODE = env('MESH_NODE_ID')
const MESH_URL = env('MESH_URL')
const MESHCTRL = '/opt/aos-cloud/meshctrl.cjs' // copied from the MeshCentral install by deploy.sh; .cjs because package.json is ESM
const AOS_MCP = env('AOS_MCP_URL')
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash'

type MeshNode = { _id: string; name: string; conn?: number; pwr?: number; intelamt?: { state?: number } }

const meshctrl = (args: string[]): string => {
  const r = spawnSync('node', [MESHCTRL, ...args, '--url', MESH_URL, '--loginuser', env('MESH_USER'), '--loginpass', env('MESH_PASS')],
    { encoding: 'utf8', timeout: 90_000, env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' } })
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'meshctrl failed').trim().slice(0, 300))
  return r.stdout
}

// MeshCentral conn bits: 1 agent, 2 Intel AMT CIRA, 4 Intel AMT local. pwr: 1 on, 6 off, 7 present (AMT) ...
const pcState = (): { agent: boolean; amt: boolean; text: string } => {
  const nodes = JSON.parse(meshctrl(['listdevices', '--json'])) as MeshNode[]
  const pc = nodes.find((n) => n._id === MESH_NODE)
  if (!pc) return { agent: false, amt: false, text: 'PC not found in MeshCentral' }
  const conn = pc.conn ?? 0
  const agent = (conn & 1) !== 0
  const amt = (conn & 6) !== 0
  const power = agent ? 'ON (Linux running)' : amt ? 'OFF or booting (AMT reachable)' : 'unreachable (no agent, no AMT)'
  return { agent, amt, text: `PC ${pc.name}: ${power}. Agent ${agent ? '✅' : '❌'} · AMT ${amt ? '✅' : '❌'}` }
}

const power = (action: 'on' | 'off' | 'reset'): string => {
  const s = pcState()
  if (action === 'on') {
    if (s.agent) return 'PC is already on.'
    if (!s.amt) return 'AMT is not connected, cannot power on remotely (home internet down?).'
    meshctrl(['devicepower', '--id', MESH_NODE, '--amton'])
    return 'Power-on sent through AMT. Linux needs ~1-2 min, then the main aos bot comes online (locked screen).'
  }
  // Graceful through the agent when Linux runs, hard through AMT otherwise.
  const flag = s.agent ? `--${action}` : `--amt${action}`
  if (!s.agent && !s.amt) return 'PC unreachable: neither agent nor AMT connected.'
  meshctrl(['devicepower', '--id', MESH_NODE, flag])
  return `${action === 'off' ? 'Power-off' : 'Reset'} sent ${s.agent ? 'to Linux (clean shutdown)' : 'through AMT (hard)'}.`
}

const mcp = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const res = await fetch(AOS_MCP, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('AOS_MCP_TOKEN')}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30_000),
  })
  const raw = await res.text()
  const json = raw.startsWith('{') ? raw : (raw.split('\n').find((l) => l.startsWith('data: ')) ?? '').slice(6)
  const msg = JSON.parse(json) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message: string } }
  if (msg.error) throw new Error(msg.error.message)
  return (msg.result?.content ?? []).map((c) => c.text ?? '').join('\n') || '(empty)'
}

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } }

// Vertex through a service account (set-vertex-sa.sh): sign a JWT with its key, trade it for a 1 h access token.
type ServiceAccount = { client_email: string; private_key: string }
let saToken: { value: string; expires: number } | null = null

const vertexToken = async (): Promise<string> => {
  if (saToken && saToken.expires > Date.now() + 60_000) return saToken.value
  const sa = JSON.parse(readFileSync(env('GOOGLE_APPLICATION_CREDENTIALS'), 'utf8')) as ServiceAccount
  const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })}`
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url')}`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    signal: AbortSignal.timeout(20_000),
  })
  const data = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string }
  if (!data.access_token) throw new Error(`Vertex login: ${data.error_description ?? res.status}`)
  saToken = { value: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 }
  return saToken.value
}

const hasGemini = (): boolean => Boolean(process.env.VERTEX_PROJECT || process.env.GEMINI_API_KEY)

const geminiCall = async (parts: GeminiPart[], system: string, json = false): Promise<string> => {
  const project = process.env.VERTEX_PROJECT
  const key = process.env.GEMINI_API_KEY
  let url: string
  let auth: Record<string, string>
  if (project) {
    url = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${GEMINI_MODEL}:generateContent`
    auth = { Authorization: `Bearer ${await vertexToken()}` }
  } else if (key) {
    // Vertex AI express-mode keys start with "AQ."; AI Studio keys with "AIza".
    url = key.startsWith('AQ.')
      ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${GEMINI_MODEL}:generateContent`
      : `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`
    auth = { 'x-goog-api-key': key }
  } else throw new Error('no Gemini access on the server (set-vertex-sa.sh)')
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      ...(json ? { generationConfig: { responseMimeType: 'application/json' } } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  })
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message: string } }
  if (data.error) throw new Error(`Gemini: ${data.error.message}`)
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
}

// The PC's Discord agent and its watchdog are user services; MeshAgent runs as root, so go through runuser.
const PC_USER = 'ubuntu'
const PC_UID = 1000
const agentCtl = (restart: boolean): string => {
  if (!pcState().agent) return 'Linux is not running (no MeshCentral agent), so nothing to restart. Try `pc on`.'
  const user = `runuser -u ${PC_USER} -- env XDG_RUNTIME_DIR=/run/user/${PC_UID} DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${PC_UID}/bus systemctl --user`
  const run = `${restart ? `${user} restart aos-discord aos-watch; sleep 5; ` : ''}${user} is-active aos-discord aos-watch`
  const out = meshctrl(['runcommand', '--id', MESH_NODE, '--run', run, '--reply']).trim().split(/\s+/)
  const line = (name: string, state = 'unknown'): string => `${state === 'active' ? '✅' : '❌'} ${name}: ${state}`
  return `${restart ? 'Restarted. ' : ''}${line('aos (Discord agent)', out.at(-2))}\n${line('aos-watch', out.at(-1))}`
}

// Routing: Gemini answers what it can; work that needs the PC becomes a queued Claude task after Ayush says "go".
let pendingWork: { request: string; expires: number } | null = null

const ask = async (question: string): Promise<string> => {
  if (!hasGemini()) return 'No Gemini access on the server, so I only do commands. Send `help`.'
  const agenda = await mcp('agenda', { days: 2 }).catch(() => '(agenda unavailable)')
  const raw = await geminiCall([{ text: question }],
    "You are aos-cloud, Ayush's always-on assistant on Discord. You cannot see or touch his PC, files, browser, email or " +
    'accounts. Decide the route: "answer" if you can fully answer from general knowledge and his agenda; "pc" if it needs ' +
    'work on his PC (files, code, browser, LinkedIn, email drafts, ads, research with the web). Reply as JSON: ' +
    '{"route":"answer"|"pc","reply":"short phone-screen text, no tables, no em dashes","task":"for pc: a clear self-contained ' +
    'instruction for Claude Code on the PC"}. Never claim you sent, posted or changed anything. ' +
    `His agenda right now:\n${agenda}`, true)
  const out = JSON.parse(raw) as { route?: string; reply?: string; task?: string }
  if (out.route === 'pc' && out.task) {
    pendingWork = { request: out.task, expires: Date.now() + 10 * 60_000 }
    return `${out.reply ?? ''}\nThis needs the PC. Send \`go\` within 10 min to queue it for Claude:\n> ${out.task}`.trim()
  }
  return out.reply || '(no answer)'
}

// Voice notes: Gemini transcribes, then the transcript is handled like a typed message.
const transcribe = async (url: string, mimeType: string): Promise<string> => {
  const audio = Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(30_000) })).arrayBuffer())
  if (audio.length > 15 * 1024 * 1024) throw new Error('voice note too long (max ~15 MB)')
  const text = await geminiCall([{ inlineData: { mimeType, data: audio.toString('base64') } }, { text: 'Transcribe.' }],
    'Transcribe the voice note exactly as spoken (English, Hindi or Hinglish; write Hindi words in Latin script). ' +
    'Output only the transcript, nothing else.')
  return text.trim()
}

// Queue real work for Claude on the PC; wake the PC through AMT if it is off.
const queueWork = async (request: string): Promise<string> => {
  const added = await mcp('task_add', {
    title: `From Discord: ${request.replace(/\s+/g, ' ').slice(0, 90)}`,
    venture: 'general', owner: 'claude', kind: 'task', auto: true, source: 'discord:aos-cloud',
    due_at: new Date().toISOString(),
    prompt: `${request}\n\nAyush asked for this from Discord (aos-cloud) while away from the PC. Do it on this machine ` +
      'following CLAUDE.md and its rules. Never send, post or message anyone: draft with approval_request instead. ' +
      'Finish with task_done and a 2-4 line summary of the result (it is posted to Discord).',
  })
  const id = (JSON.parse(added) as { id?: number }).id
  const s = pcState()
  if (!s.agent && s.amt) {
    meshctrl(['devicepower', '--id', MESH_NODE, '--amton'])
    return `Queued #${id}. PC was off: powering it on now. Claude starts ~2 min after boot; the result posts in #aos.`
  }
  if (!s.agent) return `Queued #${id}, but the PC is unreachable (no agent, no AMT). It runs when the PC is back.`
  return `Queued #${id}. The PC runner starts it within 10 min; the result posts in #aos. (For instant work DM the main aos bot.)`
}

const HELP = [
  '**aos-cloud** (always on, even when the PC is off)',
  '`pc` status · `pc on` · `pc off` · `pc reset`',
  '`agent` status · `agent restart`: restart the PC Discord agent + aos-watch if aos stops answering',
  '`today` · `done 7` · `skip 7` · `yes 12` · `no 12` · `edit 12: text` · `add call Dr X fri 11am`',
  '`do <anything>`: queue real work for Claude on the PC (powers it on if off), result in #aos',
  'Voice notes work too. Anything else: quick Gemini answer, or it offers to queue it (`go`).',
].join('\n')

const pending = new Map<string, number>() // "off" | "reset" -> expiry

const handle = async (text: string): Promise<string> => {
  const t = text.trim()
  const lower = t.toLowerCase()
  let m: RegExpMatchArray | null
  if (lower === 'help' || lower === '?') return HELP
  if (lower === 'pc' || lower === 'pc status' || lower === 'status') return pcState().text
  if (lower === 'pc on' || lower === 'power on') return power('on')
  if (lower === 'agent' || lower === 'agent status') return agentCtl(false)
  if (lower === 'agent restart' || lower === 'restart agent') return agentCtl(true)
  if ((m = lower.match(/^pc (off|reset)$/))) {
    const action = m[1] as 'off' | 'reset'
    pending.set(action, Date.now() + 2 * 60_000)
    return `${pcState().text}\nSend \`force pc ${action}\` within 2 min to confirm.`
  }
  if ((m = lower.match(/^force pc (off|reset)$/))) {
    const action = m[1] as 'off' | 'reset'
    if ((pending.get(action) ?? 0) < Date.now()) return `Send \`pc ${action}\` first.`
    pending.delete(action)
    return power(action)
  }
  if (['today', 'agenda', "what's left", 'whats left'].includes(lower)) return mcp('agenda', { days: 1 })
  if ((m = t.match(/^done (\d+)\s*(.*)$/i))) return mcp('task_done', { id: Number(m[1]), ...(m[2] ? { note: m[2] } : {}) })
  if ((m = t.match(/^skip (\d+)$/i))) return mcp('task_done', { id: Number(m[1]), skipped: true })
  if ((m = t.match(/^(yes|no) (\d+)$/i))) {
    return mcp('approval_decide', { id: Number(m[2]), decision: m[1]!.toLowerCase() === 'yes' ? 'approved' : 'rejected' })
  }
  if ((m = t.match(/^edit (\d+):\s*([\s\S]+)$/i))) {
    return mcp('approval_decide', { id: Number(m[1]), decision: 'approved', edited_draft: m[2] })
  }
  if ((m = t.match(/^add (.+)$/i))) {
    const added = await mcp('task_add', { title: m[1], owner: 'ayush', source: 'discord:aos-cloud' })
    const task = JSON.parse(added) as { id?: number }
    return task.id ? `Added #${task.id}: ${m[1]} (no date; the main aos bot can schedule it)` : added
  }
  if ((m = t.match(/^(?:do|pc do)\s+([\s\S]{4,})$/i))) return queueWork(m[1]!)
  if (lower === 'go') {
    if (!pendingWork || pendingWork.expires < Date.now()) return 'Nothing waiting. Use `do <request>`.'
    const request = pendingWork.request
    pendingWork = null
    return queueWork(request)
  }
  return ask(t)
}

const client = new Client({
  intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
})

client.on('messageCreate', async (msg: Message) => {
  if (msg.author.bot || msg.guildId !== null || msg.author.id !== OWNER_ID) return
  await msg.react('👀').catch(() => undefined)
  let reply: string
  try {
    if ('sendTyping' in msg.channel) await msg.channel.sendTyping().catch(() => undefined)
    const voice = msg.attachments.find((a) => (a.contentType ?? '').startsWith('audio/'))
    if (voice && !msg.content.trim()) {
      const heard = await transcribe(voice.url, (voice.contentType ?? 'audio/ogg').split(';')[0]!)
      await msg.reply({ content: `🎙️ ${heard}`.slice(0, 1900), allowedMentions: { parse: [] } }).catch(() => undefined)
      reply = await handle(heard)
    } else {
      reply = await handle(msg.content)
    }
  } catch (e) {
    reply = `⚠️ ${e instanceof Error ? e.message : 'failed'}`
  }
  for (let i = 0; i < reply.length; i += 1900) {
    await msg.reply({ content: reply.slice(i, i + 1900), allowedMentions: { parse: [] } }).catch(() => undefined)
  }
})

client.once('clientReady', () => process.stdout.write(`aos-cloud online as ${client.user?.tag}\n`))
await client.login(env('DISCORD_TOKEN'))
