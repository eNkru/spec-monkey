import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task } from '../taskStore/index.js';
import type { SpecMonkeyConfig } from '../config/index.js';
import type { BackendAdapter } from '../backends/types.js';
import type { ExperimentLogEntry } from '../types.js';
import type { Snapshot } from '../snapshot/index.js';
import type { RunGateOpts } from '../gate/index.js';
import type { GitCommitResult } from '../gitOps/index.js';
import { spawnBackend as spawnBackendFn } from '../backends/executor.js';
import { takeSnapshot as takeSnapshotFn, diffSnapshots as diffSnapshotsFn } from '../snapshot/index.js';
import { runGate as runGateFn } from '../gate/index.js';
import {
  createExperimentCommit as createExperimentCommitFn,
  revertCommit as revertCommitFn,
  isGitRepo as isGitRepoFn,
} from '../gitOps/index.js';

export interface ExperimentDeps {
  backend: BackendAdapter;
  buildPrompt: (task: Task, config: SpecMonkeyConfig, learningNotes: string[], journalEntries: unknown[]) => string;
  spawnBackend: typeof spawnBackendFn;
  takeSnapshot: typeof takeSnapshotFn;
  diffSnapshots: typeof diffSnapshotsFn;
  runGate: typeof runGateFn;
  createExperimentCommit: typeof createExperimentCommitFn;
  revertCommit: typeof revertCommitFn;
  isGitRepo: typeof isGitRepoFn;
  appendExperimentLog: (entry: ExperimentLogEntry, logDir: string) => Promise<void>;
}

export interface ExperimentResult {
  outcome: 'completed' | 'blocked';
  blockReason?: string;
  bestMetric: number | null;
  iterations: number;
}

export async function appendExperimentLog(entry: ExperimentLogEntry, logDir: string): Promise<void> {
  await mkdir(logDir, { recursive: true });
  const logPath = join(logDir, 'experiments.jsonl');
  await appendFile(logPath, JSON.stringify(entry) + '\n', 'utf8');
}

