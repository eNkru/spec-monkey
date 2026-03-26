#!/usr/bin/env node
import { Command } from 'commander';
import { createRequire } from 'node:module';
import { loadConfig } from './config/index.js';
import { ConfigError } from './errors.js';
import { initProject } from './init/index.js';
import { runTasks, planTasks, generateSpec } from './runner/index.js';
import {
  loadTaskStore,
  saveTaskStore,
  getNextPendingTask,
  resetTasks,
  retryBlockedTasks,
  blockTask,
} from './taskStore/index.js';
import { runGate } from './gate/index.js';
import { readRuntimeStatus } from './runtimeStatus/index.js';
import { installSkills, listSkills, recommendSkills, doctorSkills } from './skills/index.js';
import {
  listSessions,
  attachSession,
  stopSession,
  stopAllSessions,
  detachRun,
} from './detach/index.js';
import { startDashboard } from './dashboard/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

process.on('uncaughtException', (err) => {
  console.error(err.stack ?? String(err));
  process.exit(1);
});

process.on('SIGINT', () => {
  process.exit(130);
});

async function requireConfig(configPath?: string) {
  try {
    return await loadConfig(configPath);
  } catch (err) {
    if (
      err instanceof ConfigError &&
      (err.message.includes('not found') || err.message.includes('Could not find'))
    ) {
      console.error(
        'Error: spec-monkey.toml not found. Run `spec-monkey init` to initialize a project.',
      );
      process.exit(1);
    }
    throw err;
  }
}

const program = new Command();

program
  .name('spec-monkey')
  .description('AI-driven development automation')
  .version(pkg.version)
  .option('-c, --config <path>', 'path to spec-monkey.toml');

