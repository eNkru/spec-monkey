import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task, TaskStore } from '../taskStore/index.js';
import type { SpecMonkeyConfig } from '../config/index.js';
import type { BackendAdapter } from '../backends/index.js';
import { spawnBackend } from '../backends/index.js';

export interface ReflectOpts {
  taskStore: TaskStore;
  refinementCount: number;
}

export interface ReflectResult {
  task: Task;
  taskStore: TaskStore;
  skipped: boolean;
}

interface ReflectionOutput {
  steps?: string[];
  docs?: string[];
  verification?: Task['verification'];
  implementation_notes?: string;
  learning_note?: string;
}

function cap<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  return arr.slice(arr.length - max);
}

export async function reflect(
  task: Task,
  attemptLogTail: string,
  config: SpecMonkeyConfig,
  backend: BackendAdapter,
  opts: ReflectOpts,
): Promise<ReflectResult> {
  const { reflection } = config;

  // Skip if max refinements reached
  if (opts.refinementCount >= reflection.max_refinements_per_task) {
    return { task, taskStore: opts.taskStore, skipped: true };
  }

  const prompt = buildReflectionPrompt(task, attemptLogTail, opts.taskStore);

  // Use a temp log file in log_dir
  const logDir = config.files.log_dir;
  await mkdir(logDir, { recursive: true });
  const tempLogFile = join(logDir, `reflection-${task.id}-${Date.now()}.json`);
  const mainLogFile = join(logDir, 'reflection.log');

  const commandSpec = backend.buildPlanCommand(prompt, config);

  let reflectionOutput: ReflectionOutput | null = null;

  try {
    await spawnBackend({
      cmd: commandSpec.cmd,
      env: commandSpec.env,
      cwd: commandSpec.cwd,
      attemptLogFile: tempLogFile,
      mainLogFile,
    });

    const raw = await readFile(tempLogFile, 'utf-8');
    reflectionOutput = parseReflectionOutput(raw);
  } catch {
    // Graceful degradation: return original task unchanged
    return { task, taskStore: opts.taskStore, skipped: false };
  } finally {
    try {
      await unlink(tempLogFile);
    } catch {
      // ignore cleanup errors
    }
  }

  if (!reflectionOutput) {
    return { task, taskStore: opts.taskStore, skipped: false };
  }

  // Apply mutable fields, preserving immutable ones
  const refinedTask: Task = {
    ...task,
    // Immutable fields preserved explicitly
    id: task.id,
    title: task.title,
    description: task.description,
    completion: task.completion,
    execution: task.execution,
    // Mutable fields updated from reflection
    steps: reflectionOutput.steps ?? task.steps,
    docs: reflectionOutput.docs ?? task.docs,
    verification: reflectionOutput.verification ?? task.verification,
    implementation_notes: reflectionOutput.implementation_notes ?? task.implementation_notes,
  };

  // Build attempt summary
  const attemptSummary = {
    timestamp: new Date().toISOString(),
    refinement: opts.refinementCount + 1,
    learning_note: reflectionOutput.learning_note ?? '',
  };

  // Append to attempt_history (capped)
  refinedTask.attempt_history = cap(
    [...(task.attempt_history ?? []), attemptSummary],
    reflection.max_attempt_history_entries,
  );

  // Append learning_note to task.learning_notes (capped)
  const learningNote = reflectionOutput.learning_note ?? '';
  if (learningNote) {
    refinedTask.learning_notes = cap(
      [...(task.learning_notes ?? []), learningNote],
      reflection.max_learning_notes,
    );
  }

  // Append learning_note to top-level learning_journal (capped)
  let updatedStore = opts.taskStore;
  if (learningNote) {
    const journalEntry = {
      timestamp: new Date().toISOString(),
      task_id: task.id,
      note: learningNote,
    };
    updatedStore = {
      ...opts.taskStore,
      learning_journal: cap(
        [...(opts.taskStore.learning_journal ?? []), journalEntry],
        reflection.max_project_learning_entries,
      ),
    };
  }

  return { task: refinedTask, taskStore: updatedStore, skipped: false };
}

function buildReflectionPrompt(task: Task, attemptLogTail: string, taskStore: TaskStore): string {
  const recentNotes = (task.learning_notes ?? []).slice(-6).join('\n- ');
  const recentJournal = (taskStore.learning_journal ?? [])
    .slice(-6)
    .map((e) => (typeof e === 'object' && e !== null && 'note' in e ? (e as { note: string }).note : String(e)))
    .join('\n- ');

  return `You are a software development assistant analyzing a failed task attempt.

## Task
ID: ${task.id}
Title: ${task.title}
Description: ${task.description}

## Current Steps
${(task.steps ?? []).map((s, i) => `${i + 1}. ${s}`).join('\n')}

## Current Implementation Notes
${task.implementation_notes ?? '(none)'}

## Recent Learning Notes
${recentNotes ? `- ${recentNotes}` : '(none)'}

## Recent Project Learning Journal
${recentJournal ? `- ${recentJournal}` : '(none)'}

## Attempt Log (tail)
\`\`\`
${attemptLogTail}
\`\`\`

## Instructions
Analyze the attempt log and produce a JSON object with refined guidance for the next attempt.
The JSON must have exactly these fields:
- "steps": array of strings — refined implementation steps
- "docs": array of strings — updated documentation references
- "verification": object — updated verification config (path_patterns, validate_commands, etc.)
- "implementation_notes": string — updated implementation notes
- "learning_note": string — one-line summary of what was learned from this failure

Respond with ONLY the JSON object, no markdown fences, no explanation.`;
}

function parseReflectionOutput(raw: string): ReflectionOutput | null {
  // Try to extract JSON from the output
  const trimmed = raw.trim();

  // Try direct parse first
  try {
    return JSON.parse(trimmed) as ReflectionOutput;
  } catch {
    // Try to find a JSON object in the output
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as ReflectionOutput;
      } catch {
        return null;
      }
    }
    return null;
  }
}
