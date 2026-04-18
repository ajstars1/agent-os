import type { Logger } from '@agent-os-core/shared';

export interface Task {
  id: string;
  title: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  subtasks: SubTask[];
  createdAt: number;
}

export interface SubTask {
  id: string;
  title: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
}

export class TaskRegistry {
  private tasks: Map<string, Task> = new Map();

  createTask(title: string, subtasks: string[]): Task {
    const id = crypto.randomUUID();
    const task: Task = {
      id,
      title,
      status: 'pending',
      subtasks: subtasks.map(t => ({ id: crypto.randomUUID(), title: t, status: 'pending' })),
      createdAt: Date.now()
    };
    this.tasks.set(id, task);
    return task;
  }

  updateTaskStatus(id: string, status: Task['status']): void {
    const task = this.tasks.get(id);
    if (task) task.status = status;
  }

  updateSubtaskStatus(taskId: string, subtaskId: string, status: SubTask['status']): void {
    const task = this.tasks.get(taskId);
    if (task) {
      const subtask = task.subtasks.find(s => s.id === subtaskId);
      if (subtask) subtask.status = status;
    }
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }
}

export class PlanningManager {
  private mode: 'plan' | 'work' = 'work';
  private currentPlan: Task | null = null;

  constructor(
    private readonly taskRegistry: TaskRegistry,
    private readonly logger: Logger
  ) {}

  enterPlanMode(title: string, subtasks: string[]): Task {
    this.mode = 'plan';
    this.currentPlan = this.taskRegistry.createTask(title, subtasks);
    this.logger.info({ taskId: this.currentPlan.id }, 'Entered Planning Mode');
    return this.currentPlan;
  }

  approvePlan(): void {
    this.mode = 'work';
    if (this.currentPlan) {
      this.taskRegistry.updateTaskStatus(this.currentPlan.id, 'in-progress');
    }
    this.logger.info('Plan approved, entering Work Mode');
  }

  rejectPlan(): void {
    this.mode = 'work';
    if (this.currentPlan) {
      this.taskRegistry.updateTaskStatus(this.currentPlan.id, 'failed');
    }
    this.currentPlan = null;
    this.logger.info('Plan rejected, returning to Work Mode');
  }

  getMode(): 'plan' | 'work' {
    return this.mode;
  }

  getCurrentPlan(): Task | null {
    return this.currentPlan;
  }
}
