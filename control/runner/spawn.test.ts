import { describe, expect, test } from 'bun:test'
import type { Task } from '../lib/db'
import { buildArgs, buildPrompt, capsFor, childEnv, pickServers, RULES, SEND_RULES } from './spawn'

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: 5, title: 'Find 10 founders hiring engineers', venture: '0unveiled', owner: 'claude', kind: 'task',
    status: 'todo', due_at: null, recur: null, prompt: 'Research and draft notes.', cwd: null,
    source: 'notes/outreach-playbook.md', notes: null, auto: true, last_pinged_at: null, parent_id: null,
    created_at: '', updated_at: '', deleted_at: null, ...over,
  }) as Task

const flag = (args: string[], name: string): string | undefined => args[args.indexOf(name) + 1]

describe('capsFor', () => {
  test('turns and $ per kind', () => {
    expect(capsFor(task())).toMatchObject({ kind: 'task', maxTurns: 60, model: 'sonnet' })
    expect(capsFor(task({ kind: 'check' }))).toMatchObject({ kind: 'check', maxTurns: 25 })
    expect(capsFor(task({ title: 'SEND APPROVED #38 (linkedin-connect to X)' }))).toMatchObject({ kind: 'send', maxTurns: 15 })
  })
  test('opus only when the prompt asks for it', () => {
    expect(capsFor(task({ prompt: 'Use Opus for this design doc.' })).model).toBe('opus')
    expect(capsFor(task({ title: 'opus in the title only', prompt: 'x' })).model).toBe('sonnet')
  })
})

describe('buildArgs', () => {
  test('every spawn carries model, turns, $ cap and a strict MCP config', () => {
    const args = buildArgs(task({ kind: 'check' }), '/state/runner-mcp.json')
    expect(flag(args, '--model')).toBe('sonnet')
    expect(flag(args, '--max-turns')).toBe('25')
    expect(Number(flag(args, '--max-budget-usd'))).toBeGreaterThan(0)
    expect(args).toContain('--strict-mcp-config')
    expect(flag(args, '--mcp-config')).toBe('/state/runner-mcp.json')
    expect(args).toContain('--chrome')
    expect(JSON.parse(flag(args, '--settings') ?? '{}').env.CLAUDE_CODE_COORDINATOR_MODE).toBe('0')
    expect(flag(args, '--append-system-prompt')).toBe(RULES)
  })
  test('an approved send gets the no-reads rules and no plan file', () => {
    const t = task({ title: 'SEND APPROVED #38 (linkedin-connect)', kind: 'send' })
    const args = buildArgs(t, '/x.json')
    const rules = flag(args, '--append-system-prompt') ?? ''
    expect(rules).toBe(SEND_RULES)
    expect(rules).not.toMatch(/Read and follow|outreach-playbook/)
    expect(buildPrompt(t)).not.toContain('Plan file')
    expect(buildPrompt(task())).toContain('Plan file: notes/outreach-playbook.md')
  })
  test('both rule sets ask for the AOS_RESULT line', () => {
    expect(RULES).toContain('AOS_RESULT {"status"')
    expect(SEND_RULES).toContain('AOS_RESULT {"status"')
  })
})

describe('childEnv and pickServers', () => {
  test('coordinator mode is dropped from the child env', () => {
    const env = childEnv({ CLAUDE_CODE_COORDINATOR_MODE: '1', PATH: '/bin' })
    expect(env.CLAUDE_CODE_COORDINATOR_MODE).toBeUndefined()
    expect(env.PATH).toBe('/bin')
  })
  test('only aos and pilot-browser are kept', () => {
    const picked = pickServers({ mcpServers: { aos: { type: 'http' }, 'pilot-browser': { type: 'stdio' }, desk: {}, blender: {} } })
    expect(Object.keys(picked).sort()).toEqual(['aos', 'pilot-browser'])
    expect(() => pickServers({ mcpServers: { desk: {} } })).toThrow()
  })
})
