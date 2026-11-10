// Sealing and opening vault entries. AES-256-GCM with a key that lives only in the server's environment, never in
// the database: a copy of the database alone reveals nothing. Each entry is bound to its owner and kind, so a
// sealed value moved to another user's row does not open.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VERSION = 'v1'

// 32 random bytes, base64url. Null when the vault is not configured.
export const vaultKey = (): Buffer | null => {
  const raw = process.env.VAULT_KEY
  if (!raw || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null
  const key = Buffer.from(raw, 'base64url')
  return key.length === 32 ? key : null
}

export const binding = (userId: string, kind: string): string => `${userId}:${kind}`

export const seal = (key: Buffer, plaintext: string, bound: string): string => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(bound, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return [VERSION, iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
}

// Throws when the value was changed, belongs to someone else, or was sealed with another key.
export const open = (key: Buffer, sealed: string, bound: string): string => {
  const [version, iv, body, tag] = sealed.split('.')
  if (version !== VERSION || !iv || !body || !tag) throw new Error('Unknown vault format')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAAD(Buffer.from(bound, 'utf8'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
}
