import { loadTasks } from '../../../lib/dash'
import { safeLoad } from '../_ui/load'
import { LoadError, PageHead } from '../_ui/page-head'
import { parseFilters } from '../_ui/filters'
import { TaskBrowser } from '../_ui/task-browser'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'aos · tasks' }

const TasksPage = async ({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => {
  const [sp, res] = await Promise.all([searchParams, safeLoad(() => loadTasks())])
  if (!res.ok) return <LoadError message={res.message} />
  return (
    <main>
      <PageHead now={res.data.now} title="Tasks" />
      <TaskBrowser tasks={res.data.tasks} now={res.data.now} initial={parseFilters(sp)} />
    </main>
  )
}

export default TasksPage
