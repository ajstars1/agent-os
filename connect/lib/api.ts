// A read request to a service the person connected, on behalf of an assistant. The key is opened here, used once
// and scrubbed from the reply; contact details in the reply are masked before anything goes back.
import { pick } from './mask'
import type { SavedKey } from './mask-db'
import { parseKeyMeta, scrubKey, httpFailure, type SealedRequest, type SealedResponse } from './sealed-http'
import { binding, open } from './vault'

export interface ApiReadDeps {
  userId: string
  vault: Buffer | null
  readKey: (name: string) => Promise<SavedKey>
  request: (req: SealedRequest) => Promise<SealedResponse>
  mask: (value: unknown) => Promise<unknown>
}

// What goes back to the assistant at most. A longer reply is cut, with a note on how to ask for less.
export const MAX_REPLY_CHARS = 12000

const isJson = (contentType: string, text: string): boolean => /json/i.test(contentType) || /^\s*[[{]/.test(text)

export const apiRead = async (d: ApiReadDeps, input: { key: string; path: string; fields?: string[] }): Promise<string> => {
  if (!d.vault) throw new Error('Saved API keys are not set up on this server')
  const saved = await d.readKey(input.key)
  const meta = parseKeyMeta(saved.meta)
  if (!meta) throw new Error(`The key "${input.key}" is not saved correctly. The person can save it again on their aos page.`)
  let key: string
  try {
    key = open(d.vault, saved.ciphertext, binding(d.userId, `api:${input.key}`))
  } catch {
    throw new Error(`The key "${input.key}" could not be opened. The person can save it again on their aos page.`)
  }

  let res: SealedResponse
  try {
    res = await d.request({ meta, key, method: 'GET', path: input.path })
  } catch (e) {
    throw new Error(`The request did not work: ${httpFailure(e).reason}.`)
  }

  const text = scrubKey(res.text, key)
  let data: unknown = text
  let parsed = false
  if (!res.truncated && isJson(res.contentType, text)) {
    try {
      data = JSON.parse(text)
      parsed = true
    } catch {
      data = text
    }
  }
  if (parsed && input.fields?.length) data = pick(data, input.fields)

  // If masking fails, the error goes up and nothing of the reply is shown.
  const masked = await d.mask(data)
  const body = typeof masked === 'string' ? masked : JSON.stringify(masked)
  const notes: string[] = []
  if (res.status >= 300 && res.status < 400) notes.push('redirects are not followed')
  if (res.truncated) notes.push('the reply was larger than 256 KB and was cut')
  if (body.length > MAX_REPLY_CHARS) notes.push(`showing the first ${MAX_REPLY_CHARS} characters; ask again with "fields" to get only what you need`)
  return `HTTP ${res.status}${notes.length ? ` (${notes.join('; ')})` : ''}\n${body.slice(0, MAX_REPLY_CHARS)}`
}
