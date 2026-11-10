// Database calls for masking and for reading a saved API key. Secret key only: a connected app must never be able
// to turn a stand-in back into a value, or read a key. The user id must come from a token this server verified.
import { secretClient as db } from './secret-client'

export interface MaskResult {
  level: 'off' | 'api' | 'all'
  email: Record<string, number>
  phone: Record<string, number>
}

export const maskLookup = async (userId: string, emails: string[], phones: string[], source: 'api' | 'own'): Promise<MaskResult> => {
  const { data, error } = await db().rpc('handles_mask', { p_user: userId, p_emails: emails, p_phones: phones, p_source: source })
  if (error) throw new Error(error.message)
  return data as MaskResult
}

export interface Resolved {
  email: Record<string, string>
  phone: Record<string, string>
}

export const resolveHandles = async (userId: string, emails: number[], phones: number[]): Promise<Resolved> => {
  const { data, error } = await db().rpc('handles_resolve', { p_user: userId, p_emails: emails, p_phones: phones })
  if (error) throw new Error(error.message)
  return data as Resolved
}

export interface SavedKey {
  meta: Record<string, unknown>
  ciphertext: string
}

export const readApiKey = async (userId: string, name: string): Promise<SavedKey> => {
  const { data, error } = await db().rpc('api_key_read', { p_user: userId, p_name: name })
  if (error) throw new Error(error.message)
  return data as SavedKey
}