export async function runExperiment(
  task: Task,
  config: SpecMonkeyConfig,
  deps: ExperimentDeps,
): Promise<ExperimentResult> {
  const codeDir = config.project.code_dir;
  const logDir = config.files.log_dir;

  // 1. Block immediately if not a git repo
  if (!(await deps.isGitRepo(codeDir))) {
    return {
      outcome: 'blocked',
      blockReason: 'Project is not a git repository. Experiment mode requires git.',
      bestMetric: null,
      iterations: 0,
    };
  }

  const watchDirs = config.snapshot.watch_dirs.map((d) => join(codeDir, d));
  const metricName = task.completion.name ?? task.completion.json_path ?? 'metric';

  // 2. Baseline measurement (iteration 0)
  const baselineSnapshot: Snapshot = await deps.takeSnapshot(watchDirs, config);

  const baselineGateOpts: RunGateOpts = {
    enforceChangeRequirements: false,
    bestMetricSoFar: null,
  };
  const baselineGate = await deps.runGate(task, [], config, baselineGateOpts);

  if (baselineGate.status === 'failed' || baselineGate.metric === null || baselineGate.metric.value === null) {
    const reason = baselineGate.errors.length > 0
      ? baselineGate.errors.join('; ')
      : 'No metric value returned';
    return {
      outcome: 'blocked',
      blockReason: `Baseline gate failed: ${reason}`,
      bestMetric: null,
      iterations: 0,
    };
  }

  const baselineValue = baselineGate.metric.value;
  let bestSoFar: number = baselineValue;
  let noImprovementStreak = 0;
  const maxIterations = task.execution.max_iterations;
  const stopAfterNoImprovement = task.execution.stop_after_no_improvement;

  // 3. Iterative loop
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // Build prompt and invoke backend
    const prompt = deps.buildPrompt(task, config, task.learning_notes, []);
    const cmdSpec = deps.backend.buildCommand(prompt, config);
    const attemptLogFile = join(logDir, 'attempts', `${task.id}-exp-${iteration}.log`);
    const mainLogFile = join(logDir, `${task.id}-exp.log`);

    await deps.spawnBackend({
      cmd: cmdSpec.cmd,
      env: cmdSpec.env,
      cwd: cmdSpec.cwd,
      attemptLogFile,
      mainLogFile,
    });

    // Take snapshot after backend run
    const afterSnapshot: Snapshot = await deps.takeSnapshot(watchDirs, config);
    const changedFiles = deps.diffSnapshots(baselineSnapshot, afterSnapshot);

    // Skip gate if no files changed — count as invalid
    if (changedFiles.length === 0) {
      const entry: ExperimentLogEntry = {
        taskId: task.id,
        iteration,
        metricName,
        baselineValue,
        bestBefore: bestSoFar,
        measuredValue: null,
        outcome: 'invalid',
        commitSha: '',
        revertedSha: '',
        timestamp: new Date().toISOString(),
        notes: 'No files changed',
      };
      await deps.appendExperimentLog(entry, logDir);
      continue;
    }

    // Create experiment commit
    const commitResult: GitCommitResult = await deps.createExperimentCommit(
      changedFiles,
      config,
      task.id,
      task.title,
      iteration,
      codeDir,
      task.execution.commit_prefix,
    );

    // Run gate
    const gateOpts: RunGateOpts = {
      enforceChangeRequirements: false,
      bestMetricSoFar: bestSoFar,
      baselineMetric: baselineValue,
    };
    const gate = await deps.runGate(task, changedFiles, config, gateOpts);

    const metricOutcome = gate.metric?.outcome ?? 'invalid';
    const measuredValue = gate.metric?.value ?? null;
    let revertedSha = '';

    if (metricOutcome === 'target_met') {
      // Retain commit, return completed
      const entry: ExperimentLogEntry = {
        taskId: task.id,
        iteration,
        metricName,
        baselineValue,
        bestBefore: bestSoFar,
        measuredValue,
        outcome: 'target_met',
        commitSha: commitResult.commitSha,
        revertedSha: '',
        timestamp: new Date().toISOString(),
      };
      await deps.appendExperimentLog(entry, logDir);
      return {
        outcome: 'completed',
        bestMetric: measuredValue,
        iterations: iteration,
      };
    }

    if (metricOutcome === 'improved') {
      // Update bestSoFar, reset streak, retain commit
      if (measuredValue !== null) {
        bestSoFar = measuredValue;
      }
      noImprovementStreak = 0;
    } else {
      // Possibly revert
      if (metricOutcome === 'regressed' && task.execution.rollback_on_failure) {
        const revertResult = await deps.revertCommit(commitResult.commitSha, codeDir);
        revertedSha = revertResult.commitSha;
      } else if (metricOutcome === 'unchanged' && !task.execution.keep_on_equal) {
        const revertResult = await deps.revertCommit(commitResult.commitSha, codeDir);
        revertedSha = revertResult.commitSha;
      }
      noImprovementStreak++;
    }

    // Append JSONL entry
    const entry: ExperimentLogEntry = {
      taskId: task.id,
      iteration,
      metricName,
      baselineValue,
      bestBefore: gate.metric?.bestBefore ?? bestSoFar,
      measuredValue,
      outcome: metricOutcome,
      commitSha: commitResult.commitSha,
      revertedSha,
      timestamp: new Date().toISOString(),
    };
    await deps.appendExperimentLog(entry, logDir);

    // Check stop conditions
    if (stopAfterNoImprovement !== undefined && noImprovementStreak >= stopAfterNoImprovement) {
      return {
        outcome: 'blocked',
        blockReason: `Stopped after ${noImprovementStreak} consecutive iterations with no improvement`,
        bestMetric: bestSoFar,
        iterations: iteration,
      };
    }
  }

  // 4. Max iterations reached
  return {
    outcome: 'blocked',
    blockReason: 'Max iterations reached',
    bestMetric: bestSoFar,
    iterations: maxIterations,
  };
}
