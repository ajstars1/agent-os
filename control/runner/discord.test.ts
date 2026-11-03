import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fallbackLog, notify, splitMessage } from '../lib/discord'

const HOOK = 'https://discord.com/api/webhooks/123/SECRET-TOKEN'
const realFetch = globalThis.fetch
let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aos-notify-'))
  process.env.AOS_STATE_DIR = dir
  process.env.DISCORD_WEBHOOK_URL = HOOK
})

afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.AOS_STATE_DIR
  delete process.env.DISCORD_WEBHOOK_URL
  rmSync(dir, { recursive: true, force: true })
})

const stubFetch = (impl: () => Promise<Response>): void => {
  globalThis.fetch = Object.assign(impl, { preconnect: () => undefined }) as typeof fetch
}

describe('notify', () => {
  test('returns false without a webhook and writes nothing', async () => {
    delete process.env.DISCORD_WEBHOOK_URL
    expect(await notify('hi')).toBe(false)
    expect(existsSync(fallbackLog())).toBe(false)
  })

  test('posts and returns true', async () => {
    stubFetch(async () => new Response(null, { status: 204 }))
    expect(await notify('hi')).toBe(true)
    expect(existsSync(fallbackLog())).toBe(false)
  })

  test('a throwing fetch does not throw, and the fallback log has the message but not the URL', async () => {
    stubFetch(async () => {
      throw new Error(`Unable to connect to ${HOOK}`)
    })
    expect(await notify('runner error: boom')).toBe(false)
    const log = readFileSync(fallbackLog(), 'utf8')
    expect(log).toContain('runner error: boom')
    expect(log).not.toContain('SECRET-TOKEN')
    expect(log).not.toContain('webhooks')
  })

  test('an HTTP error goes to the fallback log with the status only', async () => {
    stubFetch(async () => new Response(`bad hook ${HOOK}`, { status: 404 }))
    expect(await notify('hello')).toBe(false)
    const log = readFileSync(fallbackLog(), 'utf8')
    expect(log).toContain('discord HTTP 404')
    expect(log).toContain('hello')
    expect(log).not.toContain('SECRET-TOKEN')
  })
})

describe('splitMessage', () => {
  test('splits on newlines under the limit', () => {
    const parts = splitMessage('aaaa\nbbbb\ncccc', 10)
    expect(parts.every((p) => p.length <= 10)).toBe(true)
    expect(parts.join('')).toBe('aaaa\nbbbb\ncccc')
  })
})
