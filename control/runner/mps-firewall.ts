// Keeps the MeshCentral MPS port (4433 on aos-mesh) open to the home public IP only.
// Intel AMT connects out from home to the MPS, so when the ISP hands out a new IP both gates move:
//  1. the Oracle NSG ingress rule (OCI CLI, API key in ~/.oci, profile from AOS_OCI_PROFILE)
//  2. the VM's own iptables rule (ssh over Tailscale)
import { spawnSync } from 'node:child_process'

const NSG_ID = process.env.OCI_NSG_ID ?? '' // the NSG holding the MPS port rule, in .env.local
const VM = process.env.AOS_VM ?? '' // ubuntu@<VM Tailscale IP>, in .env.local
const MPS_PORT = 4433
const OCI = '/home/ubuntu/.local/bin/oci'

type NsgRule = {
  id: string
  direction: string
  description?: string
  'tcp-options'?: { 'destination-port-range'?: { min: number; max: number } }
}

const run = (cmd: string, args: string[], input?: string): string => {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 60_000 })
  if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ''} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`)
  return r.stdout
}

const oci = (args: string[]): string =>
  run(OCI, [...args, '--profile', process.env.AOS_OCI_PROFILE ?? 'AOS', '--region', 'ap-mumbai-1'])

const updateNsg = (ip: string): void => {
  const rules = (JSON.parse(oci(['network', 'nsg', 'rules', 'list', '--nsg-id', NSG_ID, '--all'])) as { data: NsgRule[] }).data
  const rule = rules.find(
    (r) => r.direction === 'INGRESS' && r['tcp-options']?.['destination-port-range']?.min === MPS_PORT,
  )
  if (!rule) throw new Error(`no ingress rule for port ${MPS_PORT} in the NSG`)
  const updated = [
    {
      id: rule.id,
      direction: 'INGRESS',
      protocol: '6',
      source: `${ip}/32`,
      sourceType: 'CIDR_BLOCK',
      isStateless: false,
      description: 'Intel AMT CIRA to MeshCentral MPS, home IP only (kept current by aos runner)',
      tcpOptions: { destinationPortRange: { min: MPS_PORT, max: MPS_PORT } },
    },
  ]
  oci(['network', 'nsg', 'rules', 'update', '--nsg-id', NSG_ID, '--security-rules', JSON.stringify(updated)])
}

const updateVmFirewall = (ip: string): void => {
  // Replace whatever source the 4433 rule had with the new home IP, then persist.
  const script = [
    'set -e',
    `while sudo iptables -S INPUT | grep -q -- "--dport ${MPS_PORT}"; do`,
    `  rule=$(sudo iptables -S INPUT | grep -- "--dport ${MPS_PORT}" | head -1 | sed 's/^-A /-D /')`,
    '  eval sudo iptables $rule',
    'done',
    `sudo iptables -I INPUT 5 -p tcp -s ${ip}/32 --dport ${MPS_PORT} -m state --state NEW -j ACCEPT`,
    'sudo netfilter-persistent save >/dev/null 2>&1',
  ].join('\n')
  run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', VM, 'bash -s'], script)
}

export const allowHomeIp = (ip: string): void => {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`not an IPv4 address: ${ip}`)
  if (!VM || !NSG_ID) throw new Error('set AOS_VM and OCI_NSG_ID in .env.local')
  updateNsg(ip)
  updateVmFirewall(ip)
}
