// Adds a harmless auto task that exercises the runner end to end.
import { addTask } from '../lib/tasks'

const t = await addTask({
  title: 'Runner smoke test (safe): agenda + browser read',
  venture: 'general',
  owner: 'claude',
  kind: 'check',
  auto: true,
  due_at: new Date().toISOString(),
  prompt:
    'Smoke test. 1) Call the aos agenda tool and count overdue + today items. 2) Open a new Chrome tab to https://example.com, ' +
    'read the page heading, close the tab. 3) Call task_done for this task with a note like "smoke ok: N items, heading X". Do nothing else.',
})
console.log(`#${t.id}`)
