import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpecMonkeyConfig } from '../config/index.js';
import {
  loadTaskStore,
  saveTaskStore,
  getNextPendingTask,
  markTaskPassed,
  blockTask,
} from '../taskStore/index.js';
import type { TaskStore } from '../taskStore/index.js';
import { getBackend } from '../backends/index.js';
import { spawnBackend } from '../backends/index.js';
import { CircuitBreaker } from '../circuitBreaker/index.js';
import { Heartbeat } from '../heartbeat/index.js';
import { takeSnapshot, diffSnapshots } from '../snapshot/index.js';
import { runGate } from '../gate/index.js';
import { autoCommit, createExperimentCommit, revertCommit, isGitRepo } from '../gitOps/index.js';
import { reflect } from '../reflection/index.js';
import { appendProgress } from '../progress/index.js';
import { writeRuntimeStatus } from '../runtimeStatus/index.js';
import { buildPrompt } from './prompt.js';
import { runExperiment, appendExperimentLog } from './experiment.js';
import type { RuntimeStatus } from '../types.js';

export interface RunTasksOpts {
  dryRun?: boolean;
  backend?: string;
  maxTasks?: number;
  epochs?: number;
}

const ENV_ERROR_PATTERNS = [
  'permission denied',
  'invalid api key',
  'authentication failed',
  'unauthorized',
  'quota exceeded',
];

function countTasks(store: TaskStore): RuntimeStatus['taskCounts'] {
  let pending = 0, completed = 0, blocked = 0, running = 0;
  for (const t of store.tasks) {
    if (t.passes) completed++;
    else if (t.blocked) blocked++;
    else pending++;
  }
  return { pending, completed, blocked, running };
}

