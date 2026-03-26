import { readFile, writeFile } from 'node:fs/promises';
import { RuntimeError, TaskAuditError } from '../errors.js';
import { TaskSchema, TaskStoreSchema } from './schema.js';
import type { Task, TaskStore } from './schema.js';

export async function loadTaskStore(filePath: string): Promise<TaskStore> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new RuntimeError(
      `Cannot read task store at "${filePath}": ${(err as Error).message}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RuntimeError(
      `Cannot parse task store at "${filePath}": ${(err as Error).message}`
    );
  }

  const result = TaskStoreSchema.safeParse(parsed);
  if (!result.success) {
    throw new RuntimeError(
      `Invalid task store at "${filePath}": ${result.error.message}`
    );
  }

  return result.data;
}

export async function saveTaskStore(store: TaskStore, filePath: string): Promise<void> {
  await writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
}

export function getNextPendingTask(store: TaskStore): Task | null {
  return store.tasks.find((t) => !t.passes && !t.blocked) ?? null;
}

export function markTaskPassed(store: TaskStore, id: string): TaskStore {
  return {
    ...store,
    tasks: store.tasks.map((t) =>
      t.id === id
        ? { ...t, passes: true, completed_at: new Date().toISOString() }
        : t
    ),
  };
}

export function blockTask(store: TaskStore, id: string, reason: string): TaskStore {
  return {
    ...store,
    tasks: store.tasks.map((t) =>
      t.id === id
        ? { ...t, blocked: true, block_reason: reason, blocked_at: new Date().toISOString() }
        : t
    ),
  };
}

export function resetTasks(store: TaskStore, ids?: string[]): TaskStore {
  return {
    ...store,
    tasks: store.tasks.map((t) => {
      const shouldReset = ids ? ids.includes(t.id) : !t.passes;
      if (!shouldReset) return t;
      return { ...t, blocked: false, block_reason: '', blocked_at: undefined };
    }),
  };
}

export function retryBlockedTasks(store: TaskStore): TaskStore {
  return {
    ...store,
    tasks: store.tasks.map((t) =>
      t.blocked
        ? { ...t, blocked: false, block_reason: '', blocked_at: undefined }
        : t
    ),
  };
}

export function auditTask(task: unknown): void {
  const issues: string[] = [];

  if (typeof task !== 'object' || task === null) {
    throw new TaskAuditError('Task must be an object', ['Task is not an object']);
  }

  const t = task as Record<string, unknown>;

  if (!t['id'] || typeof t['id'] !== 'string' || t['id'].trim() === '') {
    issues.push('Missing or empty "id" field');
  }
  if (!t['title'] || typeof t['title'] !== 'string' || t['title'].trim() === '') {
    issues.push('Missing or empty "title" field');
  }
  if (!t['description'] || typeof t['description'] !== 'string' || t['description'].trim() === '') {
    issues.push('Missing or empty "description" field');
  }
  if (!Array.isArray(t['steps']) || t['steps'].length === 0) {
    issues.push('Missing or empty "steps" array');
  }

  // Validate completion contract via zod schema
  const result = TaskSchema.safeParse(task);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.join('.');
      const msg = path ? `${path}: ${issue.message}` : issue.message;
      if (!issues.some((i) => i.includes(path))) {
        issues.push(msg);
      }
    }
  }

  if (issues.length > 0) {
    throw new TaskAuditError(
      `Task audit failed with ${issues.length} issue(s): ${issues.join('; ')}`,
      issues
    );
  }
}
