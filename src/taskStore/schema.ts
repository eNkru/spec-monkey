import { z } from 'zod';

export const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  steps: z.array(z.string()).min(1),
  completion: z.object({
    kind: z.enum(['boolean', 'numeric']).default('boolean'),
    name: z.string().optional(),
    source: z.string().optional(),
    json_path: z.string().optional(),
    direction: z.enum(['higher_is_better', 'lower_is_better']).optional(),
    min_improvement: z.number().optional(),
    unchanged_tolerance: z.number().optional(),
    target: z.number().optional(),
    success_when: z.string().optional(),
  }).default({}),
  execution: z.object({
    strategy: z.enum(['standard', 'iterative']).default('standard'),
    max_iterations: z.number().int().default(1),
    rollback_on_failure: z.boolean().default(true),
    keep_on_equal: z.boolean().default(false),
    stop_after_no_improvement: z.number().int().optional(),
    commit_prefix: z.string().default('experiment'),
  }).default({}),
  verification: z.object({
    path_patterns: z.array(z.string()).optional(),
    validate_commands: z.array(z.string()).optional(),
    validate_timeout_seconds: z.number().int().optional(),
    validate_working_directory: z.string().optional(),
    validate_environment: z.record(z.string()).optional(),
  }).optional(),
  docs: z.array(z.string()).optional(),
  implementation_notes: z.string().optional(),
  passes: z.boolean().default(false),
  blocked: z.boolean().default(false),
  block_reason: z.string().default(''),
  blocked_at: z.string().optional(),
  completed_at: z.string().optional(),
  attempt_history: z.array(z.unknown()).default([]),
  learning_notes: z.array(z.string()).default([]),
});

export const TaskStoreSchema = z.object({
  tasks: z.array(TaskSchema),
  learning_journal: z.array(z.unknown()).default([]),
  planning_source: z.string().optional(),
});

export type Task = z.infer<typeof TaskSchema>;
export type TaskStore = z.infer<typeof TaskStoreSchema>;
