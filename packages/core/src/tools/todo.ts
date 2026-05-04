import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '@agent-os-core/shared';

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

const VALID_STATUSES = new Set<string>(['pending', 'in_progress', 'completed', 'cancelled']);

const TodoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
});

const TodoInputSchema = z.object({
  todos: z.array(TodoItemSchema).optional(),
  merge: z.boolean().default(false),
});

export class TodoStore {
  private items: TodoItem[] = [];

  write(todos: TodoItem[], merge = false): TodoItem[] {
    if (!merge) {
      this.items = this.dedupeById(todos).map((t) => this.validate(t));
    } else {
      const existing = new Map(this.items.map((i) => [i.id, i]));
      for (const t of this.dedupeById(todos)) {
        const validated = this.validate(t);
        const current = existing.get(validated.id);
        if (current) {
          existing.set(validated.id, {
            ...current,
            content: validated.content || current.content,
            status: VALID_STATUSES.has(validated.status) ? validated.status : current.status,
          });
        } else {
          existing.set(validated.id, validated);
          this.items.push(validated);
        }
      }
      const seen = new Set<string>();
      this.items = this.items
        .map((i) => existing.get(i.id) ?? i)
        .filter((i) => { if (seen.has(i.id)) return false; seen.add(i.id); return true; });
    }
    return this.read();
  }

  read(): TodoItem[] {
    return this.items.map((i) => ({ ...i }));
  }

  formatForInjection(): string | null {
    const active = this.items.filter((i) => i.status === 'pending' || i.status === 'in_progress');
    if (active.length === 0) return null;
    const markers: Record<TodoStatus, string> = {
      completed: '[x]', in_progress: '[>]', pending: '[ ]', cancelled: '[~]',
    };
    const lines = ['[Active task list preserved across context compression]'];
    for (const item of active) {
      lines.push(`- ${markers[item.status]} ${item.id}. ${item.content} (${item.status})`);
    }
    return lines.join('\n');
  }

  private validate(item: TodoItem): TodoItem {
    return {
      id: String(item.id).trim() || '?',
      content: String(item.content).trim() || '(no description)',
      status: VALID_STATUSES.has(item.status) ? item.status : 'pending',
    };
  }

  private dedupeById(todos: TodoItem[]): TodoItem[] {
    const lastIdx = new Map<string, number>();
    todos.forEach((t, i) => lastIdx.set(String(t.id).trim() || '?', i));
    return [...lastIdx.values()].sort((a, b) => a - b).map((i) => todos[i]!);
  }
}

export const TODO_TOOL_DEFINITION: ToolDefinition = {
  name: 'todo',
  description:
    'Manage your task list for the current session. Use for complex tasks with 3+ steps. ' +
    'Call with no parameters to read the current list. Provide todos array to write. ' +
    'merge=false (default) replaces the entire list; merge=true updates by id. ' +
    'Each item: {id, content, status: pending|in_progress|completed|cancelled}. ' +
    'List order is priority. Only ONE item in_progress at a time. ' +
    'Mark items completed immediately when done.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Task items to write. Omit to read current list.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique item identifier' },
            content: { type: 'string', description: 'Task description' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'cancelled'],
            },
          },
          required: ['id', 'content', 'status'],
        },
      },
      merge: {
        type: 'boolean',
        description: 'true: update by id; false (default): replace entire list.',
        default: false,
      },
    },
  },
};

export function makeTodoHandler(store: TodoStore) {
  return async (raw: Record<string, unknown>): Promise<ToolResult> => {
    const parsed = TodoInputSchema.safeParse(raw);
    if (!parsed.success) {
      return { toolCallId: '', content: parsed.error.toString(), isError: true };
    }
    const { todos, merge } = parsed.data;
    const items = todos ? store.write(todos as TodoItem[], merge) : store.read();

    const pending = items.filter((i) => i.status === 'pending').length;
    const inProgress = items.filter((i) => i.status === 'in_progress').length;
    const completed = items.filter((i) => i.status === 'completed').length;
    const cancelled = items.filter((i) => i.status === 'cancelled').length;

    return {
      toolCallId: '',
      content: JSON.stringify({
        todos: items,
        summary: { total: items.length, pending, in_progress: inProgress, completed, cancelled },
      }),
      isError: false,
    };
  };
}
