export type TaskStatus = 'todo' | 'doing' | 'waiting_approval' | 'done' | 'skipped'
export type Owner = 'me' | 'assistant'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'sent' | 'failed'
export type GoalStatus = 'active' | 'met' | 'dropped'

export interface Task {
  id: number
  title: string
  area: string
  owner: Owner
  status: TaskStatus
  due_at: string | null
  recur: string | null
  notes: string | null
  goal_id: number | null
  parent_id: number | null
  created_at: string
  updated_at: string
}

export interface Approval {
  id: number
  task_id: number | null
  channel: string
  recipient: string | null
  draft: string
  status: ApprovalStatus
  result: string | null
  send_after: string | null
  created_at: string
  decided_at: string | null
}

export interface Goal {
  id: number
  title: string
  area: string
  unit: string | null
  target: number
  current: number
  due_at: string | null
  status: GoalStatus
  created_at: string
}

export interface CalendarEvent {
  id: number
  title: string
  area: string
  starts_at: string
  ends_at: string | null
  location: string | null
  notes: string | null
}

export interface ActivityRow {
  id: number
  at: string
  area: string
  channel: string
  account: string
  action: string
  result: string | null
  task_id: number | null
}

// Columns sent to clients. user_id and deleted_at stay in the database.
export const TASK_COLS = 'id,title,area,owner,status,due_at,recur,notes,goal_id,parent_id,created_at,updated_at'
export const APPROVAL_COLS = 'id,task_id,channel,recipient,draft,status,result,send_after,created_at,decided_at'
export const GOAL_COLS = 'id,title,area,unit,target,current,due_at,status,created_at'
export const EVENT_COLS = 'id,title,area,starts_at,ends_at,location,notes'
export const ACTIVITY_COLS = 'id,at,area,channel,account,action,result,task_id'
