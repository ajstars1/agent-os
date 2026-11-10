// One HTTPS request to a service the person connected, with their saved key put in by this code. The assistant
// names the key and the path; it never sees the key and cannot choose the host.
//   - the host is the one the person saved with the key
//   - the name must resolve to public addresses only (no localhost, no private networks)
//   - redirects are not followed, the reply is read up to a fixed size, and the key is scrubbed out of the reply
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'

export type Scheme = 'bearer' | 'basic' | 'header'

export interface KeyMeta {
  host: string
  scheme: Scheme
  header?: string
  writes: 'never' | 'ask'
}

const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/
const INTERNAL = /\.(local|localhost|internal|lan|home|corp|test|invalid|example)$/
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'cookie', 'content-type', 'accept', 'user-agent'])

export const isHost = (h: string): boolean => h.length <= 253 && HOST.test(h) && !INTERNAL.test(h)

export const isHeaderName = (h: string): boolean => HEADER_NAME.test(h) && !FORBIDDEN_HEADERS.has(h.toLowerCase())

export const parseKeyMeta = (meta: Record<string, unknown>): KeyMeta | null => {
  const { host, scheme, header, writes } = meta
  if (typeof host !== 'string' || !isHost(host)) return null
  if (scheme !== 'bearer' && scheme !== 'basic' && scheme !== 'header') return null
  if (scheme === 'header' && (typeof header !== 'string' || !isHeaderName(header))) return null
  return { host, scheme, ...(scheme === 'header' ? { header: header as string } : {}), writes: writes === 'ask' ? 'ask' : 'never' }
}

// A key must be printable and on one line, so it cannot add a header of its own.
export const isKeyValue = (key: string, scheme: Scheme): boolean =>
  key.length >= 8 && key.length <= 2000 && (scheme === 'basic' ? /^[\x20-\x7e]+$/ : /^[\x21-\x7e]+$/).test(key)

export const authHeader = (meta: KeyMeta, key: string): [string, string] =>
  meta.scheme === 'bearer'
    ? ['authorization', `Bearer ${key}`]
    : meta.scheme === 'basic'
      ? ['authorization', `Basic ${Buffer.from(key.includes(':') ? key : `${key}:`, 'utf8').toString('base64')}`]
      : [meta.header ?? 'x-api-key', key]

const blocked = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [
  ['::', 127], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, bits, 'ipv6')

export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  if (family !== 6) return false
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped) return !blocked.check(mapped[1], 'ipv4')
  return !blocked.check(address, 'ipv6')
}

type Resolver = (hostname: string, cb: (err: Error | null, addresses: LookupAddress[]) => void) => void

const systemResolver: Resolver = (hostname, cb) => dnsLookup(hostname, { all: true }, (err, addresses) => cb(err, addresses ?? []))

// A DNS lookup that refuses names pointing anywhere but the public internet. Used as the socket's own lookup, so
// the address that was checked is the address that gets connected to.
export const publicLookup =
  (resolver: Resolver = systemResolver): LookupFunction =>
  (hostname, options, callback) => {
    resolver(hostname, (err, addresses) => {
      if (err) return callback(err, '', 0)
      if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
        return callback(Object.assign(new Error('That host does not resolve to a public address'), { code: 'EPRIVATE' }), '', 0)
      }
      if ((options as { all?: boolean }).all) return callback(null, addresses)
      callback(null, addresses[0].address, addresses[0].family)
    })
  }

export interface SealedRequest {
  meta: KeyMeta
  key: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: string | null
  contentType?: string | null
}

export interface SealedResponse {
  status: number
  contentType: string
  text: string
  truncated: boolean
}

// Tests talk to a local plain-HTTP server; production is always HTTPS on port 443 with the public-address lookup.
export interface Target {
  insecureLocalPort?: number
}

export const MAX_BYTES = 256 * 1024
const TIMEOUT_MS = 15000