async function readAttemptLogTail(logFile: string, lines: number): Promise<string> {
  try {
    const content = await readFile(logFile, 'utf-8');
    const allLines = content.split('\n');
    return allLines.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function scanForEnvError(logContent: string): string | null {
  const lower = logContent.toLowerCase();
  for (const pattern of ENV_ERROR_PATTERNS) {
    if (lower.includes(pattern)) return pattern;
  }
  return null;
}

export async function runTasks(config: SpecMonkeyConfig, opts?: RunTasksOpts): Promise<void> {
  const dryRun = opts?.dryRun ?? false;
  const backendName = opts?.backend ?? config.backend.default;
  const maxTasks = opts?.maxTasks ?? config.run.max_tasks;
  const epochs = opts?.epochs ?? config.run.max_epochs;

  const backend = getBackend(backendName);
  const cb = new CircuitBreaker(config);
  const heartbeat = new Heartbeat(config.run.heartbeat_interval);

  const logDir = config.files.log_dir;
  await mkdir(logDir, { recursive: true });

  let store = await loadTaskStore(config.files.task_json);
  let tasksProcessed = 0;

  // Write initial idle status
  await writeRuntimeStatus(
    {
      status: 'idle',
      lastUpdated: new Date().toISOString(),
      currentTaskId: '',
      currentTaskTitle: '',
      currentAttempt: 0,
      maxAttempts: config.run.max_retries,
      taskCounts: countTasks(store),
      heartbeatElapsedSeconds: 0,
      attemptLog: '',
    },
    config,
  );

  for (let epoch = 0; epoch < epochs; epoch++) {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Reload store from disk to pick up any external changes
      store = await loadTaskStore(config.files.task_json);

      const task = getNextPendingTask(store);

      if (!task) {
        // No more pending tasks — epoch done
        break;
      }

      if (tasksProcessed >= maxTasks) {
        console.log(`[runner] Reached max-tasks limit (${maxTasks}). Stopping.`);
        await writeRuntimeStatus(
          {
            status: 'complete',
            lastUpdated: new Date().toISOString(),
            currentTaskId: '',
            currentTaskTitle: '',
            currentAttempt: 0,
            maxAttempts: config.run.max_retries,
            taskCounts: countTasks(store),
            heartbeatElapsedSeconds: 0,
            attemptLog: '',
          },
          config,
        );
        return;
      }

      // ── Dry-run: print prompt and continue ──────────────────────────────
      if (dryRun) {
        const prompt = buildPrompt(task, config, task.learning_notes, store.learning_journal);
        console.log(`\n[dry-run] Task: ${task.id} — ${task.title}`);
        console.log('─'.repeat(60));
        console.log(prompt);
        console.log('─'.repeat(60));
        tasksProcessed++;
        continue;
      }

      // ── Iterative strategy: delegate to runExperiment ───────────────────
      if (task.execution.strategy === 'iterative') {
        console.log(`[runner] Starting experiment mode for task: ${task.id}`);

        await writeRuntimeStatus(
          {
            status: 'running',
            lastUpdated: new Date().toISOString(),
            currentTaskId: task.id,
            currentTaskTitle: task.title,
            currentAttempt: 0,
            maxAttempts: task.execution.max_iterations,
            taskCounts: countTasks(store),
            heartbeatElapsedSeconds: 0,
            attemptLog: '',
          },
          config,
        );

        const result = await runExperiment(task, config, {
          backend,
          buildPrompt,
          spawnBackend,
          takeSnapshot,
          diffSnapshots,
          runGate,
          createExperimentCommit,
          revertCommit,
          isGitRepo,
          appendExperimentLog,
        });

        if (result.outcome === 'completed') {
          store = markTaskPassed(store, task.id);
          await saveTaskStore(store, config.files.task_json);
          await appendProgress(
            { task_id: task.id, task_name: task.title, status: 'completed', changed_files: 0 },
            config.files.progress,
          );
        } else {
          store = blockTask(store, task.id, result.blockReason ?? 'Experiment failed');
          await saveTaskStore(store, config.files.task_json);
          await appendProgress(
            {
              task_id: task.id,
              task_name: task.title,
              status: 'blocked',
              block_reason: result.blockReason ?? 'Experiment failed',
            },
            config.files.progress,
          );
        }

        await writeRuntimeStatus(
          {
            status: result.outcome === 'completed' ? 'complete' : 'idle',
            lastUpdated: new Date().toISOString(),
            currentTaskId: task.id,
            currentTaskTitle: task.title,
            currentAttempt: result.iterations,
            maxAttempts: task.execution.max_iterations,
            taskCounts: countTasks(store),
            heartbeatElapsedSeconds: 0,
            attemptLog: '',
          },
          config,
        );

        cb.recordAttempt({ madeProgress: result.outcome === 'completed' });
        tasksProcessed++;

        if (cb.isTripped()) {
          console.error(`[runner] Circuit breaker tripped: ${cb.getReason()}`);
          await writeRuntimeStatus(
            {
              status: 'error',
              lastUpdated: new Date().toISOString(),
              currentTaskId: task.id,
              currentTaskTitle: task.title,
              currentAttempt: 0,
              maxAttempts: config.run.max_retries,
              taskCounts: countTasks(store),
              heartbeatElapsedSeconds: 0,
              attemptLog: '',
            },
            config,
          );
          process.exit(1);
        }

        continue;
      }

      // ── Standard task loop ───────────────────────────────────────────────
      const maxRetries = config.run.max_retries;
      let retryCount = 0;
      let refinementCount = 0;
      let currentTask = task;
      let currentStore = store;
      let taskDone = false;

      while (!taskDone) {
        const attemptNum = retryCount + 1;
        const attemptLogFile = join(
          logDir,
          config.files.attempt_log_subdir,
          `${currentTask.id}-attempt-${attemptNum}.log`,
        );
        const mainLogFile = join(logDir, `${currentTask.id}.log`);

        console.log(`[runner] Task ${currentTask.id} — attempt ${attemptNum}/${maxRetries + 1}`);

        // Write running status
        await writeRuntimeStatus(
          {
            status: 'running',
            lastUpdated: new Date().toISOString(),
            currentTaskId: currentTask.id,
            currentTaskTitle: currentTask.title,
            currentAttempt: attemptNum,
            maxAttempts: maxRetries + 1,
            taskCounts: countTasks(currentStore),
            heartbeatElapsedSeconds: 0,
            attemptLog: '',
          },
          config,
        );

        // Take before snapshot
        const watchDirs = config.snapshot.watch_dirs.map((d) =>
          join(config.project.code_dir, d),
        );
        const beforeSnapshot = await takeSnapshot(watchDirs, config);

        // Build prompt
        const prompt = buildPrompt(
          currentTask,
          config,
          currentTask.learning_notes,
          currentStore.learning_journal,
        );
        const cmdSpec = backend.buildCommand(prompt, config);

        // Start heartbeat
        heartbeat.start(currentTask.title);

        // Invoke backend
        const backendResult = await spawnBackend({
          cmd: cmdSpec.cmd,
          env: cmdSpec.env,
          cwd: cmdSpec.cwd,
          attemptLogFile,
          mainLogFile,
        });

        // Stop heartbeat
        heartbeat.stop();

        // Handle SIGINT (exit code 130)
        if (backendResult.exitCode === 130) {
          console.log('[runner] Backend exited with code 130 (SIGINT). Stopping cleanly.');
          await writeRuntimeStatus(
            {
              status: 'idle',
              lastUpdated: new Date().toISOString(),
              currentTaskId: currentTask.id,
              currentTaskTitle: currentTask.title,
              currentAttempt: attemptNum,
              maxAttempts: maxRetries + 1,
              taskCounts: countTasks(currentStore),
              heartbeatElapsedSeconds: heartbeat.getElapsedSeconds(),
              attemptLog: '',
            },
            config,
          );
          process.exit(130);
        }

        // Take after snapshot and diff
        const afterSnapshot = await takeSnapshot(watchDirs, config);
        const changedFiles = diffSnapshots(beforeSnapshot, afterSnapshot);

        // Scan attempt log for env error patterns
        const logTail = await readAttemptLogTail(attemptLogFile, config.reflection.log_tail_lines);
        const envError = scanForEnvError(logTail);
        if (envError) {
          console.error(
            `[runner] Environment error detected ("${envError}"). Stopping without blocking task.`,
          );
          console.error(
            '[runner] Remediation: check API keys, permissions, and quota limits before retrying.',
          );
          await writeRuntimeStatus(
            {
              status: 'error',
              lastUpdated: new Date().toISOString(),
              currentTaskId: currentTask.id,
              currentTaskTitle: currentTask.title,
              currentAttempt: attemptNum,
              maxAttempts: maxRetries + 1,
              taskCounts: countTasks(currentStore),
              heartbeatElapsedSeconds: heartbeat.getElapsedSeconds(),
              attemptLog: logTail,
            },
            config,
          );
          return;
        }

        // Run gate
        await writeRuntimeStatus(
          {
            status: 'validating',
            lastUpdated: new Date().toISOString(),
            currentTaskId: currentTask.id,
            currentTaskTitle: currentTask.title,
            currentAttempt: attemptNum,
            maxAttempts: maxRetries + 1,
            taskCounts: countTasks(currentStore),
            heartbeatElapsedSeconds: heartbeat.getElapsedSeconds(),
            attemptLog: logTail,
          },
          config,
        );

        const gateResult = await runGate(currentTask, changedFiles, config);

        if (gateResult.status === 'passed') {
          // Gate passed — mark completed, commit, append progress
          currentStore = markTaskPassed(currentStore, currentTask.id);
          await saveTaskStore(currentStore, config.files.task_json);

          if (config.git.auto_commit && changedFiles.length > 0) {
            await autoCommit(
              changedFiles,
              config,
              currentTask.id,
              currentTask.title,
              config.project.code_dir,
            );
          }

          await appendProgress(
            {
              task_id: currentTask.id,
              task_name: currentTask.title,
              status: 'completed',
              changed_files: changedFiles.length,
            },
            config.files.progress,
          );

          await writeRuntimeStatus(
            {
              status: 'complete',
              lastUpdated: new Date().toISOString(),
              currentTaskId: currentTask.id,
              currentTaskTitle: currentTask.title,
              currentAttempt: attemptNum,
              maxAttempts: maxRetries + 1,
              taskCounts: countTasks(currentStore),
              heartbeatElapsedSeconds: heartbeat.getElapsedSeconds(),
              attemptLog: logTail,
            },
            config,
          );

          cb.recordAttempt({ madeProgress: true });
          store = currentStore;
          tasksProcessed++;
          taskDone = true;
        } else if (retryCount < maxRetries) {
          // Gate failed — reflect and retry
          await appendProgress(
            {
              task_id: currentTask.id,
              task_name: currentTask.title,
              status: 'retry',
              attempt: attemptNum,
            },
            config.files.progress,
          );

          if (config.reflection.enabled) {
            const reflectResult = await reflect(
              currentTask,
              logTail,
              config,
              backend,
              { taskStore: currentStore, refinementCount },
            );
            currentTask = reflectResult.task;
            currentStore = reflectResult.taskStore;
            if (!reflectResult.skipped) {
              refinementCount++;
            }
          }

          retryCount++;
          cb.recordAttempt({ madeProgress: changedFiles.length > 0 });
        } else {
          // Retries exhausted — block task
          const blockReason = `Gate failed after ${maxRetries + 1} attempts: ${gateResult.errors.join('; ')}`;
          currentStore = blockTask(currentStore, currentTask.id, blockReason);
          await saveTaskStore(currentStore, config.files.task_json);

          await appendProgress(
            {
              task_id: currentTask.id,
              task_name: currentTask.title,
              status: 'blocked',
              block_reason: blockReason,
            },
            config.files.progress,
          );

          await writeRuntimeStatus(
            {
              status: 'idle',
              lastUpdated: new Date().toISOString(),
              currentTaskId: currentTask.id,
              currentTaskTitle: currentTask.title,
              currentAttempt: attemptNum,
              maxAttempts: maxRetries + 1,
              taskCounts: countTasks(currentStore),
              heartbeatElapsedSeconds: heartbeat.getElapsedSeconds(),
              attemptLog: logTail,
            },
            config,
          );

          cb.recordAttempt({ madeProgress: false });
          store = currentStore;
          tasksProcessed++;
          taskDone = true;
        }

        // Check circuit breaker after each attempt
        if (cb.isTripped()) {
          console.error(`[runner] Circuit breaker tripped: ${cb.getReason()}`);
          await writeRuntimeStatus(
            {
              status: 'error',
              lastUpdated: new Date().toISOString(),
              currentTaskId: currentTask.id,
              currentTaskTitle: currentTask.title,
              currentAttempt: attemptNum,
              maxAttempts: maxRetries + 1,
              taskCounts: countTasks(currentStore),
              heartbeatElapsedSeconds: heartbeat.getElapsedSeconds(),
              attemptLog: logTail,
            },
            config,
          );
          process.exit(1);
        }
      }

      // Delay between tasks
      if (config.run.delay_between_tasks > 0 && !taskDone) {
        await new Promise<void>((r) => setTimeout(r, config.run.delay_between_tasks * 1000));
      }
    }

    // After epoch — if more epochs remain, replan would go here (not yet implemented)
    if (epoch < epochs - 1) {
      console.log(`[runner] Epoch ${epoch + 1} complete. No replan implemented yet — stopping.`);
      break;
    }
  }

  // Final status
  store = await loadTaskStore(config.files.task_json);
  await writeRuntimeStatus(
    {
      status: 'complete',
      lastUpdated: new Date().toISOString(),
      currentTaskId: '',
      currentTaskTitle: '',
      currentAttempt: 0,
      maxAttempts: config.run.max_retries,
      taskCounts: countTasks(store),
      heartbeatElapsedSeconds: 0,
      attemptLog: '',
    },
    config,
  );

  console.log(`[runner] Run complete. Processed ${tasksProcessed} task(s).`);
}
