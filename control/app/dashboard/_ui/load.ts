import { DashboardDataError } from '../../../lib/dash'

export type Loaded<T> = { ok: true; data: T } | { ok: false; message: string }

export const safeLoad = async <T>(fn: () => Promise<T>): Promise<Loaded<T>> => {
  try {
    return { ok: true, data: await fn() }
  } catch (err) {
    return { ok: false, message: err instanceof DashboardDataError ? `Could not load ${err.query}.` : 'Could not load the data.' }
  }
}