export const buildUrl = (host: string, path: string): URL => {
  if (!isHost(host)) throw new Error('The saved host is not valid')
  if (!/^\/[\x21-\x7e]*$/.test(path) || path.length > 1000) throw new Error('path must start with / and contain no spaces')
  const url = new URL(`https://${host}${path}`)
  if (url.hostname !== host || url.username || url.password || url.port) throw new Error('path is not valid')
  return url
}

export const sealedRequest = (req: SealedRequest, target: Target = {}): Promise<SealedResponse> =>
  new Promise((resolve, reject) => {
    let url: URL
    try {
      url = buildUrl(req.meta.host, req.path)
    } catch (e) {
      reject(Object.assign(e as Error, { delivered: false }))
      return
    }
    const [name, value] = authHeader(req.meta, req.key)
    const body = req.body ?? null
    const headers: Record<string, string | number> = {
      [name]: value,
      accept: 'application/json, text/plain;q=0.8, */*;q=0.1',
      'accept-encoding': 'identity',
      'user-agent': 'aos-connect',
      ...(body !== null ? { 'content-type': req.contentType ?? 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
    }
    const local = target.insecureLocalPort
    let delivered = false
    let settled = false
    const fail = (e: Error): void => {
      if (settled) return
      settled = true
      reject(Object.assign(e, { delivered }))
    }
    const onResponse = (res: http.IncomingMessage): void => {
      const chunks: Buffer[] = []
      let size = 0
      let truncated = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          text: Buffer.concat(chunks).toString('utf8'),
          truncated,
        })
      }
      res.on('data', (c: Buffer) => {
        if (truncated) return
        if (size + c.length > MAX_BYTES) {
          chunks.push(c.subarray(0, MAX_BYTES - size))
          truncated = true
          done()
          res.destroy()
          return
        }
        size += c.length
        chunks.push(c)
      })
      res.on('end', done)
      res.on('error', fail)
    }
    const common = { method: req.method, path: `${url.pathname}${url.search}`, headers, agent: false, timeout: TIMEOUT_MS }
    const r = local
      ? http.request({ ...common, host: '127.0.0.1', port: local, setHost: false, headers: { ...headers, host: req.meta.host } }, onResponse)
      : https.request({ ...common, host: req.meta.host, port: 443, servername: req.meta.host, lookup: publicLookup() }, onResponse)
    r.on('socket', (socket) => socket.once(local ? 'connect' : 'secureConnect', () => (delivered = true)))
    r.on('timeout', () => r.destroy(Object.assign(new Error('The service took too long to answer'), { code: 'ETIMEDOUT' })))
    r.on('error', fail)
    r.end(body ?? undefined)
  })

// The key must never come back to the assistant, even from a service that echoes what it was sent.
export const scrubKey = (text: string, key: string): string => {
  const forms = new Set([
    key,
    encodeURIComponent(key),
    Buffer.from(key, 'utf8').toString('base64'),
    Buffer.from(key, 'utf8').toString('base64url'),
    Buffer.from(key.includes(':') ? key : `${key}:`, 'utf8').toString('base64'),
  ])
  let out = text
  for (const f of forms) if (f.length >= 6) out = out.split(f).join('[KEY]')
  return out
}

export interface HttpFailure {
  // true = the request certainly did not reach the service
  notSent: boolean
  reason: string
}

export const httpFailure = (e: unknown): HttpFailure => {
  const err = (e ?? {}) as { code?: unknown; delivered?: unknown; message?: unknown }
  if (err.delivered === true) {
    return { notSent: false, reason: 'the connection broke after the request was sent. Check the service before trying again' }
  }
  if (err.code === 'EPRIVATE') return { notSent: true, reason: 'the saved host does not point to a public address' }
  if (typeof err.message === 'string' && /^(path |The saved host)/.test(err.message)) return { notSent: true, reason: err.message }
  return { notSent: true, reason: 'the service could not be reached' }
}
