// Which due task the runner starts first. Plain due_at order let six cold emails go ahead of a reply in a
// live conversation (1 Nov: Dr Surya's approved Q4 waited behind them, then Claude hit its limit and it never
// went). A send in an existing conversation goes first, then other sends, then everything else, each by due_at.

const LIVE = /^SEND APPROVED #\d+ \((?:linkedin-dm|whatsapp|linkedin-comment|reddit-reply|indiehackers)\b/i
const SEND = /^SEND APPROVED #\d+/i

export const taskRank = (title: string): number => (LIVE.test(title) ? 0 : SEND.test(title) ? 1 : 2)

export const pickNext = <T extends { title: string; due_at: string | null }>(tasks: T[]): T | undefined =>
  [...tasks].sort(
    (a, b) => taskRank(a.title) - taskRank(b.title) || (a.due_at ?? '').localeCompare(b.due_at ?? ''),
  )[0]
