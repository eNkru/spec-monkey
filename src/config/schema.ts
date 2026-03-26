import { z } from 'zod';

export const SpecMonkeyConfigSchema = z.object({
  project: z.object({
    name: z.string().default('Untitled Project'),
    code_dir: z.string().default('.'),
    config_dir: z.string().default('.'),
  }).default({}),

  backend: z.object({
    default: z.enum(['claude', 'codex', 'gemini', 'opencode']).default('claude'),
    claude: z.object({
      skip_permissions: z.boolean().default(true),
      permission_mode: z.enum(['bypassPermissions', 'dontAsk', 'default']).default('bypassPermissions'),
      output_format: z.enum(['text', 'json', 'stream-json']).default('stream-json'),
      model: z.string().default(''),
    }).default({}),
    codex: z.object({
      model: z.string().default(''),
      yolo: z.boolean().default(true),
      full_auto: z.boolean().default(false),
      dangerously_bypass_approvals_and_sandbox: z.boolean().default(true),
    }).default({}),
    gemini: z.object({
      model: z.string().default(''),
      yolo: z.boolean().default(true),
      output_format: z.enum(['text', 'json']).default('text'),
    }).default({}),
    opencode: z.object({
      model: z.string().default(''),
      permissions: z.string().default('{"read":"allow","edit":"allow","bash":"allow","glob":"allow","grep":"allow"}'),
    }).default({}),
  }).default({}),

  run: z.object({
    max_retries: z.number().int().default(3),
    max_tasks: z.number().int().default(999),
    max_epochs: z.number().int().default(1),
    heartbeat_interval: z.number().int().default(20),
    keep_attempt_logs: z.boolean().default(true),
    reset_tasks_on_start: z.boolean().default(false),
    delay_between_tasks: z.number().int().default(2),
  }).default({}),

  files: z.object({
    task_json: z.string().default('task.json'),
    progress: z.string().default('progress.txt'),
    execution_guide: z.string().default('AGENT.md'),
    task_brief: z.string().default('TASK.md'),
    log_dir: z.string().default('logs'),
    attempt_log_subdir: z.string().default('attempts'),
  }).default({}),

  verification: z.object({
    min_changed_files: z.number().int().default(1),
    changed_files_preview_limit: z.number().int().default(20),
    validate_commands: z.array(z.string()).default([]),
    validate_timeout_seconds: z.number().int().default(1800),
    validate_working_directory: z.string().default(''),
    validate_environment: z.record(z.string()).default({}),
  }).default({}),

  reflection: z.object({
    enabled: z.boolean().default(true),
    max_refinements_per_task: z.number().int().default(3),
    prompt_timeout_seconds: z.number().int().default(180),
    log_tail_lines: z.number().int().default(80),
    max_attempt_history_entries: z.number().int().default(12),
    max_learning_notes: z.number().int().default(20),
    max_project_learning_entries: z.number().int().default(50),
    prompt_learning_limit: z.number().int().default(6),
  }).default({}),

  snapshot: z.object({
    watch_dirs: z.array(z.string()).default(['.']),
    ignore_dirs: z.array(z.string()).default(['.git', 'node_modules', 'logs', '__pycache__', 'build', 'venv']),
    ignore_path_globs: z.array(z.string()).default(['build-*', 'cmake-build-*', '*.o', '*.obj', 'task.json', 'progress.txt']),
    include_path_globs: z.array(z.string()).default([]),
  }).default({}),

  circuit_breaker: z.object({
    no_progress_threshold: z.number().int().default(3),
    repeated_error_threshold: z.number().int().default(3),
    rate_limit_cooldown: z.number().int().default(300),
    rate_limit_patterns: z.array(z.string()).default([
      'rate_limit', 'rate limit', 'overloaded', 'too many requests', 'usage cap', 'throttl',
    ]),
  }).default({}),

  git: z.object({
    auto_commit: z.boolean().default(true),
    commit_message_template: z.string().default('spec-monkey: {task_id} - {task_name}'),
  }).default({}),

  detach: z.object({
    tmux_session_prefix: z.string().default('spec-monkey'),
  }).default({}),
});

export type SpecMonkeyConfig = z.infer<typeof SpecMonkeyConfigSchema>;
