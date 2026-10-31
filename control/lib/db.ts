import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type TaskStatus = 'todo' | 'doing' | 'waiting_approval' | 'done' | 'skipped'
export type Owner = 'ayush' | 'claude' | 'shiven' | 'mayank' | 'family'
export type Kind = 'task' | 'send' | 'post' | 'check' | 'meeting'

export interface Task {
  id: number
  title: string
  venture: string
  owner: Owner
  kind: Kind
  status: TaskStatus
  due_at: string | null
  recur: string | null
  prompt: string | null
  cwd: string | null
  source: string | null
  notes: string | null
  auto: boolean
  last_pinged_at: string | null
  parent_id: number | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface Approval {
  id: number
  task_id: number | null
  channel: string
  recipient: string | null
  draft: string
  status: 'pending' | 'approved' | 'rejected' | 'sent' | 'failed'
  result: string | null
  created_at: string
  decided_at: string | null
}

export interface CalendarEvent {
  id: number
  title: string
  venture: string
  starts_at: string
  ends_at: string | null
  location: string | null
  notes: string | null
}

export interface Run {
  id: number
  task_id: number | null
  trigger: string
  status: 'running' | 'ok' | 'error' | 'timeout'
  summary: string | null
  session_id: string | null
  cost_usd: number | null
  started_at: string
  finished_at: string | null
}

let client: SupabaseClient | null = null

// Server-only: uses the service role key. Never import from client components.
export const db = (): SupabaseClient => {
  if (client) return client
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  client = createClient(url, key, { auth: { persistSession: false } })
  return client
}
