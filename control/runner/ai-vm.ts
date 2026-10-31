// Oracle's free ARM capacity in Mumbai is usually full, so keep asking: every 15 min try to launch aos-ai
// (A1.Flex, the free 4 cores / 24 GB, else 2 / 12) for open-source voice transcription and basic replies.
// Once it exists, read its serial console for the Tailscale login link (oci/aos-ai-init.sh) and send it to Discord.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STATE = join(import.meta.dir, '.ai-vm.json')
const EVERY_MS = 15 * 60 * 1000
const OCI = '/home/ubuntu/.local/bin/oci'
const NAME = 'aos-ai'
const AD = 'YFfL:AP-MUMBAI-1-AD-1'
const SUBNET = process.env.OCI_SUBNET_ID ?? ''
const IMAGE = process.env.OCI_IMAGE_ID ?? '' // Ubuntu 24.04 aarch64
const INIT = join(import.meta.dir, '..', 'oci', 'aos-ai-init.sh')
const SSH_KEY = '/home/ubuntu/.ssh/id_ed25519.pub'
// Normal answers while hunting: no capacity yet, or Oracle throttling the launch calls.
const BUSY = /capacity|too many requests/i
const SHAPES = [{ ocpus: 4, memoryInGBs: 24 }, { ocpus: 2, memoryInGBs: 12 }]

type State = { instanceId?: string; lastTry?: number; tries?: number; lastError?: string; loginSent?: boolean }
type Instance = { id: string; 'display-name': string; 'lifecycle-state': string }

const load = (): State => (existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as State) : {})
const save = (s: State): void => writeFileSync(STATE, JSON.stringify(s))

const oci = (args: string[], timeout = 120_000): { ok: boolean; out: string } => {
  const r = spawnSync(OCI, [...args, '--profile', process.env.AOS_OCI_PROFILE ?? 'AOS', '--region', 'ap-mumbai-1'],
    { encoding: 'utf8', timeout, env: { ...process.env, SUPPRESS_LABEL_WARNING: 'True' } })
  return { ok: r.status === 0, out: r.status === 0 ? r.stdout : (r.stderr || r.stdout || '') }
}

const tenancy = (): string => {
  const cfg = readFileSync('/home/ubuntu/.oci/config', 'utf8')
  const section = cfg.split(/^\[/m).find((s) => s.startsWith(`${process.env.AOS_OCI_PROFILE ?? 'AOS'}]`)) ?? ''
  const m = /^tenancy\s*=\s*(\S+)/m.exec(section)
  if (!m?.[1]) throw new Error('no tenancy in ~/.oci/config')
  return m[1]
}

// A launch that timed out on our side may still have created the VM: adopt it instead of launching a second one.
const existing = (compartment: string): string | undefined => {
  const r = oci(['compute', 'instance', 'list', '--compartment-id', compartment, '--display-name', NAME, '--all'])
  if (!r.ok) return undefined
  const list = (JSON.parse(r.out || '{"data":[]}') as { data: Instance[] }).data
  return list.find((i) => !['TERMINATED', 'TERMINATING'].includes(i['lifecycle-state']))?.id
}

const launch = (compartment: string): { id?: string; error?: string } => {
  let error = ''
  for (const shape of SHAPES) {
    const r = oci(['compute', 'instance', 'launch', '--compartment-id', compartment, '--availability-domain', AD,
      '--display-name', NAME, '--shape', 'VM.Standard.A1.Flex', '--shape-config', JSON.stringify(shape),
      '--image-id', IMAGE, '--subnet-id', SUBNET, '--assign-public-ip', 'true', '--boot-volume-size-in-gbs', '100',
      '--ssh-authorized-keys-file', SSH_KEY, '--user-data-file', INIT], 180_000)
    if (r.ok) return { id: (JSON.parse(r.out) as { data: Instance }).data.id }
    error = /"message":\s*"([^"]+)"/.exec(r.out)?.[1] ?? r.out.trim().slice(0, 200)
    if (!BUSY.test(error)) break
  }
  return { error }
}

const tailscaleLink = (instanceId: string): string | undefined => {
  const cap = oci(['compute', 'console-history', 'capture', '--instance-id', instanceId, '--wait-for-state', 'SUCCEEDED'])
  if (!cap.ok) return undefined
  const historyId = (JSON.parse(cap.out) as { data: { id: string } }).data.id
  const content = oci(['compute', 'console-history', 'get-content', '--instance-console-history-id', historyId,
    '--length', '10000000', '--file', '/dev/stdout'])
  oci(['compute', 'console-history', 'delete', '--instance-console-history-id', historyId, '--force'])
  return /AOSTS\s+(https:\/\/login\.tailscale\.com\/a\/[\w-]+)/.exec(content.out)?.[1]
}

/** Returns a line for Discord when something worth telling happened, else null. */
export const tryAiVm = (): string | null => {
  if (!SUBNET || !IMAGE) return null // OCI_SUBNET_ID / OCI_IMAGE_ID not set
  const s = load()
  if (s.loginSent) return null
  const now = Date.now()
  if (s.lastTry && now - s.lastTry < EVERY_MS) return null
  s.lastTry = now
  const compartment = tenancy()
  if (!s.instanceId) {
    s.instanceId = existing(compartment)
    if (!s.instanceId) {
      const r = launch(compartment)
      s.tries = (s.tries ?? 0) + 1
      if (!r.id) {
        const repeat = r.error === s.lastError
        s.lastError = r.error
        save(s)
        // Busy is the normal answer: stay quiet. Anything else is worth one message.
        return BUSY.test(r.error ?? '') || repeat ? null : `⚠️ aos-ai launch failed: ${r.error}`
      }
      s.instanceId = r.id
      save(s)
      return `✅ Oracle ARM server **aos-ai** created after ${s.tries} tries. Booting; Tailscale login link follows in ~15 min.`
    }
  }
  const link = tailscaleLink(s.instanceId)
  if (link) s.loginSent = true
  save(s)
  return link ? `🔗 aos-ai is up. Open this to add it to your Tailscale: ${link}` : null
}
