// Once a day, copy the newest MeshCentral auto-backup (it holds the Intel AMT credentials) from aos-mesh to
// ~/Backups/aos-mesh over Tailscale, owner-only, keeping the last 7. MeshCentral writes them daily to
// /var/backups/meshcentral (settings.autoBackup in its config.json).
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VM = process.env.AOS_VM ?? '' // ubuntu@<VM Tailscale IP>, in .env.local
const DIR = join(homedir(), 'Backups', 'aos-mesh')
const STAMP = join(import.meta.dir, '.mesh-backup-day')
const KEEP = 7

const ssh = (cmd: string): { ok: boolean; out: Buffer } => {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', VM, cmd], { timeout: 120_000, maxBuffer: 512 * 1024 * 1024 })
  return { ok: r.status === 0, out: r.stdout ?? Buffer.alloc(0) }
}

/** Returns a line for Discord when something worth telling happened, else null. */
export const pullMeshBackup = (): string | null => {
  if (!VM) return null // AOS_VM not set: nothing to back up from
  const today = new Date().toISOString().slice(0, 10)
  if (existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === today) return null
  const latest = ssh('sudo ls -1t /var/backups/meshcentral/ 2>/dev/null | grep -E "\\.zip$" | head -1')
  const name = latest.out.toString().trim()
  if (!latest.ok || !/^[\w.-]+\.zip$/.test(name)) return null // VM unreachable or no backup yet: retry next tick
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const target = join(DIR, name)
  if (!existsSync(target)) {
    const file = ssh(`sudo cat /var/backups/meshcentral/${name}`)
    if (!file.ok || file.out.length < 1024) return `⚠️ MeshCentral backup copy failed (${name}).`
    writeFileSync(target, file.out, { mode: 0o600 })
    chmodSync(target, 0o600)
  }
  const old = readdirSync(DIR).filter((f) => f.endsWith('.zip')).sort().reverse().slice(KEEP)
  for (const f of old) unlinkSync(join(DIR, f))
  writeFileSync(STAMP, today)
  return null
}
