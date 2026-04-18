import { z } from 'zod';
import type { ToolResult, Logger } from '@agent-os-core/shared';
import type { ToolRegistry } from './registry.js';
import type { PlanningManager, TaskRegistry } from '../planning.js';

const TaskCreateSchema = z.object({
  subject: z.string().describe('A brief title for the task'),
  description: z.string().describe('Detailed description of what needs to be done'),
  subtasks: z.array(z.string()).optional().describe('Initial list of subtasks'),
});

const TaskUpdateSchema = z.object({
  taskId: z.string().describe('The full or partial ID of the task'),
  status: z.enum(['pending', 'in-progress', 'completed', 'failed']).optional(),
  title: z.string().optional(),
});

const SubtaskUpdateSchema = z.object({
  taskId: z.string().describe('The ID of the parent task'),
  subtaskId: z.string().describe('The full or partial ID of the subtask'),
  status: z.enum(['pending', 'in-progress', 'completed', 'failed']),
});

export function registerTaskTools(
  registry: ToolRegistry,
  planningManager: PlanningManager,
  taskRegistry: TaskRegistry,
  logger: Logger,
): void {
  registry.register(
    {
      name: 'task_create',
      description: 'Create a new task and enter Planning Mode. This starts a workflow requiring user approval.',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          description: { type: 'string' },
          subtasks: { type: 'array', items: { type: 'string' } },
        },
        required: ['subject', 'description'],
      },
    },
    async (input) => {
      const parsed = TaskCreateSchema.safeParse(input);
      if (!parsed.success) return { toolCallId: '', content: parsed.error.toString(), isError: true };
      
      const { subject, subtasks } = parsed.data;
      const task = planningManager.enterPlanMode(subject, subtasks || ['Implementation', 'Verification']);
      
      return {
        toolCallId: '',
        content: `Task created and entered Planning Mode: ${task.title}\nID: ${task.id}\nSubtasks:\n${task.subtasks.map(s => `  - ${s.title} (${s.id.slice(0, 4)})`).join('\n')}`,
        isError: false,
      };
    }
  );

  registry.register(
    {
      name: 'task_update',
      description: 'Update the status or title of a task.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          status: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['taskId'],
      },
    },
    async (input) => {
      const parsed = TaskUpdateSchema.safeParse(input);
      if (!parsed.success) return { toolCallId: '', content: parsed.error.toString(), isError: true };
      
      const { taskId, status } = parsed.data;
      const task = taskRegistry.getAllTasks().find(t => t.id.startsWith(taskId));
      if (!task) return { toolCallId: '', content: `Task ${taskId} not found.`, isError: true };
      
      if (status) taskRegistry.updateTaskStatus(task.id, status);
      
      return {
        toolCallId: '',
        content: `Updated task ${task.id.slice(0, 4)}: ${status || 'no status change'}`,
        isError: false,
      };
    }
  );

  registry.register(
    {
      name: 'subtask_update',
      description: 'Update the status of a specific subtask.',
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          subtaskId: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['taskId', 'subtaskId', 'status'],
      },
    },
    async (input) => {
      const parsed = SubtaskUpdateSchema.safeParse(input);
      if (!parsed.success) return { toolCallId: '', content: parsed.error.toString(), isError: true };
      
      const { taskId, subtaskId, status } = parsed.data;
      const task = taskRegistry.getAllTasks().find(t => t.id.startsWith(taskId));
      if (!task) return { toolCallId: '', content: `Task ${taskId} not found.`, isError: true };
      
      const sub = task.subtasks.find(s => s.id.startsWith(subtaskId));
      if (!sub) return { toolCallId: '', content: `Subtask ${subtaskId} not found in task ${taskId}.`, isError: true };
      
      taskRegistry.updateSubtaskStatus(task.id, sub.id, status);
      
      return {
        toolCallId: '',
        content: `Subtask "${sub.title}" updated to ${status}.`,
        isError: false,
      };
    }
  );
}