// ── init ──────────────────────────────────────────────────────────────────────
program
  .command('init <directory>')
  .description('Initialize a new spec-monkey project')
  .option('--use <tool>', 'AI tool to scaffold wrapper files for', 'codex')
  .action(async (directory: string, opts: { use: string }) => {
    try {
      const tool = opts.use as 'claude' | 'codex' | 'gemini' | 'opencode';
      await initProject(directory, tool, { verbose: true });
      console.log(`Initialized spec-monkey project in ${directory}`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── run ───────────────────────────────────────────────────────────────────────
program
  .command('run')
  .description('Run pending tasks autonomously')
  .option('--dry-run', 'print prompts without invoking any backend')
  .option('--backend <name>', 'override the configured backend')
  .option('--max-tasks <n>', 'stop after processing at most N tasks', parseInt)
  .option('--epochs <n>', 'number of plan→execute epochs', parseInt)
  .option('--detach', 'launch in a background tmux session')
  .action(async (opts: { dryRun?: boolean; backend?: string; maxTasks?: number; epochs?: number; detach?: boolean }) => {
    try {
      const globalOpts = program.opts<{ config?: string }>();
      const config = await requireConfig(globalOpts.config);
      if (opts.detach) {
        await detachRun(config);
        return;
      }
      await runTasks(config, {
        dryRun: opts.dryRun,
        backend: opts.backend,
        maxTasks: opts.maxTasks,
        epochs: opts.epochs,
      });
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── plan ──────────────────────────────────────────────────────────────────────
program
  .command('plan')
  .description('Generate task.json from intent or a spec file')
  .option('--intent <text>', 'free-form intent text')
  .option('-f <file>', 'path to a spec or PRD file')
  .option('--backend <name>', 'override the configured backend')
  .action(async (opts: { intent?: string; f?: string; backend?: string }) => {
    try {
      const globalOpts = program.opts<{ config?: string }>();
      const config = await requireConfig(globalOpts.config);
      const { getBackend } = await import('./backends/index.js');
      const backendName = opts.backend ?? config.backend.default;
      const backend = getBackend(backendName);

      if (opts.f) {
        await planTasks({ type: 'file', content: opts.f }, config, backend);
      } else if (opts.intent) {
        await planTasks({ type: 'intent', content: opts.intent }, config, backend);
      } else {
        console.error('Error: provide --intent <text> or -f <file>');
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── spec ──────────────────────────────────────────────────────────────────────
program
  .command('spec')
  .description('Generate a COCASpec document from intent')
  .option('--intent <text>', 'free-form intent text')
  .option('--backend <name>', 'override the configured backend')
  .action(async (opts: { intent?: string; backend?: string }) => {
    try {
      const globalOpts = program.opts<{ config?: string }>();
      const config = await requireConfig(globalOpts.config);
      if (!opts.intent) {
        console.error('Error: --intent <text> is required');
        process.exit(1);
      }
      const { getBackend } = await import('./backends/index.js');
      const backendName = opts.backend ?? config.backend.default;
      const backend = getBackend(backendName);
      await generateSpec(opts.intent, config, backend);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── task ──────────────────────────────────────────────────────────────────────
const taskCmd = program
  .command('task')
  .description('Manage the task queue');

taskCmd
  .command('list')
  .description('List all tasks with their status')
  .action(async () => {
    try {
      const globalOpts = program.opts<{ config?: string }>();
      const config = await requireConfig(globalOpts.config);
      const store = await loadTaskStore(config.files.task_json);
      for (const t of store.tasks) {
        let badge: string;
        if (t.passes) badge = '\x1b[32mCOMPLETED\x1b[0m';
        else if (t.blocked) badge = '\x1b[31mBLOCKED\x1b[0m';
        else badge = '\x1b[33mPENDING\x1b[0m';
        console.log(`[${badge}] ${t.id}: ${t.title}`);
        if (t.blocked && t.block_reason) {
          console.log(`         Reason: ${t.block_reason}`);
        }
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

taskCmd
  .command('next')
  .description('Print the next pending task')
  .action(async () => {
    try {
      const globalOpts = program.opts<{ config?: string }>();
      const config = await requireConfig(globalOpts.config);
      const store = await loadTaskStore(config.files.task_json);
      const task = getNextPendingTask(store);
      if (!task) {
        console.log('No pending tasks.');
        return;
      }
      console.log(`ID:          ${task.id}`);
      console.log(`Title:       ${task.title}`);
      console.log(`Description: ${task.description}`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

taskCmd
  .command('reset')
  .description('Reset tasks to pending state')
  .option('--ids <ids>', 'comma-separated list of task IDs to reset')
  .action(async (opts: { ids?: string }) => {
    try {
      const globalOpts = program.opts<{ config?: string }>();
      const config = await requireConfig(globalOpts.config);
      let store = await loadTaskStore(config.files.task_json);
      const ids = opts.ids ? opts.ids.split(',').map((s) => s.trim()) : undefined;
      store = resetTasks(store, ids);
      await saveTaskStore(store, config.files.task_json);
      console.log(ids ? `Reset tasks: ${ids.join(', ')}` : 'Reset all non-completed tasks.');
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

taskCmd
  .command('retry')
  .description('Retry all blocked tasks')
  .action(async () => {
    try {
      const globalOpts = program.opts<{ config?: string }>();
      const config = await requireConfig(globalOpts.config);
      let store = await loadTaskStore(config.files.task_json);
      store = retryBlockedTasks(store);
      await saveTaskStore(store, config.files.task_json);
      console.log('Blocked tasks reset to pending.');
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

taskCmd
  .command('block <id> <reason>')
  .description('Block a task with a reason')
  .action(async (id: string, reason: string) => {
    try {
      const globalOpts = program.opts<{ config?: string }>();
      const config = await requireConfig(globalOpts.config);
      let store = await loadTaskStore(config.files.task_json);
      store = blockTask(store, id, reason);
      await saveTaskStore(store, config.files.task_json);
      console.log(`Task ${id} blocked: ${reason}`);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── verify ────────────────────────────────────────────────────────────────────
program
  .command('verify <task-id>')
  .description('Run the verification gate for a specific task')
  .action(async (taskId: string) => {
    try {
      const globalOpts = program.opts<{ config?: string }>();
      const config = await requireConfig(globalOpts.config);
      const store = await loadTaskStore(config.files.task_json);
      const task = store.tasks.find((t) => t.id === taskId);
      if (!task) {
        console.error(`Error: task '${taskId}' not found`);
        process.exit(1);
      }
      const result = await runGate(task, [], config);
      console.log(`Gate result: ${result.status.toUpperCase()}`);
      console.log(`Task:        ${task.id} — ${task.title}`);
      if (result.checks.length > 0) {
        console.log('Checks:');
        for (const check of result.checks) {
          console.log(`  [${check.ok ? '✓' : '✗'}] ${check.name}: ${check.details}`);
        }
      }
      if (result.errors.length > 0) {
        console.log('Errors:');
        for (const e of result.errors) {
          console.log(`  - ${e}`);
        }
      }
      if (result.status !== 'passed') process.exit(1);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── status ────────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show task queue summary')
  .option('--json', 'output as JSON')
  .action(async (opts: { json?: boolean }) => {
    try {
      const globalOpts = program.opts<{ config?: string }>();
      const config = await requireConfig(globalOpts.config);

      let pending = 0, completed = 0, blocked = 0;
      let store;
      try {
        store = await loadTaskStore(config.files.task_json);
        for (const t of store.tasks) {
          if (t.passes) completed++;
          else if (t.blocked) blocked++;
          else pending++;
        }
      } catch {
        if (opts.json) {
          console.log(JSON.stringify({ message: 'Project has not been planned yet.' }));
        } else {
          console.log('Project has not been planned yet. Run `spec-monkey plan` first.');
        }
        return;
      }

      const runtimeStatus = await readRuntimeStatus(config);

      if (opts.json) {
        const out: Record<string, unknown> = {
          pending,
          completed,
          blocked,
          running: 0,
        };
        if (runtimeStatus) {
          out['last_updated'] = runtimeStatus.lastUpdated;
          out['current_task_id'] = runtimeStatus.currentTaskId;
        }
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(`Pending:   ${pending}`);
        console.log(`Completed: ${completed}`);
        console.log(`Blocked:   ${blocked}`);
        if (runtimeStatus) {
          console.log(`Last updated:    ${runtimeStatus.lastUpdated}`);
          console.log(`Current task ID: ${runtimeStatus.currentTaskId || '(none)'}`);
        }
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── install-skills ────────────────────────────────────────────────────────────
program
  .command('install-skills')
  .description('Install project skills into the tool-native path')
  .action(async () => {
    try {
      const globalOpts = program.opts<{ config?: string }>();
      const config = await requireConfig(globalOpts.config);
      await installSkills(config);
      console.log('Skills installed successfully.');
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── skills ────────────────────────────────────────────────────────────────────
const skillsCmd = program
  .command('skills')
  .description('Manage agent skills');

skillsCmd
  .command('list')
  .description('List all skills in .skills/')
  .action(async () => {
    try {
      const skills = await listSkills(process.cwd());
      if (skills.length === 0) {
        console.log('No skills found in .skills/');
        return;
      }
      for (const s of skills) {
        console.log(`${s.name}${s.description ? ` — ${s.description}` : ''}`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

skillsCmd
  .command('recommend <query>')
  .description('Recommend skills matching a query')
  .option('--limit <n>', 'maximum number of results', parseInt, 5)
  .action(async (query: string, opts: { limit: number }) => {
    try {
      const results = await recommendSkills(query, opts.limit, process.cwd());
      if (results.length === 0) {
        console.log('No matching skills found.');
        return;
      }
      for (const s of results) {
        console.log(`${s.name}${s.description ? ` — ${s.description}` : ''}`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

skillsCmd
  .command('doctor')
  .description('Diagnose skill configuration issues')
  .action(async () => {
    try {
      const globalOpts = program.opts<{ config?: string }>();
      const config = await requireConfig(globalOpts.config);
      const issues = await doctorSkills(config);
      if (issues.length === 0) {
        console.log('No issues found.');
        return;
      }
      for (const issue of issues) {
        const prefix = issue.severity === 'error' ? '✗ ERROR' : '⚠ WARNING';
        console.log(`${prefix}: ${issue.message}`);
      }
      const hasErrors = issues.some((i) => i.severity === 'error');
      if (hasErrors) process.exit(1);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── list ──────────────────────────────────────────────────────────────────────
program
  .command('list')
  .description('List running tmux sessions')
  .action(async () => {
    try {
      const globalOpts = program.opts<{ config?: string }>();
      const config = await requireConfig(globalOpts.config);
      const sessions = await listSessions(config);
      if (sessions.length === 0) {
        console.log('No active sessions.');
        return;
      }
      for (const s of sessions) {
        console.log(`${s.name}  started: ${s.startTime}`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── attach ────────────────────────────────────────────────────────────────────
program
  .command('attach <session>')
  .description('Attach to a running tmux session')
  .action(async (session: string) => {
    try {
      await attachSession(session);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── stop ──────────────────────────────────────────────────────────────────────
program
  .command('stop [session]')
  .description('Stop a tmux session (or all sessions with --all)')
  .option('--all', 'stop all spec-monkey sessions')
  .action(async (session: string | undefined, opts: { all?: boolean }) => {
    try {
      if (opts.all) {
        const globalOpts = program.opts<{ config?: string }>();
        const config = await requireConfig(globalOpts.config);
        await stopAllSessions(config);
        console.log('All sessions stopped.');
      } else if (session) {
        await stopSession(session);
        console.log(`Session '${session}' stopped.`);
      } else {
        console.error('Error: provide a session name or use --all');
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── web ───────────────────────────────────────────────────────────────────────
program
  .command('web')
  .description('Start the web dashboard')
  .option('--port <n>', 'port to listen on', parseInt, 8080)
  .option('--host <host>', 'host to bind to', '127.0.0.1')
  .action(async (opts: { port: number; host: string }) => {
    try {
      const globalOpts = program.opts<{ config?: string }>();
      const config = await requireConfig(globalOpts.config);
      await startDashboard(config, { port: opts.port, host: opts.host });
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  });

// ── Unknown commands ──────────────────────────────────────────────────────────
program.on('command:*', (operands: string[]) => {
  console.error(`Error: unknown command '${operands[0]}'. Run 'spec-monkey --help' for usage.`);
  process.exit(1);
});

// ── No subcommand: print help and exit 0 ─────────────────────────────────────
if (process.argv.length <= 2) {
  program.help();
}

program.parse(process.argv);
